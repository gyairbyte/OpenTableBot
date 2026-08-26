import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  FindSlotsRequestSchema,
  BookingPreviewRequestPayloadSchema,
  OpenTablePageUrlSchema,
  PairingCodeSchema,
  bridgeUrl,
  parseBridgeMessage,
  sanitizeOpenTablePageUrl,
  type AuthStatusRequest,
  type BridgeMessage,
  type FindSlotsRequest,
  type GetBookingPreviewRequest,
} from "../../src/opentable/bridge/protocol.js";
import { SafeAvailabilityDataSchema } from "../../src/opentable/browser/availability-types.js";
import { SafeBookingPreviewDataSchema } from "../../src/opentable/browser/preview-types.js";
import { OpenTablePageKind } from "../../src/opentable/browser/page-classifier.js";

const STORAGE_CREDENTIAL = "bridgeCredential";
const STORAGE_PORT = "bridgePort";

interface ExtensionState {
  credential?: string;
  port: number;
  socket: WebSocket | undefined;
  authenticated: boolean;
  activeTabId?: number;
  activePageUrl?: string;
  reconnectTimer: number | undefined;
  heartbeatTimer: number | undefined;
}

const state: ExtensionState = {
  port: DEFAULT_BRIDGE_PORT,
  socket: undefined,
  authenticated: false,
  reconnectTimer: undefined,
  heartbeatTimer: undefined,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function send(message: BridgeMessage): void {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
}

function extensionError(
  id: string,
  code:
    | "PAGE_NOT_READY"
    | "PAGE_OPERATION_UNAVAILABLE"
    | "DEADLINE_EXCEEDED"
    | "OPENTABLE_AUTHENTICATION_REQUIRED"
    | "PAGE_CHALLENGE"
    | "ACCESS_CONTROL_RESPONSE"
    | "RATE_LIMITED",
  message: string,
): void {
  send({ protocolVersion: BRIDGE_PROTOCOL_VERSION, id, type: "ERROR", code, message: message.slice(0, 500) });
}

function pageFailureCode(pageKind: unknown):
  | "OPENTABLE_AUTHENTICATION_REQUIRED"
  | "PAGE_CHALLENGE"
  | "ACCESS_CONTROL_RESPONSE"
  | "RATE_LIMITED"
  | "PAGE_OPERATION_UNAVAILABLE" {
  if (pageKind === OpenTablePageKind.UNAUTHENTICATED) return "OPENTABLE_AUTHENTICATION_REQUIRED";
  if (pageKind === OpenTablePageKind.CHALLENGE) return "PAGE_CHALLENGE";
  if (pageKind === OpenTablePageKind.ACCESS_DENIED) return "ACCESS_CONTROL_RESPONSE";
  if (pageKind === OpenTablePageKind.RATE_LIMITED) return "RATE_LIMITED";
  return "PAGE_OPERATION_UNAVAILABLE";
}

function startHeartbeat(): void {
  if (state.heartbeatTimer !== undefined) self.clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = self.setInterval(() => {
    send({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      deadlineEpochMs: Date.now() + DEFAULT_REQUEST_TIMEOUT_MS,
      type: "PING",
    });
  }, 20_000);
}

function announceReady(): void {
  if (!state.authenticated || state.activePageUrl === undefined) return;
  send({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    type: "READY",
    pageUrl: state.activePageUrl,
    pageReady: state.activeTabId !== undefined,
  });
}

async function forwardAuthentication(message: AuthStatusRequest): Promise<void> {
  const tabId = state.activeTabId;
  if (tabId === undefined) {
    extensionError(message.id, "PAGE_NOT_READY", "No eligible OpenTable page is available");
    return;
  }
  if (Date.now() >= message.deadlineEpochMs) {
    extensionError(message.id, "DEADLINE_EXCEEDED", "Authentication request deadline elapsed");
    return;
  }
  try {
    const response: unknown = await chrome.tabs.sendMessage(tabId, { type: "OTB_AUTH_STATUS" });
    if (!isRecord(response) || response.ok !== true || !isRecord(response.status)) {
      const detail = isRecord(response) && typeof response.error === "string" ? response.error : "Page authentication evidence was inconclusive";
      extensionError(message.id, pageFailureCode(isRecord(response) ? response.pageKind : undefined), detail);
      return;
    }
    const status = response.status.authenticated === true
      ? { authenticated: true as const }
      : { authenticated: false as const, reason: "required" as const };
    send({ protocolVersion: BRIDGE_PROTOCOL_VERSION, id: message.id, type: "AUTH_STATUS_RESULT", status });
  } catch (error) {
    extensionError(message.id, "PAGE_OPERATION_UNAVAILABLE", error instanceof Error ? error.message : "Page authentication check failed");
  }
}

async function forwardFindSlots(message: FindSlotsRequest): Promise<void> {
  const tabId = state.activeTabId;
  if (tabId === undefined) {
    extensionError(message.id, "PAGE_NOT_READY", "No eligible OpenTable page is available");
    return;
  }
  if (Date.now() >= message.deadlineEpochMs) {
    extensionError(message.id, "DEADLINE_EXCEEDED", "Availability request deadline elapsed");
    return;
  }
  try {
    const response: unknown = await chrome.tabs.sendMessage(tabId, {
      type: "OTB_FIND_SLOTS",
      request: message.request,
    });
    if (!isRecord(response) || response.ok !== true) {
      const detail = isRecord(response) && typeof response.error === "string" ? response.error : "Availability operation failed";
      extensionError(message.id, pageFailureCode(isRecord(response) ? response.pageKind : undefined), detail);
      return;
    }
    const result = FindSlotsRequestSchema.shape.request.safeParse(message.request);
    const data = SafeAvailabilityDataSchema.safeParse(isRecord(response) ? response.data : undefined);
    if (!result.success || !data.success) {
      extensionError(message.id, "PAGE_OPERATION_UNAVAILABLE", "Availability request failed validation");
      return;
    }
    send({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: message.id,
      type: "FIND_SLOTS_RESULT",
      request: result.data,
      data: data.data,
    });
  } catch (error) {
    extensionError(message.id, "PAGE_OPERATION_UNAVAILABLE", error instanceof Error ? error.message : "Availability operation failed");
  }
}

async function forwardBookingPreview(
  message: GetBookingPreviewRequest,
): Promise<void> {
  const tabId = state.activeTabId;
  if (tabId === undefined) {
    extensionError(message.id, "PAGE_NOT_READY", "No eligible OpenTable page is available");
    return;
  }
  if (Date.now() >= message.deadlineEpochMs) {
    extensionError(message.id, "DEADLINE_EXCEEDED", "Booking preview request deadline elapsed");
    return;
  }
  try {
    const response: unknown = await chrome.tabs.sendMessage(tabId, {
      type: "OTB_GET_BOOKING_PREVIEW",
      request: message.request,
    });
    if (!isRecord(response) || response.ok !== true) {
      const detail =
        isRecord(response) && typeof response.error === "string"
          ? response.error
          : "Booking preview operation failed";
      extensionError(
        message.id,
        pageFailureCode(isRecord(response) ? response.pageKind : undefined),
        detail,
      );
      return;
    }
    const request = BookingPreviewRequestPayloadSchema.safeParse(message.request);
    const data = SafeBookingPreviewDataSchema.safeParse(
      isRecord(response) ? response.data : undefined,
    );
    if (!request.success || !data.success) {
      extensionError(
        message.id,
        "PAGE_OPERATION_UNAVAILABLE",
        "Booking preview response failed validation",
      );
      return;
    }
    send({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: message.id,
      type: "GET_BOOKING_PREVIEW_RESULT",
      request: request.data,
      data: data.data,
    });
  } catch (error) {
    extensionError(
      message.id,
      "PAGE_OPERATION_UNAVAILABLE",
      error instanceof Error ? error.message : "Booking preview operation failed",
    );
  }
}

function handleBridgeMessage(raw: string): void {
  let message: BridgeMessage;
  try {
    message = parseBridgeMessage(raw);
  } catch {
    state.socket?.close(1008, "Malformed bridge message");
    return;
  }
  if (message.type === "HELLO_RESULT") {
    state.authenticated = true;
    startHeartbeat();
    announceReady();
    return;
  }
  if (message.type === "AUTH_STATUS") void forwardAuthentication(message);
  if (message.type === "FIND_SLOTS") void forwardFindSlots(message);
  if (message.type === "GET_BOOKING_PREVIEW") void forwardBookingPreview(message);
}

function scheduleReconnect(): void {
  if (state.credential === undefined || state.reconnectTimer !== undefined) return;
  state.reconnectTimer = self.setTimeout(() => {
    state.reconnectTimer = undefined;
    connect();
  }, 1_500);
}

export function connect(): void {
  if (state.credential === undefined) return;
  if (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
  const socket = new WebSocket(bridgeUrl(state.port));
  state.socket = socket;
  state.authenticated = false;
  socket.addEventListener("open", () => {
    const message: BridgeMessage = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      deadlineEpochMs: Date.now() + DEFAULT_REQUEST_TIMEOUT_MS,
      type: "HELLO",
      role: "extension",
      credential: state.credential!,
    };
    socket.send(JSON.stringify(message));
  });
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") handleBridgeMessage(event.data);
  });
  socket.addEventListener("close", () => {
    if (state.socket === socket) state.socket = undefined;
    state.authenticated = false;
    if (state.heartbeatTimer !== undefined) self.clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = undefined;
    scheduleReconnect();
  });
  socket.addEventListener("error", () => socket.close());
}

