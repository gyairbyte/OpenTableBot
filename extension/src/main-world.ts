const REQUEST_MARKER = "opentablebot:availability-request";
const RESPONSE_MARKER = "opentablebot:availability-response";
const PREVIEW_REQUEST_MARKER = "opentablebot:booking-preview-request";
const PREVIEW_RESPONSE_MARKER = "opentablebot:booking-preview-response";
const APOLLO_OPERATION_NAME = "RestaurantsAvailability";
const APOLLO_WRAPPED_MARKER = "__opentablebotAvailabilityWrapped";
const FETCH_WRAPPED_MARKER = "__opentablebotAvailabilityFetchWrapped";

interface ApolloOperation {
  readonly operationName?: string;
  readonly query?: unknown;
  readonly variables?: unknown;
}

interface ObservableLike {
  subscribe(observer: unknown): unknown;
}

type LinkRequest = (operation: ApolloOperation, forward?: unknown) => ObservableLike;
type MarkedFetch = typeof fetch & { [FETCH_WRAPPED_MARKER]?: true };

interface ApolloClientLike {
  link?: { request?: LinkRequest & { [APOLLO_WRAPPED_MARKER]?: true } };
  query?(options: {
    query: unknown;
    variables: Record<string, unknown>;
    fetchPolicy: "no-cache";
    errorPolicy: "all";
  }): Promise<unknown>;
}

interface ApolloWindow extends Window {
  __APOLLO_CLIENT__?: ApolloClientLike;
  fetch: MarkedFetch;
}

interface PageRequest {
  readonly marker: typeof REQUEST_MARKER;
  readonly id: string;
  readonly variables: Record<string, unknown>;
}

interface BookingPreviewPageRequest {
  readonly marker: typeof PREVIEW_REQUEST_MARKER;
  readonly id: string;
  readonly request: {
    readonly previewReference: string;
    readonly restaurantId: string;
    readonly date: string;
    readonly time: string;
    readonly partySize: number;
    readonly seatingType: string;
    readonly reservationKind:
      | { readonly kind: "standard" }
      | { readonly kind: "experience"; readonly experienceId: string }
      | { readonly kind: "unknown"; readonly providerType: string };
  };
}

interface PreviewRecord {
  readonly expiresAt: number;
  readonly restaurantId: string;
  readonly date: string;
  readonly time: string;
  readonly partySize: number;
  readonly providerType: string;
  readonly attributes: readonly string[];
  readonly experienceIds: readonly string[];
  readonly slotHash: string;
  readonly slotAvailabilityToken: string;
}

interface AvailabilityFetchTemplate {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly credentials: RequestCredentials;
  readonly payloadWasArray: boolean;
  readonly operation: Record<string, unknown>;
}

const availabilityFetchTemplates: AvailabilityFetchTemplate[] = [];
const previewRecords = new Map<string, PreviewRecord>();
const PREVIEW_REFERENCE_TTL_MS = 10 * 60_000;
let availabilityDocument: unknown;
let availabilityApolloVariables: Record<string, unknown> | undefined;
let messageListenerInstalled = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePageRequest(value: unknown): PageRequest | undefined {
  if (!isRecord(value) || value.marker !== REQUEST_MARKER) return undefined;
  if (typeof value.id !== "string" || !isRecord(value.variables)) return undefined;
  return { marker: REQUEST_MARKER, id: value.id, variables: value.variables };
}

function parseBookingPreviewPageRequest(
  value: unknown,
): BookingPreviewPageRequest | undefined {
  if (!isRecord(value) || value.marker !== PREVIEW_REQUEST_MARKER) return undefined;
  if (typeof value.id !== "string" || !isRecord(value.request)) return undefined;
  const request = value.request;
  if (
    typeof request.previewReference !== "string" ||
    typeof request.restaurantId !== "string" ||
    typeof request.date !== "string" ||
    typeof request.time !== "string" ||
    typeof request.partySize !== "number" ||
    typeof request.seatingType !== "string" ||
    !isRecord(request.reservationKind) ||
    typeof request.reservationKind.kind !== "string"
  ) {
    return undefined;
  }
  if (
    request.reservationKind.kind !== "standard" &&
    request.reservationKind.kind !== "experience" &&
    request.reservationKind.kind !== "unknown"
  ) {
    return undefined;
  }
  if (
    request.reservationKind.kind === "experience" &&
    typeof request.reservationKind.experienceId !== "string"
  ) {
    return undefined;
  }
  if (
    request.reservationKind.kind === "unknown" &&
    typeof request.reservationKind.providerType !== "string"
  ) {
    return undefined;
  }
  return value as unknown as BookingPreviewPageRequest;
}

