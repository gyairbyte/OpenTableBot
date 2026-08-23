import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CredentialSchema, PairingCodeSchema } from "./protocol.js";

const storedCredentialSchema = z
  .object({ version: z.literal(1), credential: CredentialSchema })
  .strict();

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function bridgeStateDirectory(override?: string): string {
  const configured = override ?? process.env.OPENTABLE_BRIDGE_STATE_DIRECTORY;
  return path.resolve(configured?.trim() || ".local/bridge");
}

export function bridgeCredentialPath(directory = bridgeStateDirectory()): string {
  return path.join(directory, "credential.json");
}

export function generateCredential(): string {
  return randomBytes(32).toString("hex");
}

export function generatePairingCode(): string {
  const bytes = randomBytes(8);
  const code = [...bytes]
    .map((value) => PAIRING_ALPHABET[value % PAIRING_ALPHABET.length])
    .join("");
  return PairingCodeSchema.parse(code);
}

async function persistCredential(directory: string, credential: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    bridgeCredentialPath(directory),
    `${JSON.stringify({ version: 1, credential }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export async function loadCredential(directory = bridgeStateDirectory()): Promise<string> {
  const raw = await readFile(bridgeCredentialPath(directory), "utf8");
  return storedCredentialSchema.parse(JSON.parse(raw) as unknown).credential;
}

export async function loadOrCreateCredential(
  directory = bridgeStateDirectory(),
): Promise<string> {
  try {
    return await loadCredential(directory);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") throw error;
    const credential = generateCredential();
    await persistCredential(directory, credential);
    return credential;
  }
}

export async function rotateCredential(
  directory = bridgeStateDirectory(),
): Promise<string> {
  const credential = generateCredential();
  await persistCredential(directory, credential);
  return credential;
}
