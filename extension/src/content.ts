import { SafeAvailabilityDataSchema, type SafeAvailabilityData } from "../../src/opentable/browser/availability-types.js";
import {
  SafeBookingPreviewDataSchema,
  type SafeBookingPreviewData,
} from "../../src/opentable/browser/preview-types.js";
import {
  OpenTablePageKind,
  classifyOpenTablePage,
  type OpenTablePageEvidence,
} from "../../src/opentable/browser/page-classifier.js";
import {
  FindSlotsRequestPayloadSchema,
  ListDiningAreasRequestPayloadSchema,
  BookingPreviewRequestPayloadSchema,
  BookingIntentSchema,
  AuthorizeBookingResultSchema,
  LockSlotResultSchema,
  SubmitReservationResultSchema,
  AcknowledgeLockResultSchema,
  RevalidatePreparedBookingResultSchema,
  LockProgressSchema,
  SearchRestaurantsRequestPayloadSchema,
  BRIDGE_PROTOCOL_VERSION,
  OpenTablePageUrlSchema,
  sanitizeOpenTablePageUrl,
} from "../../src/opentable/bridge/protocol.js";
import { SafeDiningAreaCandidatesSchema } from "../../src/opentable/browser/dining-area-types.js";
import { SafeSearchResultsSchema, type SafeSearchResults } from "../../src/opentable/browser/search-types.js";
import { classifyInterruptedLock, type LockTelemetryStage } from "../../src/opentable/bridge/lock-lifecycle.js";
import { DiningAreaOptionSchema } from "../../src/domain/dining-area.js";

const REQUEST_MARKER = "opentablebot:availability-request";
const RESPONSE_MARKER = "opentablebot:availability-response";
const PAGE_TIMEOUT_MS = 15_000;
const PREVIEW_REQUEST_MARKER = "opentablebot:booking-preview-request";
const PREVIEW_RESPONSE_MARKER = "opentablebot:booking-preview-response";
const DINING_AREAS_REQUEST_MARKER = "opentablebot:dining-areas-request";
const DINING_AREAS_RESPONSE_MARKER = "opentablebot:dining-areas-response";
const SEARCH_REQUEST_MARKER = "opentablebot:search-request";
const SEARCH_RESPONSE_MARKER = "opentablebot:search-response";
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