export function findAvailabilityOperation(value: unknown): {
  readonly operation: Record<string, unknown>;
  readonly payloadWasArray: boolean;
} | undefined {
  const candidates = Array.isArray(value) ? value : [value];
  const operation = candidates.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.operationName === APOLLO_OPERATION_NAME,
  );
  return operation === undefined ? undefined : { operation, payloadWasArray: Array.isArray(value) };
}

export function mergeAvailabilityVariables(
  captured: Record<string, unknown>,
  requested: Record<string, unknown>,
): Record<string, unknown> {
  const restaurantIds = Array.isArray(requested.restaurantIds)
    ? requested.restaurantIds.map(String)
    : [];
  const tokenValues = Array.isArray(captured.restaurantAvailabilityTokens)
    ? captured.restaurantAvailabilityTokens
    : undefined;
  const keyedTokens = tokenValues?.filter(
    (candidate) =>
      isRecord(candidate) &&
      restaurantIds.includes(String(candidate.restaurantId)),
  );
  const capturedRestaurantIds = Array.isArray(captured.restaurantIds)
    ? captured.restaurantIds.map(String)
    : [];
  const capturedTime = typeof captured.time === "string" ? captured.time.slice(0, 5) : undefined;
  const requestExactlyMatchesPage =
    restaurantIds.length > 0 &&
    restaurantIds.every((id) => capturedRestaurantIds.includes(id)) &&
    captured.date === requested.date &&
    capturedTime === requested.time &&
    String(captured.partySize) === String(requested.partySize) &&
    (captured.databaseRegion === undefined ||
      requested.databaseRegion === undefined ||
      captured.databaseRegion === requested.databaseRegion);
  if (requestExactlyMatchesPage) return { ...captured };
  const positionalTokens =
    tokenValues !== undefined && tokenValues.length === capturedRestaurantIds.length
      ? tokenValues.filter((_token, index) =>
          restaurantIds.includes(capturedRestaurantIds[index] ?? ""),
        )
      : [];
  const capturedTokens =
    tokenValues === undefined
      ? undefined
      : keyedTokens !== undefined && keyedTokens.length > 0
        ? keyedTokens
        : positionalTokens;
  const approvedOverrides = {
    ...(Array.isArray(requested.restaurantIds)
      ? { restaurantIds: requested.restaurantIds }
      : {}),
    ...(typeof requested.date === "string" ? { date: requested.date } : {}),
    ...(typeof requested.time === "string" ? { time: requested.time } : {}),
    ...(typeof requested.partySize === "number"
      ? { partySize: requested.partySize }
      : {}),
    ...(typeof requested.databaseRegion === "string"
      ? { databaseRegion: requested.databaseRegion }
      : {}),
  };
  return {
    ...captured,
    ...approvedOverrides,
    ...(capturedTokens === undefined
      ? {}
      : { restaurantAvailabilityTokens: capturedTokens }),
  };
}

function allowedAvailabilityUrl(rawUrl: string, targetWindow: Window): boolean {
  try {
    const url = new URL(rawUrl, targetWindow.location.href);
    return url.protocol === "https:" && url.hostname === "www.opentable.com";
  } catch {
    return false;
  }
}