async function pair(code: string, port: number): Promise<void> {
  const pairingCode = PairingCodeSchema.parse(code.trim().toUpperCase());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Port must be from 1 through 65535");
  const socket = new WebSocket(bridgeUrl(port));
  const id = crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    const timer = self.setTimeout(() => reject(new Error("Pairing timed out")), DEFAULT_REQUEST_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        id,
        deadlineEpochMs: Date.now() + DEFAULT_REQUEST_TIMEOUT_MS,
        type: "PAIR",
        pairingCode,
      }));
    });
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return;
      try {
        const message = parseBridgeMessage(event.data);
        if (message.id !== id) return;
        self.clearTimeout(timer);
        if (message.type === "ERROR") reject(new Error(message.message));
        else if (message.type === "PAIR_RESULT") {
          void chrome.storage.local
            .set({ [STORAGE_CREDENTIAL]: message.credential, [STORAGE_PORT]: port })
            .then(() => {
              state.credential = message.credential;
              state.port = port;
              resolve();
            }, reject);
        }
      } catch (error) {
        self.clearTimeout(timer);
        reject(error);
      }
    });
    socket.addEventListener("error", () => reject(new Error("Could not reach the local bridge")));
  });
  socket.close(1000, "Pairing complete");
  connect();
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage !== undefined) {
  void chrome.storage.local.get([STORAGE_CREDENTIAL, STORAGE_PORT]).then((stored) => {
    if (typeof stored[STORAGE_CREDENTIAL] === "string") state.credential = stored[STORAGE_CREDENTIAL];
    if (typeof stored[STORAGE_PORT] === "number") state.port = stored[STORAGE_PORT];
    connect();
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isRecord(message) || typeof message.type !== "string") return false;
    if (message.type === "OTB_PAGE_READY" && sender.tab?.id !== undefined && typeof message.pageUrl === "string") {
      if (OpenTablePageUrlSchema.safeParse(message.pageUrl).success) {
        state.activeTabId = sender.tab.id;
        state.activePageUrl = sanitizeOpenTablePageUrl(message.pageUrl);
        announceReady();
      }
      return false;
    }
    if (message.type === "OTB_GET_STATUS") {
      sendResponse({ paired: state.credential !== undefined, connected: state.authenticated, pageReady: state.activeTabId !== undefined });
      return false;
    }
    if (message.type === "OTB_PAIR") {
      const code = typeof message.code === "string" ? message.code : "";
      const port = typeof message.port === "number" ? message.port : DEFAULT_BRIDGE_PORT;
      void pair(code, port)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Pairing failed" }));
      return true;
    }
    return false;
  });
}
