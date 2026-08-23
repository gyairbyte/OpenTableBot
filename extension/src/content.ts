import { SafeAvailabilityDataSchema, type SafeAvailabilityData } from "../../src/opentable/browser/availability-types.js";
import {
  OpenTablePageKind,
  classifyOpenTablePage,
  type OpenTablePageEvidence,
} from "../../src/opentable/browser/page-classifier.js";
import {
  FindSlotsRequestPayloadSchema,
  OpenTablePageUrlSchema,
  sanitizeOpenTablePageUrl,
} from "../../src/opentable/bridge/protocol.js";

const REQUEST_MARKER = "opentablebot:availability-request";
const RESPONSE_MARKER = "opentablebot:availability-response";
const PAGE_TIMEOUT_MS = 15_000;

interface InternalMessage {
  readonly type: "OTB_AUTH_STATUS" | "OTB_FIND_SLOTS";
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
    if (!isRecord(message) || (message.type !== "OTB_AUTH_STATUS" && message.type !== "OTB_FIND_SLOTS")) return false;
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
      .then(() => FindSlotsRequestPayloadSchema.parse(parsed.request))
      .then(async (request) => ({ ok: true, data: await queryAvailability(request) }))
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