async function captureAvailabilityFetch(
  targetWindow: ApolloWindow,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<void> {
  let request: Request;
  try {
    request = new Request(input, init);
  } catch {
    return;
  }
  if (request.method !== "POST" || !allowedAvailabilityUrl(request.url, targetWindow)) return;
  let payload: unknown;
  try {
    payload = JSON.parse(await request.clone().text()) as unknown;
  } catch {
    return;
  }
  const found = findAvailabilityOperation(payload);
  if (found === undefined) return;
  availabilityFetchTemplates.push({
    url: request.url,
    method: request.method,
    headers: new Headers(request.headers),
    credentials: request.credentials,
    operation: found.operation,
    payloadWasArray: found.payloadWasArray,
  });
  if (availabilityFetchTemplates.length > 20) availabilityFetchTemplates.shift();
}

function selectAvailabilityFetchTemplate(
  variables: Record<string, unknown>,
): AvailabilityFetchTemplate | undefined {
  const requestedIds = Array.isArray(variables.restaurantIds)
    ? variables.restaurantIds.map(String)
    : [];
  return availabilityFetchTemplates
    .toReversed()
    .find((template) => {
      const capturedVariables = isRecord(template.operation.variables)
        ? template.operation.variables
        : {};
      const capturedIds = Array.isArray(capturedVariables.restaurantIds)
        ? capturedVariables.restaurantIds.map(String)
        : [];
      return requestedIds.length > 0 && requestedIds.every((id) => capturedIds.includes(id));
    });
}

function addDaysAndMinutes(
  baseDate: string,
  baseTime: string,
  dayOffset: number,
  minuteOffset: number,
): { readonly date: string; readonly time: string } {
  const [year, month, day] = baseDate.split("-").map(Number);
  const [hour, minute] = baseTime.slice(0, 5).split(":").map(Number);
  const shifted = new Date(
    Date.UTC(
      year ?? 0,
      (month ?? 1) - 1,
      (day ?? 0) + dayOffset,
      hour ?? 0,
      (minute ?? 0) + minuteOffset,
    ),
  );
  return {
    date: `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(
      shifted.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`,
    time: `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(
      shifted.getUTCMinutes(),
    ).padStart(2, "0")}`,
  };
}

function cleanExpiredPreviewRecords(): void {
  const now = Date.now();
  for (const [reference, record] of previewRecords) {
    if (record.expiresAt <= now) previewRecords.delete(reference);
  }
}

/**
 * Add browser-generated, non-secret preview handles to available slots while
 * retaining provider hashes/tokens only in MAIN-world memory.
 */
export function attachPreviewReferences(
  result: unknown,
  variables: Record<string, unknown>,
): unknown {
  if (!isRecord(result) || !isRecord(result.data)) return result;
  const availability = result.data.availability;
  if (!Array.isArray(availability)) return result;
  const requestDate = typeof variables.date === "string" ? variables.date : undefined;
  const requestTime = typeof variables.time === "string" ? variables.time : undefined;
  const partySize = typeof variables.partySize === "number" ? variables.partySize : undefined;
  if (requestDate === undefined || requestTime === undefined || partySize === undefined) {
    return result;
  }
  cleanExpiredPreviewRecords();
  const augmented = availability.map((restaurant) => {
    if (!isRecord(restaurant) || !Array.isArray(restaurant.availabilityDays)) {
      return restaurant;
    }
    const restaurantId = String(restaurant.restaurantId ?? "");
    return {
      ...restaurant,
      availabilityDays: restaurant.availabilityDays.map((day) => {
        if (!isRecord(day) || !Array.isArray(day.slots)) return day;
        const dayOffset = typeof day.dayOffset === "number" ? day.dayOffset : 0;
        return {
          ...day,
          slots: day.slots.map((slot) => {
            if (
              !isRecord(slot) ||
              slot.isAvailable !== true ||
              typeof slot.slotHash !== "string" ||
              typeof slot.slotAvailabilityToken !== "string"
            ) {
              return slot;
            }
            const shifted = addDaysAndMinutes(
              requestDate,
              requestTime,
              dayOffset,
              typeof slot.timeOffsetMinutes === "number"
                ? slot.timeOffsetMinutes
                : 0,
            );
            const previewReference = crypto.randomUUID();
            previewRecords.set(previewReference, {
              expiresAt: Date.now() + PREVIEW_REFERENCE_TTL_MS,
              restaurantId,
              date: shifted.date,
              time: shifted.time,
              partySize,
              providerType: typeof slot.type === "string" ? slot.type : "unknown",
              attributes: Array.isArray(slot.attributes)
                ? slot.attributes.filter((item): item is string => typeof item === "string")
                : [],
              experienceIds: Array.isArray(slot.experienceIds)
                ? slot.experienceIds.map(String)
                : [],
              slotHash: slot.slotHash,
              slotAvailabilityToken: slot.slotAvailabilityToken,
            });
            return { ...slot, previewReference };
          }),
        };
      }),
    };
  });
  return { ...result, data: { ...result.data, availability: augmented } };
}

async function executeCapturedAvailability(
  targetWindow: ApolloWindow,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const template = selectAvailabilityFetchTemplate(variables);
  if (template === undefined) {
    throw new Error("The RestaurantsAvailability operation has not been observed on this page");
  }
  const capturedVariables = isRecord(template.operation.variables)
    ? template.operation.variables
    : {};
  const mergedVariables = mergeAvailabilityVariables(capturedVariables, variables);
  const operation = { ...template.operation, variables: mergedVariables };
  const body = JSON.stringify(template.payloadWasArray ? [operation] : operation);
  const response = await targetWindow.fetch(template.url, {
    method: template.method,
    headers: template.headers,
    credentials: template.credentials,
    body,
  });
  if (!response.ok) {
    const tokenCount = Array.isArray(mergedVariables.restaurantAvailabilityTokens)
      ? mergedVariables.restaurantAvailabilityTokens.length
      : 0;
    throw new Error(
      `RestaurantsAvailability returned HTTP ${response.status}; captured variable keys: ${Object.keys(capturedVariables).sort().join(",").slice(0, 220)}; matching page token count: ${tokenCount}`,
    );
  }
  const payload = (await response.json()) as unknown;
  return template.payloadWasArray && Array.isArray(payload) ? payload[0] : payload;
}

function extractBalancedObject(source: string, markerIndex: number): unknown {
  const start = source.indexOf("{", markerIndex);
  if (start < 0) throw new Error("Booking details state was not present");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(start, index + 1)) as unknown;
    }
  }
  throw new Error("Booking details state was incomplete");
}

