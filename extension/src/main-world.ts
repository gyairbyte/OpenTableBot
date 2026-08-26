import {
  BrowserPreparedState,
  confirmedLockDisposition,
  remainingOperationMs,
  type LockTelemetryStage,
} from "../../src/opentable/bridge/lock-lifecycle.js";

const REQUEST_MARKER = "opentablebot:availability-request";
const RESPONSE_MARKER = "opentablebot:availability-response";
const PREVIEW_REQUEST_MARKER = "opentablebot:booking-preview-request";
const PREVIEW_RESPONSE_MARKER = "opentablebot:booking-preview-response";
const AUTHORIZE_REQUEST_MARKER = "opentablebot:authorize-booking-request";
const AUTHORIZE_RESPONSE_MARKER = "opentablebot:authorize-booking-response";
const LOCK_REQUEST_MARKER = "opentablebot:lock-slot-request";
const LOCK_RESPONSE_MARKER = "opentablebot:lock-slot-response";
const LOCK_PROGRESS_MARKER = "opentablebot:lock-progress";
const ABANDON_LOCK_MARKER = "opentablebot:abandon-lock-operation";
const ABANDON_PREPARED_MARKER = "opentablebot:abandon-prepared-booking";
const ACK_LOCK_REQUEST_MARKER = "opentablebot:acknowledge-lock-request";
const ACK_LOCK_RESPONSE_MARKER = "opentablebot:acknowledge-lock-response";
const REVALIDATE_REQUEST_MARKER = "opentablebot:revalidate-prepared-request";
const REVALIDATE_RESPONSE_MARKER = "opentablebot:revalidate-prepared-response";
const SUBMIT_REQUEST_MARKER = "opentablebot:submit-reservation-request";
const SUBMIT_RESPONSE_MARKER = "opentablebot:submit-reservation-response";
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
  readonly databaseRegion: string;
  detailsState?: unknown;
}

interface WritePageRequest {
  readonly marker:
    | typeof AUTHORIZE_REQUEST_MARKER
    | typeof LOCK_REQUEST_MARKER
    | typeof ACK_LOCK_REQUEST_MARKER
    | typeof REVALIDATE_REQUEST_MARKER
    | typeof SUBMIT_REQUEST_MARKER;
  readonly id: string;
  readonly authorizationHandle?: string;
  readonly preparedHandle?: string;
  readonly operationId?: string;
  readonly request: Record<string, unknown>;
  readonly deadlineEpochMs?: number;
}

interface AuthorizationRecord {
  readonly expiresAt: number;
  readonly intent: Record<string, unknown>;
  readonly previewReference: string;
  used: boolean;
}

export interface PreparedRecord {
  readonly expiresAt: number;
  readonly intent: Record<string, unknown>;
  readonly previewReference: string;
  readonly slotLockId: string;
  readonly diningAreaId: number;
  readonly correlationId: string;
  readonly lockOperationId: string;
  state: (typeof BrowserPreparedState)[keyof typeof BrowserPreparedState];
  terminalResult?: unknown;
}

interface LockOperationRecord {
  readonly startedAt: number;
  latestStage?: LockTelemetryStage;
  abandoned: boolean;
}

export type SubmissionStart =
  | { readonly kind: "begin" }
  | { readonly kind: "cached"; readonly result: unknown };

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
const authorizationRecords = new Map<string, AuthorizationRecord>();
const preparedRecords = new Map<string, PreparedRecord>();
const lockOperationRecords = new Map<string, LockOperationRecord>();
const PREVIEW_REFERENCE_TTL_MS = 10 * 60_000;
const AUTHORIZATION_TTL_MS = 30_000;
const PREPARED_TTL_MS = 60_000;
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

