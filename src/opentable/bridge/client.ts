import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type AuthStatusResult,
  type BridgeMessage,
  type ErrorMessage,
  type FindSlotsResult,
  type GetBookingPreviewResult,
  type Pong,
  bridgeUrl,
  parseBridgeMessage,
} from "./protocol.js";

interface PendingResponse {
  readonly resolve: (message: BridgeMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class BridgeClientError extends Error {
  constructor(
    readonly code: ErrorMessage["code"],
    message: string,
  ) {
    super(message);
    this.name = "BridgeClientError";
  }
}

export interface BridgeClientOptions {
  readonly credential: string;
  readonly port?: number;
  readonly timeoutMs?: number;
}

export class OpenTableBridgeClient {
  private socket: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingResponse>();

  constructor(private readonly options: BridgeClientOptions) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting !== undefined) return this.connecting;
    this.connecting = this.open();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  close(): void {
    this.socket?.close(1000, "Controller finished");
    this.socket = undefined;
    this.failAll(new Error("Bridge client closed"));
  }

  async ping(): Promise<Pong> {
    const result = await this.request({ type: "PING" });
    if (result.type !== "PONG") throw new Error("Unexpected bridge response to PING");
    return result;
  }

  async authenticationStatus(): Promise<AuthStatusResult["status"]> {
    const result = await this.request({ type: "AUTH_STATUS" });
    if (result.type !== "AUTH_STATUS_RESULT") {
      throw new Error("Unexpected bridge response to AUTH_STATUS");
    }
    return result.status;
  }

  async findSlots(request: FindSlotsResult["request"]): Promise<FindSlotsResult> {
    const result = await this.request({ type: "FIND_SLOTS", request });
    if (result.type !== "FIND_SLOTS_RESULT") {
      throw new Error("Unexpected bridge response to FIND_SLOTS");
    }
    return result;
  }

  async getBookingPreview(
    request: GetBookingPreviewResult["request"],
  ): Promise<GetBookingPreviewResult> {
    const result = await this.request({ type: "GET_BOOKING_PREVIEW", request });
    if (result.type !== "GET_BOOKING_PREVIEW_RESULT") {
      throw new Error("Unexpected bridge response to GET_BOOKING_PREVIEW");
    }
    return result;
  }

  private async open(): Promise<void> {
    const socket = new WebSocket(bridgeUrl(this.options.port ?? DEFAULT_BRIDGE_PORT));
    this.socket = socket;
    socket.on("message", (raw) => this.receive(raw));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.failAll(new Error("Bridge connection closed"));
    });
    socket.on("error", (error) => {
      if (this.socket === socket) this.failAll(error);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const result = await this.requestWithoutConnect({
      type: "HELLO",
      role: "controller",
      credential: this.options.credential,
    });
    if (result.type !== "HELLO_RESULT") throw new Error("Bridge HELLO failed");
  }

  private async request(
    body:
      | { readonly type: "PING" }
      | { readonly type: "AUTH_STATUS" }
      | { readonly type: "FIND_SLOTS"; readonly request: FindSlotsResult["request"] }
      | {
          readonly type: "GET_BOOKING_PREVIEW";
          readonly request: GetBookingPreviewResult["request"];
        },
  ): Promise<BridgeMessage> {
    await this.connect();
    return this.requestWithoutConnect(body);
  }

  private requestWithoutConnect(
    body:
      | { readonly type: "HELLO"; readonly role: "controller"; readonly credential: string }
      | { readonly type: "PING" }
      | { readonly type: "AUTH_STATUS" }
      | { readonly type: "FIND_SLOTS"; readonly request: FindSlotsResult["request"] }
      | {
          readonly type: "GET_BOOKING_PREVIEW";
          readonly request: GetBookingPreviewResult["request"];
        },
  ): Promise<BridgeMessage> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Bridge is not connected"));
    }
    const id = randomUUID();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const message = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id,
      deadlineEpochMs: Date.now() + timeoutMs,
      ...body,
    } satisfies BridgeMessage;
    return new Promise<BridgeMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeClientError("DEADLINE_EXCEEDED", "Bridge request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify(message));
    });
  }

  private receive(raw: RawData): void {
    let message: BridgeMessage;
    try {
      message = parseBridgeMessage(raw.toString());
    } catch {
      this.failAll(new BridgeClientError("MALFORMED_MESSAGE", "Bridge returned a malformed message"));
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.type === "ERROR") {
      pending.reject(new BridgeClientError(message.code, message.message));
    } else {
      pending.resolve(message);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
