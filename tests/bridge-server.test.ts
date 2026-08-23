import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { OpenTableBridgeClient, BridgeClientError } from "../src/opentable/bridge/client.js";
import { generateCredential } from "../src/opentable/bridge/credential-store.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeMessage,
  parseBridgeMessage,
} from "../src/opentable/bridge/protocol.js";
import { OpenTableBridgeServer } from "../src/opentable/bridge/server.js";

const servers: OpenTableBridgeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function rawRequest(port: number, message: BridgeMessage): Promise<BridgeMessage> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once("open", () => socket.send(JSON.stringify(message)));
    socket.once("message", (raw: RawData) => {
      try {
        resolve(parseBridgeMessage(raw.toString()));
      } catch (error) {
        reject(error);
      } finally {
        socket.close();
      }
    });
    socket.once("error", reject);
  });
}

function rawStringRequest(port: number, message: string): Promise<BridgeMessage> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once("open", () => socket.send(message));
    socket.once("message", (raw: RawData) => {
      try {
        resolve(parseBridgeMessage(raw.toString()));
      } catch (error) {
        reject(error);
      } finally {
        socket.close();
      }
    });
    socket.once("error", reject);
  });
}

function connectReadyExtension(port: number, credential: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once("open", () => {
      socket.send(JSON.stringify({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        id: "extension-hello",
        deadlineEpochMs: Date.now() + 1_000,
        type: "HELLO",
        role: "extension",
        credential,
      }));
    });
    socket.on("message", (raw: RawData) => {
      try {
        const message = parseBridgeMessage(raw.toString());
        if (message.type !== "HELLO_RESULT") return;
        socket.send(JSON.stringify({
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          id: "extension-ready",
          type: "READY",
          pageUrl: "https://www.opentable.com/s",
          pageReady: true,
        }));
        resolve(socket);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

describe("loopback bridge server", () => {
  it("pairs once without logging or exposing the long credential in status", async () => {
    const credential = generateCredential();
    const logs: string[] = [];
    const server = new OpenTableBridgeServer({
      credential,
      port: 0,
      pairing: { code: "ABCDEFGH", expiresAt: Date.now() + 5_000 },
      onStatus: (message) => logs.push(message),
    });
    servers.push(server);
    const port = await server.start();
    const first = await rawRequest(port, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: "pair-request-one",
      deadlineEpochMs: Date.now() + 1_000,
      type: "PAIR",
      pairingCode: "ABCDEFGH",
    });
    expect(first).toMatchObject({ type: "PAIR_RESULT", credential });
    const second = await rawRequest(port, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: "pair-request-two",
      deadlineEpochMs: Date.now() + 1_000,
      type: "PAIR",
      pairingCode: "ABCDEFGH",
    });
    expect(second).toMatchObject({ type: "ERROR", code: "PAIRING_FAILED" });
    expect(logs.join("\n")).not.toContain(credential);
  });

  it("refuses any non-loopback bind configuration", () => {
    expect(
      () =>
        new OpenTableBridgeServer({
          credential: generateCredential(),
          host: "0.0.0.0" as "127.0.0.1",
        }),
    ).toThrow("127.0.0.1");
  });

  it("rejects malformed unauthenticated messages", async () => {
    const server = new OpenTableBridgeServer({ credential: generateCredential(), port: 0 });
    servers.push(server);
    const port = await server.start();
    await expect(rawStringRequest(port, JSON.stringify({ type: "BOOK" }))).resolves.toMatchObject({
      type: "ERROR",
      code: "MALFORMED_MESSAGE",
    });
  });

  it("authenticates a controller and reports extension readiness without secrets", async () => {
    const credential = generateCredential();
    const server = new OpenTableBridgeServer({ credential, port: 0 });
    servers.push(server);
    const port = await server.start();
    const client = new OpenTableBridgeClient({ credential, port });
    const status = await client.ping();
    expect(status).toMatchObject({ type: "PONG", extensionConnected: false, pageReady: false });
    expect(JSON.stringify(status)).not.toContain(credential);
    client.close();
  });

  it("rejects a controller with the wrong credential", async () => {
    const server = new OpenTableBridgeServer({ credential: generateCredential(), port: 0 });
    servers.push(server);
    const port = await server.start();
    const client = new OpenTableBridgeClient({ credential: generateCredential(), port });
    await expect(client.ping()).rejects.toBeInstanceOf(BridgeClientError);
    client.close();
  });

  it("reports an unavailable extension and reconnects a controller cleanly", async () => {
    const credential = generateCredential();
    const server = new OpenTableBridgeServer({ credential, port: 0 });
    servers.push(server);
    const port = await server.start();
    const client = new OpenTableBridgeClient({ credential, port });
    await expect(client.authenticationStatus()).rejects.toMatchObject({ code: "EXTENSION_UNAVAILABLE" });
    client.close();
    await expect(client.ping()).resolves.toMatchObject({ type: "PONG", extensionConnected: false });
    client.close();
  });

  it("enforces request deadlines when the extension does not answer", async () => {
    const credential = generateCredential();
    const server = new OpenTableBridgeServer({ credential, port: 0 });
    servers.push(server);
    const port = await server.start();
    const extension = await connectReadyExtension(port, credential);
    const client = new OpenTableBridgeClient({ credential, port, timeoutMs: 50 });
    await expect(client.authenticationStatus()).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    client.close();
    extension.close();
  });
});