function parseWritePageRequest(value: unknown): WritePageRequest | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  if (
    value.marker !== AUTHORIZE_REQUEST_MARKER &&
    value.marker !== LOCK_REQUEST_MARKER &&
    value.marker !== ACK_LOCK_REQUEST_MARKER &&
    value.marker !== REVALIDATE_REQUEST_MARKER &&
    value.marker !== SUBMIT_REQUEST_MARKER
  ) return undefined;
  if (value.marker !== ACK_LOCK_REQUEST_MARKER && !isRecord(value.request)) return undefined;
  if (value.marker === LOCK_REQUEST_MARKER && typeof value.authorizationHandle !== "string") return undefined;
  if (value.marker === ACK_LOCK_REQUEST_MARKER && (typeof value.operationId !== "string" || typeof value.preparedHandle !== "string")) return undefined;
  if (value.marker === REVALIDATE_REQUEST_MARKER && typeof value.preparedHandle !== "string") return undefined;
  if (value.marker === SUBMIT_REQUEST_MARKER && typeof value.preparedHandle !== "string") return undefined;
  return { ...(value as unknown as WritePageRequest), request: isRecord(value.request) ? value.request : {} };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function exactIntentMatch(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return canonical(left) === canonical(right);
}

/** Atomically guards the only transition that may dispatch make-reservation. */
export function beginPreparedSubmission(
  prepared: PreparedRecord,
  intent: Record<string, unknown>,
  now = Date.now(),
): SubmissionStart {
  if (!exactIntentMatch(prepared.intent, intent)) {
    throw new Error("BOOKING_INVARIANT_MISMATCH: Prepared handle does not match intent");
  }
  if (
    (prepared.state === BrowserPreparedState.CONFIRMED || prepared.state === BrowserPreparedState.OUTCOME_UNKNOWN) &&
    prepared.terminalResult !== undefined
  ) return { kind: "cached", result: prepared.terminalResult };
  if (prepared.state === BrowserPreparedState.FAILED_DEFINITIVE) {
    throw new Error("SUBMISSION_REJECTED: The prepared booking was definitively rejected");
  }
  if (prepared.state !== BrowserPreparedState.REVALIDATED) {
    throw new Error("DUPLICATE_SUBMISSION_PREVENTED: Reservation submission was already dispatched");
  }
  if (prepared.expiresAt <= now) {
    prepared.state = BrowserPreparedState.FAILED_DEFINITIVE;
    throw new Error("LOCK_EXPIRED: Prepared slot lock expired before submission");
  }
  prepared.state = BrowserPreparedState.SUBMITTING;
  return { kind: "begin" };
}

function validateStandardIntent(intent: Record<string, unknown>): { previewReference: string; record: PreviewRecord } {
  const previewReference = intent.previewReference;
  const reservationKind = intent.reservationKind;
  const preview = intent.approvedPreview;
  if (
    typeof previewReference !== "string" ||
    typeof intent.targetId !== "string" ||
    typeof intent.slotId !== "string" ||
    typeof intent.restaurantId !== "string" ||
    typeof intent.date !== "string" ||
    typeof intent.time !== "string" ||
    typeof intent.startsAt !== "string" ||
    typeof intent.partySize !== "number" ||
    typeof intent.seatingType !== "string" ||
    !isRecord(reservationKind) || reservationKind.kind !== "standard" ||
    !isRecord(preview)
  ) throw new Error("BOOKING_INVARIANT_MISMATCH: Malformed Standard booking intent");
  cleanExpiredPreviewRecords();
  const record = previewRecords.get(previewReference);
  if (record === undefined || record.detailsState === undefined) {
    throw new Error("BOOKING_AUTHORIZATION_EXPIRED: Preview reference is missing, expired, or was not previewed");
  }
  if (
    record.restaurantId !== intent.restaurantId ||
    record.date !== intent.date ||
    record.time !== intent.time ||
    record.partySize !== intent.partySize ||
    record.providerType.toLowerCase() !== "standard" ||
    preview.restaurantId !== intent.restaurantId ||
    preview.localDate !== intent.date ||
    preview.localTime !== intent.time ||
    preview.partySize !== intent.partySize ||
    preview.seatingType !== intent.seatingType
  ) throw new Error("BOOKING_INVARIANT_MISMATCH: Intent does not match the previewed slot");
  const cancellation = preview.cancellationFee;
  const noShow = preview.noShowFee;
  if (
    !isRecord(preview.prepaid) || preview.prepaid.status !== "not-required" ||
    !isRecord(cancellation) || cancellation.status === "unknown" ||
    !isRecord(noShow) || noShow.status === "unknown" ||
    preview.paymentRequirement !== "not-required"
  ) throw new Error("PAYMENT_REQUIRED: Prepaid, unknown terms, and payment-backed reservations are not supported");
  const monetaryExposure =
    (cancellation.status === "known" && Number(cancellation.amountCents) > 0) ||
    (noShow.status === "known" && Number(noShow.amountCents) > 0);
  if (monetaryExposure && (!isRecord(preview.currency) || preview.currency.status !== "known")) {
    throw new Error("PAYMENT_REQUIRED: Currency is required for monetary exposure");
  }
  if (preview.strongAuthentication !== "not-required") {
    throw new Error("SCA_REQUIRED: Interactive strong authentication is not supported");
  }
  const rawRoot = rootState(record.detailsState);
  const rawTimeSlot = isRecord(rawRoot.timeSlot) ? rawRoot.timeSlot : {};
  if (rawTimeSlot.creditCardRequired !== false) {
    throw new Error("PAYMENT_REQUIRED: Provider details did not confirm that no payment method is required");
  }
  if (rawTimeSlot.strongAuthenticationRequired === true) {
    throw new Error("SCA_REQUIRED: Provider details require interactive strong authentication");
  }
  if (
    typeof rawTimeSlot.reservationType === "string" &&
    rawTimeSlot.reservationType.toLowerCase() !== "standard"
  ) throw new Error("BOOKING_INVARIANT_MISMATCH: Provider details were not a Standard reservation");
  return { previewReference, record };
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
              databaseRegion:
                typeof variables.databaseRegion === "string"
                  ? variables.databaseRegion
                  : "NA",
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
  const detailsState = extractInitialStateFromHtml(await response.text());
  record.detailsState = detailsState;
  return detailsState;
}

