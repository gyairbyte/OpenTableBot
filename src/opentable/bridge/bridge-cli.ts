import { OpenTableBridgeClient } from "./client.js";
import {
  bridgeStateDirectory,
  generatePairingCode,
  loadCredential,
  loadOrCreateCredential,
  rotateCredential,
} from "./credential-store.js";
import { DEFAULT_BRIDGE_PORT } from "./protocol.js";
import { OpenTableBridgeServer } from "./server.js";

function configuredPort(): number {
  const value = process.env.OPENTABLE_BRIDGE_PORT;
  if (value === undefined) return DEFAULT_BRIDGE_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OPENTABLE_BRIDGE_PORT must be an integer from 1 through 65535");
  }
  return port;
}

async function runServer(pair: boolean): Promise<void> {
  const stateDirectory = bridgeStateDirectory();
  const credential = await loadOrCreateCredential(stateDirectory);
  const pairingCode = pair ? generatePairingCode() : undefined;
  const server = new OpenTableBridgeServer({
    credential,
    port: configuredPort(),
    ...(pairingCode === undefined
      ? {}
      : { pairing: { code: pairingCode, expiresAt: Date.now() + 5 * 60_000 } }),
    onPairingConsumed: () => console.log("Extension pairing completed."),
    onStatus: (message) => console.log(message),
  });
  await server.start();
  if (pairingCode !== undefined) {
    console.log(`Pairing code: ${pairingCode}`);
    console.log("Enter this one-time code in the OpenTableBot extension within five minutes.");
  }
  console.log("Press Ctrl+C to stop the local bridge.");
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
}

async function status(): Promise<void> {
  const credential = await loadCredential();
  const client = new OpenTableBridgeClient({ credential, port: configuredPort() });
  try {
    console.log(JSON.stringify(await client.ping()));
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  if (command === "start") return runServer(false);
  if (command === "pair") return runServer(true);
  if (command === "status") return status();
  if (command === "revoke") {
    await rotateCredential();
    console.log("Bridge credential rotated. Existing extension pairing is revoked.");
    return;
  }
  throw new Error("Usage: bridge-cli.ts <start|pair|status|revoke>");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Unknown bridge failure");
  process.exitCode = 1;
});