interface InternalMessage {
  readonly type:
    | "OTB_AUTH_STATUS"
    | "OTB_FIND_SLOTS"
    | "OTB_LIST_DINING_AREAS"
    | "OTB_SEARCH_RESTAURANTS"
    | "OTB_GET_BOOKING_PREVIEW"
    | "OTB_AUTHORIZE_BOOKING"
    | "OTB_LOCK_SLOT"
    | "OTB_ACKNOWLEDGE_LOCK"
    | "OTB_REVALIDATE_PREPARED_BOOKING"
    | "OTB_ABANDON_LOCK_OPERATION"
    | "OTB_SUBMIT_RESERVATION";
  readonly request?: unknown;
  readonly authorizationHandle?: unknown;
  readonly preparedHandle?: unknown;
  readonly operationId?: unknown;
  readonly deadlineEpochMs?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectPageEvidence(): OpenTablePageEvidence {
  const bodyText = document.body?.innerText.slice(0, 50_000) ?? "";
  const authenticatedSignals: string[] = [];
  const unauthenticatedSignals: string[] = [];
  if (/\/my\/|\/user\/|dining-dashboard/iu.test(location.pathname)) authenticatedSignals.push("authenticated-url");
  if (/my reservations|dining history|sign out/iu.test(bodyText)) authenticatedSignals.push("authenticated-content");
  if (document.querySelector('[href*="dining-dashboard"], [href*="/user/"]') !== null) {
    authenticatedSignals.push("authenticated-navigation");
  }
  if (document.querySelector('[aria-label*="account" i], [aria-label*="profile" i]') !== null) {
    authenticatedSignals.push("authenticated-account-control");
  }
  if (document.querySelector('[data-test="header-user-menu"]') !== null) {
    authenticatedSignals.push("authenticated-user-menu");
  }
  if (document.querySelector('[data-test*="user" i], [data-test*="account" i]') !== null) {
    authenticatedSignals.push("authenticated-user-data-test");
  }
  if (
    document.querySelector(
      'a[href*="/logout" i], a[href*="/signout" i], button[data-test*="signout" i]',
    ) !== null
  ) {
    authenticatedSignals.push("authenticated-sign-out-control");
  }
  if (/sign out|log out/iu.test(bodyText)) {
    authenticatedSignals.push("authenticated-sign-out-content");
  }
  if (/sign in|log in/iu.test(bodyText)) unauthenticatedSignals.push("sign-in-content");
  if (
    document.querySelector(
      '[data-test*="sign-in" i], [id*="sign-in" i], [href*="authenticate" i], [href*="login" i]',
    ) !== null
  ) {
    unauthenticatedSignals.push("sign-in-control");
  }
  return {
    url: location.href,
    title: document.title,
    bodyText,
    httpStatus: 200,
    authenticatedSignals,
    unauthenticatedSignals,
  };
}

export function sanitizeAvailabilityResult(
  value: unknown,
  requestedRestaurantId?: string,
): SafeAvailabilityData {
  if (!isRecord(value)) throw new Error("Availability result was not an object");
  const candidateData = isRecord(value.data) ? value.data : value;
  const rawAvailability = candidateData.availability;
  if (!Array.isArray(rawAvailability)) throw new Error("Availability result did not contain availability entries");
  const availability = rawAvailability.map((restaurant) => {
    if (!isRecord(restaurant) || !Array.isArray(restaurant.availabilityDays)) {
      throw new Error("Malformed restaurant availability entry");
    }
    return {
      restaurantId: restaurant.restaurantId,
      availabilityDays: restaurant.availabilityDays.map((day) => {
        if (!isRecord(day) || !Array.isArray(day.slots)) throw new Error("Malformed availability day");
        return {
          dayOffset: day.dayOffset,
          slots: day.slots.map((slot) => {
            if (!isRecord(slot)) throw new Error("Malformed availability slot");
            return {
              isAvailable: slot.isAvailable,
              ...(typeof slot.timeOffsetMinutes === "number" ? { timeOffsetMinutes: slot.timeOffsetMinutes } : {}),
              ...(Array.isArray(slot.attributes) && slot.attributes.every((item) => typeof item === "string")
                ? { attributes: slot.attributes }
                : {}),
              ...(typeof slot.type === "string" ? { type: slot.type } : {}),
              ...(typeof slot.previewReference === "string"
                ? { previewReference: slot.previewReference }
                : {}),
              ...(Array.isArray(slot.experienceIds) &&
              slot.experienceIds.every(
                (item) => typeof item === "string" || typeof item === "number",
              )
                ? { experienceIds: slot.experienceIds }
                : {}),
              ...(typeof slot.dateTime === "string" ? { dateTime: slot.dateTime } : {}),
              ...(typeof slot.startDateTime === "string" ? { startDateTime: slot.startDateTime } : {}),
            };
          }),
        };
      }),
    };
  });
  const filtered =
    requestedRestaurantId === undefined
      ? availability
      : availability.filter(
          (restaurant) => String(restaurant.restaurantId) === requestedRestaurantId,
        );
  if (requestedRestaurantId !== undefined && filtered.length === 0) {
    throw new Error("Availability response did not contain the requested restaurant");
  }
  return SafeAvailabilityDataSchema.parse({ availability: filtered });
}

/** Reduce an OpenTable profile link to an www.opentable.com path-only URL. */
function profileLink(restaurant: Record<string, unknown>): string {
  const urls = isRecord(restaurant.urls) ? restaurant.urls : {};
  const profileLink = isRecord(urls.profileLink) ? urls.profileLink : {};
  const link = typeof profileLink.link === "string" ? profileLink.link.trim() : "";
  if (link === "") return "";
  try {
    const url = new URL(link, "https://www.opentable.com");
    if (url.hostname !== "www.opentable.com") return "";
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

/** Project the search SSR state onto the only fields allowed into Node. */
export function sanitizeSearchResults(value: unknown): SafeSearchResults {
  if (!isRecord(value)) throw new Error("Search result was not an object");
  const multiSearch = isRecord(value.multiSearch) ? value.multiSearch : {};
  const rawRestaurants = multiSearch.restaurants;
  if (!Array.isArray(rawRestaurants)) {
    throw new Error("Search response did not contain a restaurant list");
  }
  const results = rawRestaurants
    .filter(isRecord)
    .map((restaurant) => {
      const restaurantId =
        typeof restaurant.restaurantId === "number"
          ? String(restaurant.restaurantId)
          : typeof restaurant.restaurantId === "string"
            ? restaurant.restaurantId
            : "";
      const name = plainText(restaurant.name) ?? "";
      const cuisine =
        isRecord(restaurant.primaryCuisine) &&
        typeof restaurant.primaryCuisine.name === "string"
          ? plainText(restaurant.primaryCuisine.name)
          : undefined;
      const metro =
        isRecord(restaurant.metro) && typeof restaurant.metro.name === "string"
          ? plainText(restaurant.metro.name)
          : undefined;
      const priceBand =
        typeof restaurant.priceBand === "string"
          ? plainText(restaurant.priceBand)
          : undefined;
      return {
        restaurantId,
        name,
        profileUrl: profileLink(restaurant),
        bookable:
          typeof restaurant.type === "string" ? restaurant.type !== "Listing" : true,
        ...(cuisine === undefined ? {} : { cuisine }),
        ...(metro === undefined ? {} : { metro }),
        ...(priceBand === undefined ? {} : { priceBand }),
      };
    })
    .filter(
      (result) =>
        result.restaurantId !== "" && result.name !== "" && result.profileUrl !== "",
    )
    .slice(0, 30);
  return SafeSearchResultsSchema.parse({ results });
}

function availabilityVariables(request: ReturnType<typeof FindSlotsRequestPayloadSchema.parse>): Record<string, unknown> {
  return {
    restaurantIds: [request.restaurantId],
    date: request.date,
    time: request.time,
    partySize: request.partySize,
    databaseRegion: request.databaseRegion,
  };
}

function queryAvailability(request: ReturnType<typeof FindSlotsRequestPayloadSchema.parse>): Promise<SafeAvailabilityData> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(new Error("RestaurantsAvailability page operation timed out"));
    }, PAGE_TIMEOUT_MS);
    const listener = (event: MessageEvent<unknown>): void => {
      if (event.source !== window || !isRecord(event.data)) return;
      if (event.data.marker !== RESPONSE_MARKER || event.data.id !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", listener);
      if (event.data.ok !== true) {
        reject(new Error(typeof event.data.error === "string" ? event.data.error : "Availability operation failed"));
        return;
      }
      try {
        if (
          isRecord(event.data.result) &&
          Array.isArray(event.data.result.errors) &&
          event.data.result.errors.length > 0
        ) {
          reject(new Error("RestaurantsAvailability returned provider errors"));
          return;
        }
        const result = isRecord(event.data.result) && "data" in event.data.result
          ? event.data.result.data
          : event.data.result;
        resolve(sanitizeAvailabilityResult(result, request.restaurantId));
      } catch (error) {
        reject(error);
      }
    };
    window.addEventListener("message", listener);
    window.postMessage(
      { marker: REQUEST_MARKER, id, variables: availabilityVariables(request) },
      window.location.origin,
    );
  });
}

