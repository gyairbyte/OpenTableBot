import { BookingTargetSchema } from "../../domain/booking-target.js";
import type { SeatingType } from "../../domain/primitives.js";
import { OpenTableAdapterError } from "../errors.js";
import { OpenTableBridgeClient } from "./client.js";
import { loadCredential } from "./credential-store.js";
import { BrowserBridgeOpenTableReadAdapter } from "./read-adapter.js";

const allSeatingTypes: readonly SeatingType[] = [
  "standard",
  "outdoor",
  "bar",
  "counter",
  "high-top",
  "private-dining",
  "other",
];

function parseFlags(args: readonly string[]): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value arguments; received ${key ?? "end of input"}`);
    }
    flags.set(key.slice(2), value);
  }
  return flags;
}

function requiredFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.trim() === "") throw new Error(`Missing required --${name} argument`);
  return value;
}

async function runSlots(
  adapter: BrowserBridgeOpenTableReadAdapter,
  args: readonly string[],
): Promise<void> {
  const flags = parseFlags(args);
  const date = requiredFlag(flags, "date");
  const target = BookingTargetSchema.parse({
    id: "phase-1-read-only-cli",
    restaurant: {
      id: requiredFlag(flags, "restaurant-id"),
      name: requiredFlag(flags, "restaurant-name"),
      timeZone: requiredFlag(flags, "timezone"),
    },
    dateRange: { startDate: date, endDate: date },
    partySize: Number(requiredFlag(flags, "party")),
    timeWindow: {
      earliest: requiredFlag(flags, "earliest"),
      latest: requiredFlag(flags, "latest"),
      preferred: requiredFlag(flags, "preferred"),
    },
    allowedSeatingTypes: allSeatingTypes,
    bookingPolicy: {
      allowPrepaid: false,
      maxAuthorizedPrepaidCents: 0,
      maxAuthorizedCancellationNoShowCents: 0,
      currency: "USD",
      autoBookAuthorized: false,
    },
    mode: "cancellation-watch",
  });
  const slots = await adapter.findSlots(target);
  if (slots.length === 0) {
    console.log("No normalized slots were returned.");
    return;
  }
  console.table(
    slots.map((slot) => ({
      date: slot.localDate,
      time: slot.localTime,
      seating: slot.seatingType,
      party: slot.partySize,
      startsAt: slot.startsAt,
      id: slot.id,
    })),
  );
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "check-auth" && command !== "slots") {
    throw new Error("Usage: cli.ts <check-auth|slots> [--name value ...]");
  }
  const credential = await loadCredential();
  const client = new OpenTableBridgeClient({ credential });
  const flags = command === "slots" ? parseFlags(args) : new Map<string, string>();
  const databaseRegion = flags.get("database-region");
  const adapter = new BrowserBridgeOpenTableReadAdapter(client, {
    ...(databaseRegion === undefined ? {} : { databaseRegion }),
    onDiagnostic: (message) => console.warn(message),
  });
  try {
    if (command === "check-auth") console.log(JSON.stringify(await adapter.checkAuthentication()));
    else await runSlots(adapter, args);
  } finally {
    await adapter.close();
  }
}

void main().catch((error: unknown) => {
  if (error instanceof OpenTableAdapterError) {
    console.error(
      JSON.stringify({
        ok: false,
        category: error.category,
        disposition: error.disposition,
        message: error.message,
      }),
    );
  } else {
    console.error(error instanceof Error ? error.message : "Unknown CLI failure");
  }
  process.exitCode = 1;
});