function rootState(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("BOOKING_INVARIANT_MISMATCH: Booking details state was malformed");
  return isRecord(value.state) ? value.state : value;
}

function diningAreaIdFor(record: PreviewRecord, seatingType: unknown): number {
  const root = rootState(record.detailsState);
  const timeSlot = isRecord(root.timeSlot) ? root.timeSlot : {};
  const expected = providerSeatingType(String(seatingType));
  const candidates = Array.isArray(timeSlot.diningAreasBySeating)
    ? timeSlot.diningAreasBySeating.filter(
        (value): value is Record<string, unknown> =>
          isRecord(value) &&
          Number.isInteger(value.diningAreaId) &&
          compactSeating(String(value.tableCategory ?? "")) === compactSeating(expected ?? ""),
      )
    : [];
  if (candidates.length !== 1) {
    throw new Error("BOOKING_INVARIANT_MISMATCH: Exact dining area was not established");
  }
  return Number(candidates[0]!.diningAreaId);
}

async function authorizeBooking(request: WritePageRequest): Promise<unknown> {
  const { previewReference } = validateStandardIntent(request.request);
  const authorizationHandle = crypto.randomUUID();
  const expiresAt = Date.now() + AUTHORIZATION_TTL_MS;
  authorizationRecords.set(authorizationHandle, {
    expiresAt,
    intent: structuredClone(request.request),
    previewReference,
    used: false,
  });
  return { authorizationHandle, expiresAt: new Date(expiresAt).toISOString() };
}

function emitLockProgress(
  targetWindow: Window,
  operationId: string,
  stage: LockTelemetryStage,
  outcome?: "LOCK_NOT_DISPATCHED" | "LOCK_REJECTED" | "LOCK_CONFIRMED" | "LOCK_OUTCOME_UNKNOWN",
): void {
  const operation = lockOperationRecords.get(operationId);
  if (operation !== undefined) operation.latestStage = stage;
  targetWindow.postMessage({
    marker: LOCK_PROGRESS_MARKER,
    id: operationId,
    stage,
    elapsedMs: Math.max(0, Date.now() - (operation?.startedAt ?? Date.now())),
    ...(outcome === undefined ? {} : { outcome }),
  }, targetWindow.location.origin);
}

function abandonLockOperation(operationId: string): void {
  const operation = lockOperationRecords.get(operationId);
  if (operation !== undefined) operation.abandoned = true;
  for (const prepared of preparedRecords.values()) {
    if (prepared.lockOperationId === operationId) prepared.state = BrowserPreparedState.ORPHANED;
  }
}