function plainText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutControls = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("");
  const sanitized = withoutControls
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
  return sanitized === "" ? undefined : sanitized;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function currencyCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z]{3}$/u.test(value)
    ? value
    : undefined;
}

/** Project booking-details SSR state onto the only fields allowed into Node. */
export function sanitizeBookingPreviewResult(
  value: unknown,
  request: ReturnType<typeof BookingPreviewRequestPayloadSchema.parse>,
): SafeBookingPreviewData {
  if (!isRecord(value) || !isRecord(value.detailsState) || !isRecord(value.selectedDiningArea)) {
    throw new Error("Booking details result did not include exact dining-area evidence");
  }
  const selectedDiningArea = value.selectedDiningArea;
  const selectedOption = DiningAreaOptionSchema.parse(selectedDiningArea.option);
  if (JSON.stringify(selectedOption) !== JSON.stringify(request.diningArea)) {
    throw new Error("BOOKING_PREVIEW_DINING_AREA_MISMATCH: Exact dining-area evidence changed");
  }
  const detailsState = value.detailsState;
  const root = isRecord(detailsState.state) ? detailsState.state : detailsState;
  const restaurant = isRecord(root.restaurant) ? root.restaurant : {};
  const timeSlot = isRecord(root.timeSlot) ? root.timeSlot : {};
  const rawReservationDateTime = root.reservationDateTime;
  const reservationDateTime =
    typeof rawReservationDateTime === "string"
      ? rawReservationDateTime
      : isRecord(rawReservationDateTime) &&
          typeof rawReservationDateTime.reservationDate === "string" &&
          typeof rawReservationDateTime.reservationTime === "string"
        ? `${rawReservationDateTime.reservationDate}T${rawReservationDateTime.reservationTime}`
        : undefined;
  const messages = isRecord(root.messages) ? root.messages : {};
  const cancellationPolicyMessage = isRecord(messages.cancellationPolicyMessage)
    ? messages.cancellationPolicyMessage
    : {};
  const cancellationMessageRecord = isRecord(
    cancellationPolicyMessage.cancellationMessage,
  )
    ? cancellationPolicyMessage.cancellationMessage
    : {};
  const depositMessageRecord = isRecord(cancellationPolicyMessage.depositMessage)
    ? cancellationPolicyMessage.depositMessage
    : {};
  const termsRecord = isRecord(messages.termsAndConditions)
    ? messages.termsAndConditions
    : {};
  const creditCardDayMessage = Array.isArray(messages.creditCardDayMessage)
    ? messages.creditCardDayMessage.find(isRecord)
    : undefined;

  const diningAreas = Array.isArray(timeSlot.diningAreasBySeating)
    ? timeSlot.diningAreasBySeating.filter(isRecord)
    : [];
  const validDiningAreas = diningAreas.filter(
    (area) =>
      typeof area.diningAreaId === "number" &&
      Number.isInteger(area.diningAreaId) &&
      area.diningAreaId > 0 &&
      stringValue(area.tableCategory) !== undefined,
  );
  if (validDiningAreas.length === 0) {
    throw new Error(
      "BOOKING_PREVIEW_SEATING_UNKNOWN: Provider response did not independently establish seating",
    );
  }
  const matchingDiningAreas = validDiningAreas.filter((area) =>
    Number(area.diningAreaId) === Number(selectedDiningArea.providerId),
  );
  if (matchingDiningAreas.length === 0) {
    throw new Error(
      "BOOKING_PREVIEW_DINING_AREA_MISMATCH: Requested dining area was absent from the provider response",
    );
  }
  if (matchingDiningAreas.length > 1) {
    throw new Error(
      "BOOKING_PREVIEW_DINING_AREA_AMBIGUOUS: Provider identity appeared more than once",
    );
  }
  const diningArea = matchingDiningAreas[0]!;
  const actualProviderSeating = String(diningArea.tableCategory);

  let experience: SafeBookingPreviewData["experience"];
  if (request.reservationKind.kind === "experience") {
    const requestedExperienceId = request.reservationKind.experienceId;
    const experiencesRoot = isRecord(root.experiences) ? root.experiences : {};
    const experiences = Array.isArray(experiencesRoot.experiences)
      ? experiencesRoot.experiences.filter(isRecord)
      : [];
    const selected = experiences.find(
      (item) => String(item.experienceId ?? "") === requestedExperienceId,
    );
    if (selected !== undefined && typeof selected.name === "string") {
      const policies = isRecord(selected.bookingPolicies)
        ? selected.bookingPolicies
        : {};
      const nestedPolicies = isRecord(policies.bookingPolicies)
        ? policies.bookingPolicies
        : {};
      const customPolicies = isRecord(nestedPolicies.customPolicies)
        ? nestedPolicies.customPolicies
        : {};
      const priceInfo = isRecord(selected.priceInfo) ? selected.priceInfo : {};
      experience = {
        id: selected.experienceId as string | number,
        name: selected.name,
        ...(stringValue(selected.typeEnum ?? selected.type) === undefined
          ? {}
          : { type: stringValue(selected.typeEnum ?? selected.type)! }),
        ...(plainText(customPolicies.message ?? selected.description) === undefined
          ? {}
          : { summary: plainText(customPolicies.message ?? selected.description)! }),
        ...(typeof selected.pricePerCover === "number"
          ? { pricePerCover: selected.pricePerCover }
          : {}),
        ...(currencyCode(priceInfo.currencyCode ?? selected.currencyCode) === undefined
          ? {}
          : { currencyCode: currencyCode(priceInfo.currencyCode ?? selected.currencyCode)! }),
      };
    }
  }

  const explicitCurrency = currencyCode(
    root.currencyCode ??
      restaurant.currencyCode ??
      restaurant.currency ??
      experience?.currencyCode,
  );
  const cancellationMessage = plainText(
    cancellationMessageRecord.message ?? creditCardDayMessage?.message,
  );
  const depositMessage = plainText(depositMessageRecord.message);
  const termsMessage = plainText(termsRecord.message);
  const strongAuthenticationRequired =
    typeof timeSlot.strongAuthenticationRequired === "boolean"
      ? timeSlot.strongAuthenticationRequired
      : undefined;

  return SafeBookingPreviewDataSchema.parse({
    restaurantId: restaurant.restaurantId,
    ...(plainText(restaurant.name) === undefined
      ? {}
      : { restaurantName: plainText(restaurant.name)! }),
    reservationDateTime,
    partySize: root.partySize,
    seatingType: actualProviderSeating,
    ...(stringValue(timeSlot.reservationType) === undefined
      ? {}
      : { reservationType: stringValue(timeSlot.reservationType)! }),
    ...(typeof timeSlot.creditCardRequired === "boolean"
      ? { creditCardRequired: timeSlot.creditCardRequired }
      : {}),
    ...(stringValue(timeSlot.creditCardPolicyType) === undefined
      ? {}
      : { creditCardPolicyType: stringValue(timeSlot.creditCardPolicyType)! }),
    ...(typeof timeSlot.creditCardDeposit === "number"
      ? { creditCardDepositAmount: timeSlot.creditCardDeposit }
      : {}),
    ...(explicitCurrency === undefined ? {} : { currencyCode: explicitCurrency }),
    ...(cancellationMessage === undefined ? {} : { cancellationMessage }),
    ...(depositMessage === undefined ? {} : { depositMessage }),
    ...(termsMessage === undefined ? {} : { termsMessage }),
    ...(strongAuthenticationRequired === undefined
      ? {}
      : { strongAuthenticationRequired }),
    diningArea: {
      ...selectedOption,
    },
    ...(experience === undefined ? {} : { experience }),
  });
}

