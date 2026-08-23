import type { Page, Response } from "playwright";

export interface AvailabilityRequestContext {
  readonly restaurantIds: readonly string[];
  readonly date?: string;
  readonly time?: string;
  readonly partySize?: number;
}

export interface AvailabilityObservation {
  readonly requestContext: AvailabilityRequestContext;
  readonly payload: unknown;
}

export type AvailabilityObservationOutcome =
  | { readonly kind: "availability"; readonly observation: AvailabilityObservation }
  | { readonly kind: "http-failure"; readonly status: number }
  | { readonly kind: "malformed" }
  | { readonly kind: "not-observed" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function collectCandidateRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectCandidateRecords(entry, depth + 1));
  }
  if (!isRecord(value)) return [];

  const records = [value];
  for (const key of ["variables", "input", "query", "search", "availabilityRequest"]) {
    const nested = value[key];
    if (typeof nested === "string") {
      records.push(...collectCandidateRecords(parseJson(nested), depth + 1));
    } else {
      records.push(...collectCandidateRecords(nested, depth + 1));
    }
  }
  return records;
}

function firstValue(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): unknown {
  for (const record of records) {
    for (const key of keys) {
      if (record[key] !== undefined) return record[key];
    }
  }
  return undefined;
}

function normalizeRestaurantIds(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" && value.includes(",")
      ? value.split(",")
      : value === undefined
        ? []
        : [value];
  return values
    .filter((entry): entry is string | number =>
      ["string", "number"].includes(typeof entry),
    )
    .map(String)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function extractAvailabilityRequestContext(
  requestUrl: string,
  postData: unknown,
): AvailabilityRequestContext {
  const url = new URL(requestUrl);
  const urlVariables = url.searchParams.get("variables");
  const directUrlRecord: Record<string, unknown> = Object.fromEntries(
    url.searchParams.entries(),
  );
  const records = [
    ...collectCandidateRecords(postData),
    ...collectCandidateRecords(urlVariables ? parseJson(urlVariables) : undefined),
    directUrlRecord,
  ];

  const restaurantIds = normalizeRestaurantIds(
    firstValue(records, ["restaurantIds", "restaurant_ids", "restaurantId", "rid"]),
  );
  const dateTime = firstValue(records, ["dateTime", "datetime"]);
  const dateValue = firstValue(records, ["date", "reservationDate"]);
  const timeValue = firstValue(records, ["time", "reservationTime"]);
  const dateTimeText = typeof dateTime === "string" ? dateTime : undefined;
  const date =
    typeof dateValue === "string"
      ? dateValue.slice(0, 10)
      : dateTimeText?.slice(0, 10);
  const time =
    typeof timeValue === "string"
      ? timeValue.slice(0, 5)
      : dateTimeText?.match(/T(\d{2}:\d{2})/)?.[1];
  const partySize = normalizePositiveInteger(
    firstValue(records, ["partySize", "party_size", "covers"]),
  );

  return {
    restaurantIds,
    ...(date === undefined ? {} : { date }),
    ...(time === undefined ? {} : { time }),
    ...(partySize === undefined ? {} : { partySize }),
  };
}

function isAvailabilityResponseUrl(url: string): boolean {
  return /RestaurantsAvailability|[?&]opname=RestaurantsAvailability(?:&|$)|\/availability(?:[/?#]|$)/i.test(
    url,
  );
}

async function readPostData(response: Response): Promise<unknown> {
  try {
    return response.request().postDataJSON();
  } catch {
    const raw = response.request().postData();
    return raw === null ? undefined : parseJson(raw);
  }
}

export class AvailabilityResponseObserver {
  private outcome:
    | Exclude<AvailabilityObservationOutcome, { kind: "not-observed" }>
    | undefined;
  private resolveOutcome:
    | ((outcome: Exclude<AvailabilityObservationOutcome, { kind: "not-observed" }>) => void)
    | undefined;
  private readonly outcomePromise = new Promise<
    Exclude<AvailabilityObservationOutcome, { kind: "not-observed" }>
  >((resolve) => {
    this.resolveOutcome = resolve;
  });
  private readonly responseHandler = (response: Response): void => {
    void this.inspectResponse(response);
  };

  constructor(private readonly page: Page) {}

  start(): void {
    this.page.on("response", this.responseHandler);
  }

  stop(): void {
    this.page.off("response", this.responseHandler);
  }

  async wait(timeoutMs: number): Promise<AvailabilityObservationOutcome> {
    if (this.outcome !== undefined) return this.outcome;
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.outcomePromise,
        new Promise<{ readonly kind: "not-observed" }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: "not-observed" }), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private settle(
    outcome: Exclude<AvailabilityObservationOutcome, { kind: "not-observed" }>,
  ): void {
    if (this.outcome !== undefined) return;
    this.outcome = outcome;
    this.resolveOutcome?.(outcome);
  }

  private async inspectResponse(response: Response): Promise<void> {
    if (this.outcome !== undefined || !isAvailabilityResponseUrl(response.url())) {
      return;
    }
    if ([401, 403, 429].includes(response.status())) {
      this.settle({ kind: "http-failure", status: response.status() });
      return;
    }
    try {
      const payload = (await response.json()) as unknown;
      const postData = await readPostData(response);
      this.settle({
        kind: "availability",
        observation: {
          payload,
          requestContext: extractAvailabilityRequestContext(
            response.request().url(),
            postData,
          ),
        },
      });
    } catch {
      this.settle({ kind: "malformed" });
    }
  }
}