function abandonPreparedBooking(preparedHandle: string): void {
  const prepared = preparedRecords.get(preparedHandle);
  if (
    prepared !== undefined &&
    prepared.state !== BrowserPreparedState.CONFIRMED &&
    prepared.state !== BrowserPreparedState.FAILED_DEFINITIVE &&
    prepared.state !== BrowserPreparedState.OUTCOME_UNKNOWN
  ) prepared.state = BrowserPreparedState.ORPHANED;
}

async function lockSlot(targetWindow: ApolloWindow, request: WritePageRequest): Promise<unknown> {
  const operationId = request.id;
  lockOperationRecords.set(operationId, { startedAt: Date.now(), abandoned: false });
  emitLockProgress(targetWindow, operationId, "LOCK_REQUEST_ACCEPTED");
  emitLockProgress(targetWindow, operationId, "PAGE_OPERATION_RECEIVED");
  const deadlineEpochMs = request.deadlineEpochMs ?? Date.now();
  if (remainingOperationMs(deadlineEpochMs) === 0) {
    return { outcome: { status: "LOCK_NOT_DISPATCHED", message: "Lock deadline elapsed before provider dispatch" } };
  }
  const handle = request.authorizationHandle!;
  const authorization = authorizationRecords.get(handle);
  if (authorization === undefined || authorization.used || authorization.expiresAt <= Date.now()) {
    throw new Error("BOOKING_AUTHORIZATION_EXPIRED: Booking authorization is invalid, used, or expired");
  }
  if (!exactIntentMatch(authorization.intent, request.request)) {
    throw new Error("BOOKING_INVARIANT_MISMATCH: Lock intent differs from its authorization");
  }
  const { previewReference, record } = validateStandardIntent(request.request);
  authorization.used = true;
  const diningAreaId = diningAreaIdFor(record, request.request.seatingType);
  const numericRestaurantId = Number(record.restaurantId);
  if (!Number.isSafeInteger(numericRestaurantId) || numericRestaurantId <= 0) {
    throw new Error("BOOKING_INVARIANT_MISMATCH: Provider restaurant ID was not a positive integer");
  }
  const url = new URL("/dapi/fe/gql", targetWindow.location.origin);
  url.searchParams.set("optype", "mutation");
  url.searchParams.set("opname", "BookDetailsStandardSlotLock");
  const controller = new AbortController();
  const abortTimer = targetWindow.setTimeout(
    () => controller.abort(),
    remainingOperationMs(deadlineEpochMs),
  );
  let response: Response;
  try {
    emitLockProgress(targetWindow, operationId, "PROVIDER_DISPATCHED");
    response = await targetWindow.fetch(url, {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "ot-page-type": "network_details",
        "ot-page-group": "booking",
      },
      body: JSON.stringify({
        operationName: "BookDetailsStandardSlotLock",
        variables: {
          input: {
            restaurantId: numericRestaurantId,
            seatingOption: "DEFAULT",
            reservationDateTime: `${record.date}T${record.time}`,
            partySize: record.partySize,
            databaseRegion: record.databaseRegion,
            slotHash: record.slotHash,
            reservationType: "STANDARD",
            diningAreaId,
          },
        },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "1100bf68905fd7cb1d4fd0f4504a4954aa28ec45fb22913fa977af8b06fd97fa",
          },
        },
      }),
    });
  } catch {
    emitLockProgress(targetWindow, operationId, "PROVIDER_DISPATCHED", "LOCK_OUTCOME_UNKNOWN");
    return { outcome: { status: "LOCK_OUTCOME_UNKNOWN", message: "Provider lock was dispatched but no definitive response was received" } };
  } finally {
    targetWindow.clearTimeout(abortTimer);
  }
  emitLockProgress(targetWindow, operationId, "PROVIDER_RESPONSE_RECEIVED");
  if (!response.ok) {
    emitLockProgress(targetWindow, operationId, "PROVIDER_RESPONSE_RECEIVED", "LOCK_OUTCOME_UNKNOWN");
    return { outcome: { status: "LOCK_OUTCOME_UNKNOWN", message: `Provider lock returned HTTP ${response.status} after dispatch without a definitive lock result` } };
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    emitLockProgress(targetWindow, operationId, "PROVIDER_RESPONSE_RECEIVED", "LOCK_OUTCOME_UNKNOWN");
    return { outcome: { status: "LOCK_OUTCOME_UNKNOWN", message: "Provider lock response could not be parsed" } };
  }
  const lockSlotResult = isRecord(payload) && isRecord(payload.data) && isRecord(payload.data.lockSlot)
    ? payload.data.lockSlot
    : undefined;
  const slotLock = lockSlotResult !== undefined && isRecord(lockSlotResult.slotLock)
    ? lockSlotResult.slotLock
    : undefined;
  if (lockSlotResult?.success === false) {
    emitLockProgress(targetWindow, operationId, "PROVIDER_RESPONSE_RECEIVED", "LOCK_REJECTED");
    return { outcome: { status: "LOCK_REJECTED", message: "Provider did not confirm the slot lock" } };
  }
  if (lockSlotResult?.success !== true || typeof slotLock?.slotLockId !== "string") {
    emitLockProgress(targetWindow, operationId, "PROVIDER_RESPONSE_RECEIVED", "LOCK_OUTCOME_UNKNOWN");
    return { outcome: { status: "LOCK_OUTCOME_UNKNOWN", message: "Provider lock response omitted a definitive result" } };
  }
  emitLockProgress(targetWindow, operationId, "LOCK_PARSED");
  const preparedHandle = crypto.randomUUID();
  const expiresAt = Date.now() + PREPARED_TTL_MS;
  const operation = lockOperationRecords.get(operationId);
  const disposition = confirmedLockDisposition(operation?.abandoned === true);
  preparedRecords.set(preparedHandle, {
    expiresAt,
    intent: structuredClone(request.request),
    previewReference,
    slotLockId: slotLock.slotLockId,
    diningAreaId,
    correlationId: crypto.randomUUID(),
    lockOperationId: operationId,
    state: disposition.state,
  });
  emitLockProgress(targetWindow, operationId, "PREPARED_STATE_CREATED", disposition.outcome);
  if (disposition.outcome === "LOCK_OUTCOME_UNKNOWN") {
    return { outcome: { status: "LOCK_OUTCOME_UNKNOWN", message: "Provider confirmed the lock after its caller abandoned the operation; the lock is orphaned" } };
  }
  return {
    outcome: {
      status: "LOCK_CONFIRMED",
      operationId,
      preparedHandle,
      expiresAt: new Date(expiresAt).toISOString(),
    },
  };
}