function queryBookingPreview(
  request: ReturnType<typeof BookingPreviewRequestPayloadSchema.parse>,
): Promise<SafeBookingPreviewData> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(new Error("Booking details page operation timed out"));
    }, PAGE_TIMEOUT_MS);
    const listener = (event: MessageEvent<unknown>): void => {
      if (event.source !== window || !isRecord(event.data)) return;
      if (event.data.marker !== PREVIEW_RESPONSE_MARKER || event.data.id !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", listener);
      if (event.data.ok !== true) {
        reject(
          new Error(
            typeof event.data.error === "string"
              ? event.data.error
              : "Booking preview operation failed",
          ),
        );
        return;
      }
      try {
        resolve(sanitizeBookingPreviewResult(event.data.result, request));
      } catch (error) {
        reject(error);
      }
    };
    window.addEventListener("message", listener);
    window.postMessage(
      { marker: PREVIEW_REQUEST_MARKER, id, request },
      window.location.origin,
    );
  });
}

function queryDiningAreas(
  request: ReturnType<typeof ListDiningAreasRequestPayloadSchema.parse>,
): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(new Error("Dining-area discovery timed out"));
    }, PAGE_TIMEOUT_MS);
    const listener = (event: MessageEvent<unknown>): void => {
      if (event.source !== window || !isRecord(event.data)) return;
      if (event.data.marker !== DINING_AREAS_RESPONSE_MARKER || event.data.id !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", listener);
      if (event.data.ok !== true) {
        reject(new Error(typeof event.data.error === "string" ? event.data.error : "Dining-area discovery failed"));
        return;
      }
      try {
        const result = isRecord(event.data.result) ? event.data.result.candidates : undefined;
        resolve({ candidates: SafeDiningAreaCandidatesSchema.parse(result) });
      } catch (error) {
        reject(error);
      }
    };
    window.addEventListener("message", listener);
    window.postMessage({ marker: DINING_AREAS_REQUEST_MARKER, id, request }, window.location.origin);
  });
}