/** Parse JSON state from HTML without evaluating any page script. */
export function extractInitialStateFromHtml(html: string): unknown {
  for (const marker of ["window.__INITIAL_STATE__", '"__INITIAL_STATE__"']) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex >= 0) return extractBalancedObject(html, markerIndex + marker.length);
  }
  throw new Error("Booking details state was not present");
}

function providerSeatingType(seatingType: string): string | undefined {
  if (seatingType === "standard") return "default";
  if (seatingType === "outdoor") return "outdoor";
  if (seatingType === "bar") return "bar";
  if (seatingType === "counter") return "counter";
  if (seatingType === "high-top") return "highTop";
  if (seatingType === "private-dining") return "privateDining";
  return undefined;
}

function compactSeating(value: string): string {
  return value.toLowerCase().replace(/[\s_-]/gu, "");
}

async function executeBookingPreview(
  targetWindow: ApolloWindow,
  pageRequest: BookingPreviewPageRequest,
): Promise<unknown> {
  cleanExpiredPreviewRecords();
  const record = previewRecords.get(pageRequest.request.previewReference);
  if (record === undefined) throw new Error("Preview reference is missing or expired");
  const request = pageRequest.request;
  if (
    record.restaurantId !== request.restaurantId ||
    record.date !== request.date ||
    record.time !== request.time ||
    record.partySize !== request.partySize
  ) {
    throw new Error("Preview request did not match the observed availability slot");
  }
  const seating = providerSeatingType(request.seatingType);
  if (
    seating === undefined ||
    (record.attributes.length > 0 &&
      !record.attributes.some(
        (attribute) => compactSeating(attribute) === compactSeating(seating),
      ))
  ) {
    throw new Error("Preview seating did not match the observed availability slot");
  }
  const providerType = record.providerType.toLowerCase();
  if (request.reservationKind.kind === "standard" && providerType !== "standard") {
    throw new Error("Preview reservation type did not match the observed slot");
  }
  if (request.reservationKind.kind === "unknown") {
    throw new Error("Unknown reservation types cannot be previewed safely");
  }
  if (
    request.reservationKind.kind === "experience" &&
    (providerType !== "experience" ||
      !record.experienceIds.includes(request.reservationKind.experienceId))
  ) {
    throw new Error("Preview Experience did not match the observed slot");
  }

  const url = new URL("/booking/details", targetWindow.location.origin);
  url.searchParams.set("rid", record.restaurantId);
  url.searchParams.set("datetime", `${record.date}T${record.time}`);
  url.searchParams.set("covers", String(record.partySize));
  url.searchParams.set("partySize", String(record.partySize));
  url.searchParams.set("seating", seating);
  url.searchParams.set("slotHash", record.slotHash);
  url.searchParams.set("slotAvailabilityToken", record.slotAvailabilityToken);
  if (request.reservationKind.kind === "experience") {
    const experienceId = request.reservationKind.experienceId;
    url.searchParams.set("experienceIds", experienceId);
    url.searchParams.set("selectedExperience", experienceId);
    url.searchParams.set("tableCategory", seating);
    url.searchParams.set("st", "Experience");
    url.searchParams.set("isMandatory", "true");
  }

  const response = await targetWindow.fetch(url, {
    method: "GET",
    credentials: "include",
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Booking details returned HTTP ${response.status}`);
  }
  const responseUrl = new URL(response.url);
  if (
    responseUrl.origin !== targetWindow.location.origin ||
    responseUrl.pathname !== "/booking/details"
  ) {
    throw new Error("Booking details redirected away from the read-only details page");
  }
  return extractInitialStateFromHtml(await response.text());
}

function respond(
  targetWindow: Window,
  marker: typeof RESPONSE_MARKER | typeof PREVIEW_RESPONSE_MARKER,
  id: string,
  result: { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string },
): void {
  targetWindow.postMessage(
    { marker, id, ...result },
    targetWindow.location.origin,
  );
}

function installMessageListener(targetWindow: ApolloWindow): void {
  if (messageListenerInstalled) return;
  messageListenerInstalled = true;
  targetWindow.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== targetWindow) return;
    const previewRequest = parseBookingPreviewPageRequest(event.data);
    if (previewRequest !== undefined) {
      void executeBookingPreview(targetWindow, previewRequest)
        .then((result) =>
          respond(targetWindow, PREVIEW_RESPONSE_MARKER, previewRequest.id, {
            ok: true,
            result,
          }),
        )
        .catch((error: unknown) =>
          respond(targetWindow, PREVIEW_RESPONSE_MARKER, previewRequest.id, {
            ok: false,
            error:
              error instanceof Error
                ? error.message.slice(0, 300)
                : "Booking preview operation failed",
          }),
        );
      return;
    }
    const pageRequest = parsePageRequest(event.data);
    if (pageRequest === undefined) return;
    const operation =
      availabilityFetchTemplates.length > 0
        ? executeCapturedAvailability(targetWindow, pageRequest.variables)
        : availabilityDocument !== undefined && targetWindow.__APOLLO_CLIENT__?.query !== undefined
          ? targetWindow.__APOLLO_CLIENT__.query({
            query: availabilityDocument,
            variables: mergeAvailabilityVariables(
              availabilityApolloVariables ?? {},
              pageRequest.variables,
            ),
            fetchPolicy: "no-cache",
            errorPolicy: "all",
          })
          : executeCapturedAvailability(targetWindow, pageRequest.variables);
    void operation
      .then((result) =>
        respond(targetWindow, RESPONSE_MARKER, pageRequest.id, {
          ok: true,
          result: attachPreviewReferences(result, pageRequest.variables),
        }),
      )
      .catch((error: unknown) =>
        respond(targetWindow, RESPONSE_MARKER, pageRequest.id, {
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 300) : "Availability operation failed",
        }),
      );
  });
}

export function installAvailabilityFetchBridge(targetWindow: ApolloWindow = window): boolean {
  const originalFetch = targetWindow.fetch;
  if (originalFetch[FETCH_WRAPPED_MARKER] === true) return true;
  const wrapped: MarkedFetch = (input, init) => {
    void captureAvailabilityFetch(targetWindow, input, init);
    return originalFetch.call(targetWindow, input, init);
  };
  wrapped[FETCH_WRAPPED_MARKER] = true;
  targetWindow.fetch = wrapped;
  installMessageListener(targetWindow);
  return true;
}

export function installAvailabilityApolloBridge(targetWindow: ApolloWindow = window): boolean {
  const client = targetWindow.__APOLLO_CLIENT__;
  const request = client?.link?.request;
  if (client?.query === undefined || request === undefined) return false;
  if (request[APOLLO_WRAPPED_MARKER] === true) return true;
  const wrapped: LinkRequest & { [APOLLO_WRAPPED_MARKER]?: true } = (operation, forward) => {
    if (operation.operationName === APOLLO_OPERATION_NAME && operation.query !== undefined) {
      availabilityDocument = operation.query;
      availabilityApolloVariables = isRecord(operation.variables)
        ? operation.variables
        : undefined;
    }
    return request.call(client.link, operation, forward);
  };
  wrapped[APOLLO_WRAPPED_MARKER] = true;
  client.link!.request = wrapped;
  installMessageListener(targetWindow);
  return true;
}

if (typeof window !== "undefined") {
  installAvailabilityFetchBridge();
  const polling = window.setInterval(() => {
    installAvailabilityFetchBridge();
    installAvailabilityApolloBridge();
  }, 100);
  window.setTimeout(() => window.clearInterval(polling), 60_000);
}