async function acknowledgeLock(request: WritePageRequest): Promise<unknown> {
  const prepared = preparedRecords.get(request.preparedHandle!);
  if (
    prepared === undefined ||
    prepared.lockOperationId !== request.operationId ||
    prepared.state !== BrowserPreparedState.PENDING_ACK ||
    prepared.expiresAt <= Date.now()
  ) throw new Error("LOCK_OUTCOME_UNKNOWN: Prepared lock cannot be acknowledged safely");
  prepared.state = BrowserPreparedState.ACKNOWLEDGED;
  return { acknowledged: true };
}

async function revalidatePreparedBooking(
  targetWindow: ApolloWindow,
  request: WritePageRequest,
): Promise<unknown> {
  const prepared = preparedRecords.get(request.preparedHandle!);
  if (
    prepared === undefined ||
    prepared.state !== BrowserPreparedState.ACKNOWLEDGED ||
    prepared.expiresAt <= Date.now() ||
    !exactIntentMatch(prepared.intent, request.request)
  ) throw new Error("REVALIDATION_OUTCOME_UNKNOWN: Prepared lock is unavailable for revalidation");
  const previewRequest: BookingPreviewPageRequest = {
    marker: PREVIEW_REQUEST_MARKER,
    id: request.id,
    request: {
      previewReference: prepared.previewReference,
      restaurantId: String(request.request.restaurantId),
      date: String(request.request.date),
      time: String(request.request.time),
      partySize: Number(request.request.partySize),
      seatingType: String(request.request.seatingType),
      reservationKind: { kind: "standard" },
    },
  };
  try {
    const postLockState = await executeBookingPreview(targetWindow, previewRequest);
    if (prepared.state !== BrowserPreparedState.ACKNOWLEDGED) {
      throw new Error("REVALIDATION_OUTCOME_UNKNOWN: Prepared lock was orphaned before revalidation completed");
    }
    prepared.state = BrowserPreparedState.REVALIDATED;
    return { postLockState };
  } catch (error) {
    prepared.state = BrowserPreparedState.ORPHANED;
    throw error;
  }
}

