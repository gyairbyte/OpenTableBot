import { timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  ErrorMessageSchema,
  type BridgeMessage,
  type ErrorMessage,
  type Ready,
  parseBridgeMessage,
} from "./protocol.js";

interface ConnectionState {
  authenticated: boolean;
  role?: "extension" | "controller";
}

interface PendingRequest {
  readonly controller: WebSocket;
  readonly timer: NodeJS.Timeout;
}

export interface BridgeServerOptions {
  readonly credential: string;
  readonly host?: typeof DEFAULT_BRIDGE_HOST;
  readonly port?: number;
  readonly pairing?: { readonly code: string; readonly expiresAt: number };
  readonly onPairingConsumed?: () => void;
  readonly onStatus?: (message: string) => void;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function send(socket: WebSocket, message: BridgeMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function errorMessage(id: string, code: ErrorMessage["code"], message: string): ErrorMessage {
  return ErrorMessageSchema.parse({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    id,
    type: "ERROR",
    code,
    message,
  });
}

export class OpenTableBridgeServer {
  private server: WebSocketServer | undefined;
  private readonly states = new Map<WebSocket, ConnectionState>();
  private readonly pending = new Map<string, PendingRequest>();
  private extension: WebSocket | undefined;
  private ready: Ready | undefined;
  private pairingConsumed = false;

  constructor(private readonly options: BridgeServerOptions) {
    if ((options.host ?? DEFAULT_BRIDGE_HOST) !== DEFAULT_BRIDGE_HOST) {
      throw new Error("The OpenTable bridge may bind only to 127.0.0.1");
    }
  }

  async start(): Promise<number> {
    if (this.server !== undefined) throw new Error("Bridge is already running");
    const server = new WebSocketServer({
      host: DEFAULT_BRIDGE_HOST,
      port: this.options.port ?? DEFAULT_BRIDGE_PORT,
    });
    this.server = server;
    server.on("connection", (socket) => {
      this.states.set(socket, { authenticated: false });
      socket.on("message", (raw) => this.receive(socket, raw));
      socket.on("close", () => this.disconnect(socket));
      socket.on("error", () => this.disconnect(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("Bridge did not expose a TCP port");
    }
    this.options.onStatus?.(`Bridge listening on ${DEFAULT_BRIDGE_HOST}:${address.port}`);
    return address.port;
  }

  async close(): Promise<void> {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    for (const socket of this.states.keys()) socket.close(1001, "Bridge stopping");
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private receive(socket: WebSocket, raw: RawData): void {
    let message: BridgeMessage;
    try {
      message = parseBridgeMessage(raw.toString());
    } catch {
      send(socket, errorMessage("malformed-message", "MALFORMED_MESSAGE", "Message failed protocol validation"));
      socket.close(1008, "Malformed message");
      return;
    }

    const state = this.states.get(socket);
    if (state === undefined) return;
    if (!state.authenticated) {
      this.authenticate(socket, state, message);
      return;
    }
    if (state.role === "extension") this.fromExtension(socket, message);
    else this.fromController(socket, message);
  }

  private authenticate(socket: WebSocket, state: ConnectionState, message: BridgeMessage): void {
    if (
      (message.type === "PAIR" || message.type === "HELLO") &&
      message.deadlineEpochMs <= Date.now()
    ) {
      send(socket, errorMessage(message.id, "DEADLINE_EXCEEDED", "Authentication request deadline elapsed"));
      socket.close(1008, "Deadline elapsed");
      return;
    }
    if (message.type === "PAIR") {
      const pairing = this.options.pairing;
      const valid =
        pairing !== undefined &&
        !this.pairingConsumed &&
        Date.now() <= pairing.expiresAt &&
        constantTimeEqual(message.pairingCode, pairing.code);
      if (!valid) {
        send(socket, errorMessage(message.id, "PAIRING_FAILED", "Pairing code is invalid or expired"));
        socket.close(1008, "Pairing failed");
        return;
      }
      this.pairingConsumed = true;
      send(socket, {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        id: message.id,
        type: "PAIR_RESULT",
        credential: this.options.credential,
      });
      this.options.onPairingConsumed?.();
      socket.close(1000, "Pairing complete");
      return;
    }

    if (message.type !== "HELLO" || !constantTimeEqual(message.credential, this.options.credential)) {
      const id = "id" in message ? message.id : "authentication-failed";
      send(socket, errorMessage(id, "AUTHENTICATION_FAILED", "Bridge authentication failed"));
      socket.close(1008, "Authentication failed");
      return;
    }
    state.authenticated = true;
    state.role = message.role;
    if (message.role === "extension") {
      if (this.extension !== undefined && this.extension !== socket) {
        this.extension.close(1000, "Replaced by a newer extension connection");
      }
      this.extension = socket;
      this.ready = undefined;
      this.options.onStatus?.("Extension connected");
    }
    send(socket, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: message.id,
      type: "HELLO_RESULT",
      authenticated: true,
    });
  }

  private fromController(socket: WebSocket, message: BridgeMessage): void {
    if (message.type === "PING") {
      const response: BridgeMessage = {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        id: message.id,
        type: "PONG",
        extensionConnected: this.extension?.readyState === WebSocket.OPEN,
        pageReady: this.ready?.pageReady ?? false,
        ...(this.ready === undefined ? {} : { pageUrl: this.ready.pageUrl }),
      };
      send(socket, response);
      return;
    }
    if (message.type !== "AUTH_STATUS" && message.type !== "FIND_SLOTS") {
      send(socket, errorMessage(message.id, "MALFORMED_MESSAGE", "Controller message is not allowed"));
      return;
    }
    if (this.extension?.readyState !== WebSocket.OPEN) {
      send(socket, errorMessage(message.id, "EXTENSION_UNAVAILABLE", "Chrome extension is not connected"));
      return;
    }
    if (this.ready?.pageReady !== true) {
      send(socket, errorMessage(message.id, "PAGE_NOT_READY", "No eligible OpenTable page is ready"));
      return;
    }
    if (this.pending.has(message.id)) {
      send(socket, errorMessage(message.id, "MALFORMED_MESSAGE", "Request ID is already in use"));
      return;
    }
    const delay = Math.max(1, message.deadlineEpochMs - Date.now());
    if (delay <= 1) {
      send(socket, errorMessage(message.id, "DEADLINE_EXCEEDED", "Request deadline has elapsed"));
      return;
    }
    const timer = setTimeout(() => {
      this.pending.delete(message.id);
      send(socket, errorMessage(message.id, "DEADLINE_EXCEEDED", "Chrome request exceeded its deadline"));
    }, delay);
    this.pending.set(message.id, { controller: socket, timer });
    send(this.extension, message);
  }

  private fromExtension(socket: WebSocket, message: BridgeMessage): void {
    if (message.type === "PING") {
      send(socket, {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        id: message.id,
        type: "PONG",
        extensionConnected: true,
        pageReady: this.ready?.pageReady ?? false,
        ...(this.ready === undefined ? {} : { pageUrl: this.ready.pageUrl }),
      });
      return;
    }
    if (message.type === "READY") {
      this.ready = message;
      return;
    }
    if (
      message.type !== "AUTH_STATUS_RESULT" &&
      message.type !== "FIND_SLOTS_RESULT" &&
      message.type !== "ERROR"
    ) {
      send(socket, errorMessage(message.id, "MALFORMED_MESSAGE", "Extension message is not allowed"));
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    send(pending.controller, message);
  }

  private disconnect(socket: WebSocket): void {
    this.states.delete(socket);
    if (this.extension === socket) {
      this.extension = undefined;
      this.ready = undefined;
      this.options.onStatus?.("Extension disconnected");
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        send(pending.controller, errorMessage(id, "EXTENSION_UNAVAILABLE", "Chrome extension disconnected"));
      }
      this.pending.clear();
    }
    for (const [id, pending] of this.pending) {
      if (pending.controller === socket) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
    }
  }
}