function queryRestaurants(
  request: ReturnType<typeof SearchRestaurantsRequestPayloadSchema.parse>,
): Promise<SafeSearchResults> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(new Error("Restaurant search timed out"));
    }, PAGE_TIMEOUT_MS);
    const listener = (event: MessageEvent<unknown>): void => {
      if (event.source !== window || !isRecord(event.data)) return;
      if (event.data.marker !== SEARCH_RESPONSE_MARKER || event.data.id !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", listener);
      if (event.data.ok !== true) {
        reject(new Error(typeof event.data.error === "string" ? event.data.error : "Restaurant search failed"));
        return;
      }
      try {
        resolve(sanitizeSearchResults(event.data.result));
      } catch (error) {
        reject(error);
      }
    };
    window.addEventListener("message", listener);
    window.postMessage({ marker: SEARCH_REQUEST_MARKER, id, request }, window.location.origin);
  });
}

function controlledPageOperation(
  requestMarker: string,
  responseMarker: string,
  payload: Record<string, unknown>,
  options: {
    readonly operationId?: string | undefined;
    readonly deadlineEpochMs?: number | undefined;
    readonly timeoutMessage?: string;
    readonly abandonLockOnTimeout?: boolean;
    readonly orphanPreparedHandleOnTimeout?: string | undefined;
  } = {},
): Promise<unknown> {
  const id = options.operationId ?? crypto.randomUUID();
  const deadlineEpochMs = options.deadlineEpochMs ?? Date.now() + PAGE_TIMEOUT_MS;
  const timeoutMs = Math.max(1, deadlineEpochMs - Date.now());
  return new Promise((resolve, reject) => {
    let latestLockStage: LockTelemetryStage | undefined;
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", listener);
      if (options.abandonLockOnTimeout === true) {
        window.postMessage({ marker: ABANDON_LOCK_MARKER, id }, window.location.origin);
      }
      if (options.orphanPreparedHandleOnTimeout !== undefined) {
        window.postMessage(
          { marker: ABANDON_PREPARED_MARKER, preparedHandle: options.orphanPreparedHandleOnTimeout },
          window.location.origin,
        );
      }
      const timeoutMessage = options.abandonLockOnTimeout === true
        ? `${classifyInterruptedLock(latestLockStage)}: Lock page operation reached its deadline`
        : options.timeoutMessage ?? "Controlled booking operation reached its deadline";
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    const listener = (event: MessageEvent<unknown>): void => {
      if (event.source !== window || !isRecord(event.data)) return;
      if (event.data.marker === LOCK_PROGRESS_MARKER && event.data.id === id) {
        const progress = LockProgressSchema.safeParse({
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          id,
          type: "LOCK_PROGRESS",
          stage: event.data.stage,
          elapsedMs: event.data.elapsedMs,
          ...(typeof event.data.outcome === "string" ? { outcome: event.data.outcome } : {}),
        });
        if (progress.success) {
          latestLockStage = progress.data.stage;
          void chrome.runtime.sendMessage({ type: "OTB_LOCK_PROGRESS", progress: progress.data })
            .catch(() => undefined);
        }
        return;
      }
      if (event.data.marker !== responseMarker || event.data.id !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", listener);
      if (event.data.ok !== true) {
        reject(new Error(typeof event.data.error === "string" ? event.data.error : "Controlled booking operation failed"));
      } else resolve(event.data.result);
    };
    window.addEventListener("message", listener);
    window.postMessage({ marker: requestMarker, id, ...payload }, window.location.origin);
  });
}

async function authorizeControlledBooking(message: InternalMessage): Promise<unknown> {
  const request = BookingIntentSchema.parse(message.request);
  const result = await controlledPageOperation(
    AUTHORIZE_REQUEST_MARKER,
    AUTHORIZE_RESPONSE_MARKER,
    { request },
  );
  const parsed = AuthorizeBookingResultSchema.omit({ protocolVersion: true, id: true, type: true }).parse(result);
  return parsed;
}

async function lockControlledSlot(message: InternalMessage): Promise<unknown> {
  const request = BookingIntentSchema.parse(message.request);
  const authorizationHandle = typeof message.authorizationHandle === "string"
    ? message.authorizationHandle
    : "";
  const raw = await controlledPageOperation(
    LOCK_REQUEST_MARKER,
    LOCK_RESPONSE_MARKER,
    { request, authorizationHandle, deadlineEpochMs: message.deadlineEpochMs },
    {
      operationId: typeof message.operationId === "string" ? message.operationId : undefined,
      deadlineEpochMs: typeof message.deadlineEpochMs === "number" ? message.deadlineEpochMs : undefined,
      abandonLockOnTimeout: true,
    },
  );
  const result = { outcome: isRecord(raw) ? raw.outcome : undefined };
  return LockSlotResultSchema.omit({ protocolVersion: true, id: true, type: true }).parse(result);
}

async function acknowledgeControlledLock(message: InternalMessage): Promise<unknown> {
  const operationId = typeof message.operationId === "string" ? message.operationId : "";
  const preparedHandle = typeof message.preparedHandle === "string" ? message.preparedHandle : "";
  const result = await controlledPageOperation(
    ACK_LOCK_REQUEST_MARKER,
    ACK_LOCK_RESPONSE_MARKER,
    { operationId, preparedHandle },
    { deadlineEpochMs: typeof message.deadlineEpochMs === "number" ? message.deadlineEpochMs : undefined },
  );
  return AcknowledgeLockResultSchema.omit({ protocolVersion: true, id: true, type: true }).parse(result);
}

async function revalidateControlledBooking(message: InternalMessage): Promise<unknown> {
  const request = BookingIntentSchema.parse(message.request);
  const preparedHandle = typeof message.preparedHandle === "string" ? message.preparedHandle : "";
  const raw = await controlledPageOperation(
    REVALIDATE_REQUEST_MARKER,
    REVALIDATE_RESPONSE_MARKER,
    { request, preparedHandle, deadlineEpochMs: message.deadlineEpochMs },
    {
      deadlineEpochMs: typeof message.deadlineEpochMs === "number" ? message.deadlineEpochMs : undefined,
      timeoutMessage: "REVALIDATION_OUTCOME_UNKNOWN: Post-lock revalidation reached its deadline",
      orphanPreparedHandleOnTimeout: preparedHandle,
    },
  );
  if (!isRecord(raw)) throw new Error("Malformed post-lock revalidation result");
  const previewRequest = BookingPreviewRequestPayloadSchema.parse({
    slotId: request.slotId,
    previewReference: request.previewReference,
    restaurantId: request.restaurantId,
    date: request.date,
    time: request.time,
    partySize: request.partySize,
    seatingType: request.seatingType,
    diningArea: request.diningArea,
    reservationKind: request.reservationKind,
  });
  const result = {
    preparedHandle,
    request,
    postLockData: sanitizeBookingPreviewResult(raw.postLockState, previewRequest),
  };
  return RevalidatePreparedBookingResultSchema.omit({ protocolVersion: true, id: true, type: true }).parse({
    preparedHandle: result.preparedHandle,
    request: result.request,
    data: result.postLockData,
  });
}

async function submitControlledReservation(message: InternalMessage): Promise<unknown> {
  const request = BookingIntentSchema.parse(message.request);
  const preparedHandle = typeof message.preparedHandle === "string" ? message.preparedHandle : "";
  const result = await controlledPageOperation(
    SUBMIT_REQUEST_MARKER,
    SUBMIT_RESPONSE_MARKER,
    { request, preparedHandle },
    {
      deadlineEpochMs: typeof message.deadlineEpochMs === "number" ? message.deadlineEpochMs : undefined,
      timeoutMessage: "SUBMISSION_OUTCOME_UNKNOWN: Submission did not return before the page deadline; do not retry",
    },
  );
  return SubmitReservationResultSchema.shape.result.parse(result);
}

function errorResponse(error: unknown): { readonly ok: false; readonly error: string } {
  return { ok: false, error: error instanceof Error ? error.message.slice(0, 700) : "Page operation failed" };
}

function classifiedPageFailure(): { readonly ok: false; readonly error: string; readonly pageKind: OpenTablePageKind } | undefined {
  const classification = classifyOpenTablePage(collectPageEvidence());
  if (
    classification.kind === OpenTablePageKind.NORMAL ||
    classification.kind === OpenTablePageKind.AUTHENTICATED
  ) {
    return undefined;
  }
  return { ok: false, error: classification.reason, pageKind: classification.kind };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage !== undefined) {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (
      !isRecord(message) ||
      (message.type !== "OTB_AUTH_STATUS" &&
        message.type !== "OTB_FIND_SLOTS" &&
        message.type !== "OTB_LIST_DINING_AREAS" &&
        message.type !== "OTB_SEARCH_RESTAURANTS" &&
        message.type !== "OTB_GET_BOOKING_PREVIEW" &&
        message.type !== "OTB_AUTHORIZE_BOOKING" &&
        message.type !== "OTB_LOCK_SLOT" &&
        message.type !== "OTB_ACKNOWLEDGE_LOCK" &&
        message.type !== "OTB_REVALIDATE_PREPARED_BOOKING" &&
        message.type !== "OTB_ABANDON_LOCK_OPERATION" &&
        message.type !== "OTB_SUBMIT_RESERVATION")
    ) {
      return false;
    }
    const parsed = message as unknown as InternalMessage;
    if (parsed.type === "OTB_ABANDON_LOCK_OPERATION") {
      if (typeof parsed.operationId === "string") {
        window.postMessage(
          { marker: ABANDON_LOCK_MARKER, id: parsed.operationId },
          window.location.origin,
        );
      }
      sendResponse({ ok: true });
      return false;
    }
    if (parsed.type === "OTB_AUTH_STATUS") {
      try {
        const classification = classifyOpenTablePage(collectPageEvidence());
        if (classification.kind === OpenTablePageKind.AUTHENTICATED) sendResponse({ ok: true, status: { authenticated: true } });
        else if (classification.kind === OpenTablePageKind.UNAUTHENTICATED) sendResponse({ ok: true, status: { authenticated: false, reason: "required" } });
        else sendResponse({ ok: false, pageKind: classification.kind, error: classification.reason });
      } catch (error) {
        sendResponse(errorResponse(error));
      }
      return false;
    }
    const pageFailure = classifiedPageFailure();
    if (pageFailure !== undefined) {
      sendResponse(pageFailure);
      return false;
    }
    if (parsed.type === "OTB_LIST_DINING_AREAS") {
      void Promise.resolve(ListDiningAreasRequestPayloadSchema.parse(parsed.request))
        .then(queryDiningAreas)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error: unknown) => sendResponse(errorResponse(error)));
      return true;
    }
    if (parsed.type === "OTB_SEARCH_RESTAURANTS") {
      void Promise.resolve(SearchRestaurantsRequestPayloadSchema.parse(parsed.request))
        .then(queryRestaurants)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error: unknown) => sendResponse(errorResponse(error)));
      return true;
    }
    if (parsed.type === "OTB_AUTHORIZE_BOOKING") {
      void authorizeControlledBooking(parsed)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error: unknown) => sendResponse(errorResponse(error)));
      return true;
    }
    if (parsed.type === "OTB_LOCK_SLOT") {
      void lockControlledSlot(parsed)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error: unknown) => sendResponse(errorResponse(error)));
      return true;
    }
    if (parsed.type === "OTB_ACKNOWLEDGE_LOCK") {
      void acknowledgeControlledLock(parsed)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error: unknown) => sendResponse(errorResponse(error)));
      return true;
    }
    if (parsed.type === "OTB_REVALIDATE_PREPARED_BOOKING") {
      void revalidateControlledBooking(parsed)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error: unknown) => sendResponse(errorResponse(error)));
      return true;
    }
    if (parsed.type === "OTB_SUBMIT_RESERVATION") {
      void submitControlledReservation(parsed)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error: unknown) => sendResponse(errorResponse(error)));
      return true;
    }
    void Promise.resolve()
      .then(() =>
        parsed.type === "OTB_FIND_SLOTS"
          ? FindSlotsRequestPayloadSchema.parse(parsed.request)
          : BookingPreviewRequestPayloadSchema.parse(parsed.request),
      )
      .then(async (request) => ({
        ok: true,
        data:
          parsed.type === "OTB_FIND_SLOTS"
            ? await queryAvailability(
                FindSlotsRequestPayloadSchema.parse(request),
              )
            : await queryBookingPreview(
                BookingPreviewRequestPayloadSchema.parse(request),
              ),
      }))
      .then(sendResponse)
      .catch((error: unknown) => sendResponse(errorResponse(error)));
    return true;
  });

  const announceReady = (): void => {
    if (OpenTablePageUrlSchema.safeParse(location.href).success) {
      void chrome.runtime
        .sendMessage({ type: "OTB_PAGE_READY", pageUrl: sanitizeOpenTablePageUrl(location.href) })
        .catch(() => undefined);
    }
  };
  announceReady();
  window.addEventListener("pageshow", announceReady);
  window.addEventListener("popstate", announceReady);
}