function profileFromState(value: unknown): Record<string, string> {
  const root = rootState(value);
  const header = isRecord(root.header) ? root.header : {};
  const profile = isRecord(header.userProfile) ? header.userProfile : {};
  const phone = isRecord(profile.mobilePhoneNumber) ? profile.mobilePhoneNumber : {};
  const stringField = (field: unknown): string | undefined =>
    typeof field === "string" && field.trim() !== "" ? field.trim() : undefined;
  const identifierField = (field: unknown): string | undefined =>
    (typeof field === "string" || typeof field === "number") && String(field).trim() !== ""
      ? String(field).trim()
      : undefined;
  const fields = {
    firstName: stringField(profile.firstName),
    lastName: stringField(profile.lastName),
    email: stringField(profile.email),
    phoneNumber: stringField(phone.number),
    phoneNumberCountryId: identifierField(phone.countryId),
    country: identifierField(profile.countryId),
  };
  if (Object.values(fields).some((field) => field === undefined)) {
    throw new Error("SUBMISSION_REJECTED: Signed-in profile is incomplete");
  }
  return fields as Record<string, string>;
}

async function submitReservation(targetWindow: ApolloWindow, request: WritePageRequest): Promise<unknown> {
  const prepared = preparedRecords.get(request.preparedHandle!);
  if (prepared === undefined || !exactIntentMatch(prepared.intent, request.request)) {
    throw new Error("BOOKING_INVARIANT_MISMATCH: Prepared handle is invalid or does not match intent");
  }
  const start = beginPreparedSubmission(prepared, request.request);
  if (start.kind === "cached") return start.result;
  const { record } = validateStandardIntent(request.request);
  let dispatched = false;
  try {
    const dashboard = await targetWindow.fetch(new URL("/user/dining-dashboard", targetWindow.location.origin), {
      method: "GET", credentials: "include", redirect: "follow",
    });
    if (!dashboard.ok) throw new Error(`SUBMISSION_REJECTED: Profile returned HTTP ${dashboard.status}`);
    const profile = profileFromState(extractInitialStateFromHtml(await dashboard.text()));
    dispatched = true;
    const response = await targetWindow.fetch(new URL("/dapi/booking/make-reservation", targetWindow.location.origin), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "ot-page-type": "network_details", "ot-page-group": "booking" },
      body: JSON.stringify({
        restaurantId: Number(record.restaurantId),
        reservationDateTime: `${record.date}T${record.time}`,
        partySize: record.partySize,
        slotHash: record.slotHash,
        slotAvailabilityToken: record.slotAvailabilityToken,
        slotLockId: prepared.slotLockId,
        diningAreaId: prepared.diningAreaId,
        ...profile,
        reservationAttribute: "default",
        pointsType: "Standard",
        points: 100,
        tipAmount: 0,
        tipPercent: 0,
        confirmPoints: true,
        optInEmailRestaurant: false,
        additionalServiceFees: [],
        nonBookableExperiences: [],
        katakanaFirstName: "",
        katakanaLastName: "",
        correlationId: prepared.correlationId,
        isModify: false,
        reservationType: "Standard",
      }),
    });
    if (response.status >= 500) throw new Error(`Provider returned HTTP ${response.status} after dispatch`);
    const payload = (await response.json()) as unknown;
    if (!response.ok || !isRecord(payload) || payload.success !== true) {
      prepared.state = BrowserPreparedState.FAILED_DEFINITIVE;
      prepared.terminalResult = { definitiveFailure: true, message: "Provider definitively rejected the reservation" };
      throw new Error("SUBMISSION_REJECTED: Provider definitively rejected the reservation");
    }
    if (payload.partnerScaRequired === true || typeof payload.redirect === "string") {
      prepared.state = BrowserPreparedState.OUTCOME_UNKNOWN;
      prepared.terminalResult = { status: "outcome-unknown", message: "Provider requested an unsupported interactive authentication step after dispatch" };
      return prepared.terminalResult;
    }
    const confirmationId = typeof payload.confirmationNumber === "string" || typeof payload.confirmationNumber === "number"
      ? String(payload.confirmationNumber)
      : typeof payload.reservationId === "string" || typeof payload.reservationId === "number"
        ? String(payload.reservationId)
        : undefined;
    if (confirmationId === undefined) throw new Error("Provider omitted a confirmation after dispatch");
    prepared.state = BrowserPreparedState.CONFIRMED;
    prepared.terminalResult = {
      status: "confirmed",
      confirmation: {
        confirmationId,
        slotId: String(request.request.slotId),
        restaurantId: String(request.request.restaurantId),
        startsAt: String(request.request.startsAt),
        partySize: Number(request.request.partySize),
        seatingType: String(request.request.seatingType),
        bookedAt: new Date().toISOString(),
      },
    };
    return prepared.terminalResult;
  } catch (error) {
    if (!dispatched || (error instanceof Error && error.message.startsWith("SUBMISSION_REJECTED:"))) throw error;
    prepared.state = BrowserPreparedState.OUTCOME_UNKNOWN;
    prepared.terminalResult = {
      status: "outcome-unknown",
      message: "Reservation submission was dispatched, but its outcome could not be confirmed; do not retry",
    };
    return prepared.terminalResult;
  }
}

