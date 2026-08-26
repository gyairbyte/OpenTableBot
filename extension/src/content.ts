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
  BookingPreviewRequestPayloadSchema,
  OpenTablePageUrlSchema,
  sanitizeOpenTablePageUrl,
} from "../../src/opentable/bridge/protocol.js";

const REQUEST_MARKER = "opentablebot:availability-request";
const RESPONSE_MARKER = "opentablebot:availability-response";
const PAGE_TIMEOUT_MS = 15_000;
const PREVIEW_REQUEST_MARKER = "opentablebot:booking-preview-request";
const PREVIEW_RESPONSE_MARKER = "opentablebot:booking-preview-response";

interface InternalMessage {
  readonly type: "OTB_AUTH_STATUS" | "OTB_FIND_SLOTS" | "OTB_GET_BOOKING_PREVIEW";
  readonly request?: unknown;
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

function providerSeatingType(seatingType: string): string {
  if (seatingType === "standard") return "default";
  if (seatingType === "high-top") return "highTop";
  if (seatingType === "private-dining") return "privateDining";
  return seatingType;
}

function compactProviderSeating(value: string): string {
  return value.toLowerCase().replace(/[\s_-]/gu, "");
}

/** Project booking-details SSR state onto the only fields allowed into Node. */
export function sanitizeBookingPreviewResult(
  value: unknown,
  request: ReturnType<typeof BookingPreviewRequestPayloadSchema.parse>,
): SafeBookingPreviewData {
  if (!isRecord(value)) throw new Error("Booking details state was not an object");
  const root = isRecord(value.state) ? value.state : value;
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
  const expectedProviderSeating = providerSeatingType(request.seatingType);
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
  const matchingDiningAreas = validDiningAreas.filter(
    (area) =>
      compactProviderSeating(String(area.tableCategory)) ===
      compactProviderSeating(expectedProviderSeating),
  );
  if (matchingDiningAreas.length === 0) {
    throw new Error(
      "BOOKING_PREVIEW_SEATING_MISMATCH: Requested seating was absent from the provider response",
    );
  }
  if (matchingDiningAreas.length > 1) {
    throw new Error(
      "BOOKING_PREVIEW_SEATING_AMBIGUOUS: Provider response contained multiple matching dining areas",
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
      id: diningArea.diningAreaId,
      tableCategory: actualProviderSeating,
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

function errorResponse(error: unknown): { readonly ok: false; readonly error: string } {
  return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "Page operation failed" };
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
        message.type !== "OTB_GET_BOOKING_PREVIEW")
    ) {
      return false;
    }
    const parsed = message as unknown as InternalMessage;
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
