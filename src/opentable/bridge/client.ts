import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  LOCK_OPERATION_TIMEOUT_MS,
  type AuthStatusResult,
  type BridgeMessage,
  type ErrorMessage,
  type FindSlotsResult,
  type GetBookingPreviewResult,
  type BookingIntent,
  type AuthorizeBookingResult,
  type LockSlotResult,
  type SubmitReservationResult,
  type AcknowledgeLockResult,
  type RevalidatePreparedBookingResult,
  type LockProgress,
  type Pong,
  bridgeUrl,
  parseBridgeMessage,
} from "./protocol.js";
import { advanceLockStage, classifyInterruptedLock, LockTelemetryStage } from "./lock-lifecycle.js";

interface PendingResponse {
  readonly resolve: (message: BridgeMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly isLock: boolean;
  readonly startedAt: number;
  latestLockStage?: LockProgress["stage"];
}

type ControllerRequestBody =
  | { readonly type: "PING" }
  | { readonly type: "AUTH_STATUS" }
  | { readonly type: "FIND_SLOTS"; readonly request: FindSlotsResult["request"] }
  | { readonly type: "GET_BOOKING_PREVIEW"; readonly request: GetBookingPreviewResult["request"] }
  | { readonly type: "AUTHORIZE_BOOKING"; readonly request: BookingIntent }
  | { readonly type: "LOCK_SLOT"; readonly authorizationHandle: string; readonly request: BookingIntent }
  | { readonly type: "ACKNOWLEDGE_LOCK"; readonly operationId: string; readonly preparedHandle: string }
  | { readonly type: "REVALIDATE_PREPARED_BOOKING"; readonly preparedHandle: string; readonly request: BookingIntent }
  | { readonly type: "SUBMIT_RESERVATION"; readonly preparedHandle: string; readonly request: BookingIntent };

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
  readonly onLockTelemetry?: (event: LockProgress) => void;
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

  async authorizeBooking(request: BookingIntent): Promise<AuthorizeBookingResult> {
    const result = await this.request({ type: "AUTHORIZE_BOOKING", request });
    if (result.type !== "AUTHORIZE_BOOKING_RESULT") {
      throw new Error("Unexpected bridge response to AUTHORIZE_BOOKING");
    }
    return result;
  }

  async lockSlot(
    authorizationHandle: string,
    request: BookingIntent,
  ): Promise<LockSlotResult> {
    const result = await this.request(
      { type: "LOCK_SLOT", authorizationHandle, request },
      LOCK_OPERATION_TIMEOUT_MS,
    );
    if (result.type !== "LOCK_SLOT_RESULT") {
      throw new Error("Unexpected bridge response to LOCK_SLOT");
    }
    return result;
  }

  async acknowledgeLock(
    operationId: string,
    preparedHandle: string,
  ): Promise<AcknowledgeLockResult> {
    const result = await this.request({ type: "ACKNOWLEDGE_LOCK", operationId, preparedHandle });
    if (result.type !== "ACKNOWLEDGE_LOCK_RESULT") {
      throw new Error("Unexpected bridge response to ACKNOWLEDGE_LOCK");
    }
    return result;
  }

  async revalidatePreparedBooking(
    preparedHandle: string,
    request: BookingIntent,
  ): Promise<RevalidatePreparedBookingResult> {
    const result = await this.request({ type: "REVALIDATE_PREPARED_BOOKING", preparedHandle, request });
    if (result.type !== "REVALIDATE_PREPARED_BOOKING_RESULT") {
      throw new Error("Unexpected bridge response to REVALIDATE_PREPARED_BOOKING");
    }
    return result;
  }

  async submitReservation(
    preparedHandle: string,
    request: BookingIntent,
  ): Promise<SubmitReservationResult> {
    const result = await this.request({ type: "SUBMIT_RESERVATION", preparedHandle, request });
    if (result.type !== "SUBMIT_RESERVATION_RESULT") {
      throw new Error("Unexpected bridge response to SUBMIT_RESERVATION");
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
    body: ControllerRequestBody,
    timeoutMs = this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<BridgeMessage> {
    await this.connect();
    return this.requestWithoutConnect(body, timeoutMs);
  }

  private requestWithoutConnect(
    body:
      | { readonly type: "HELLO"; readonly role: "controller"; readonly credential: string }
      | ControllerRequestBody,
    timeoutMs = this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<BridgeMessage> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Bridge is not connected"));
    }
    const id = randomUUID();
    const message = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id,
      deadlineEpochMs: Date.now() + timeoutMs,
      ...body,
    } satisfies BridgeMessage;
    return new Promise<BridgeMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (body.type === "LOCK_SLOT") {
          const outcome = classifyInterruptedLock(pending?.latestLockStage);
          reject(new BridgeClientError(outcome, `${outcome}: lock operation reached its coherent deadline`));
        } else {
          reject(new BridgeClientError("DEADLINE_EXCEEDED", "Bridge request timed out"));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, isLock: body.type === "LOCK_SLOT", startedAt: Date.now() });
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
    if (message.type === "LOCK_PROGRESS") {
      pending.latestLockStage = advanceLockStage(pending.latestLockStage, message.stage);
      this.options.onLockTelemetry?.(message);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.type === "ERROR") {
      pending.reject(new BridgeClientError(message.code, message.message));
    } else {
      if (message.type === "LOCK_SLOT_RESULT") {
        if (
          message.outcome.status === "LOCK_CONFIRMED" &&
          message.outcome.operationId !== message.id
        ) {
          pending.reject(new BridgeClientError("MALFORMED_MESSAGE", "Lock result correlation ID changed"));
          return;
        }
        this.options.onLockTelemetry?.({
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          id: message.id,
          type: "LOCK_PROGRESS",
          stage: LockTelemetryStage.RESPONSE_RECEIVED_BY_NODE,
          elapsedMs: Math.max(0, Date.now() - pending.startedAt),
          outcome: message.outcome.status,
        });
      }
      pending.resolve(message);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.isLock && !(error instanceof BridgeClientError)) {
        const outcome = classifyInterruptedLock(pending.latestLockStage);
        pending.reject(new BridgeClientError(outcome, `${outcome}: bridge connection closed during lock`));
      } else pending.reject(error);
    }
    this.pending.clear();
  }
}