function respond(
  targetWindow: Window,
  marker:
    | typeof RESPONSE_MARKER
    | typeof PREVIEW_RESPONSE_MARKER
    | typeof AUTHORIZE_RESPONSE_MARKER
    | typeof LOCK_RESPONSE_MARKER
    | typeof ACK_LOCK_RESPONSE_MARKER
    | typeof REVALIDATE_RESPONSE_MARKER
    | typeof SUBMIT_RESPONSE_MARKER,
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
    if (isRecord(event.data) && event.data.marker === ABANDON_LOCK_MARKER && typeof event.data.id === "string") {
      abandonLockOperation(event.data.id);
      return;
    }
    if (
      isRecord(event.data) &&
      event.data.marker === ABANDON_PREPARED_MARKER &&
      typeof event.data.preparedHandle === "string"
    ) {
      abandonPreparedBooking(event.data.preparedHandle);
      return;
    }
    const writeRequest = parseWritePageRequest(event.data);
    if (writeRequest !== undefined) {
      const responseMarker =
        writeRequest.marker === AUTHORIZE_REQUEST_MARKER
          ? AUTHORIZE_RESPONSE_MARKER
          : writeRequest.marker === LOCK_REQUEST_MARKER
            ? LOCK_RESPONSE_MARKER
            : writeRequest.marker === ACK_LOCK_REQUEST_MARKER
              ? ACK_LOCK_RESPONSE_MARKER
              : writeRequest.marker === REVALIDATE_REQUEST_MARKER
                ? REVALIDATE_RESPONSE_MARKER
                : SUBMIT_RESPONSE_MARKER;
      const operation =
        writeRequest.marker === AUTHORIZE_REQUEST_MARKER
          ? authorizeBooking(writeRequest)
          : writeRequest.marker === LOCK_REQUEST_MARKER
            ? lockSlot(targetWindow, writeRequest)
            : writeRequest.marker === ACK_LOCK_REQUEST_MARKER
              ? acknowledgeLock(writeRequest)
              : writeRequest.marker === REVALIDATE_REQUEST_MARKER
                ? revalidatePreparedBooking(targetWindow, writeRequest)
                : submitReservation(targetWindow, writeRequest);
      void operation
        .then((result) => respond(targetWindow, responseMarker, writeRequest.id, { ok: true, result }))
        .catch((error: unknown) =>
          respond(targetWindow, responseMarker, writeRequest.id, {
            ok: false,
            error: error instanceof Error ? error.message.slice(0, 300) : "Controlled booking operation failed",
          }),
        );
      return;
    }
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
