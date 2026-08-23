import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { BookingTargetSchema } from "../../domain/booking-target.js";
import type { SeatingType } from "../../domain/primitives.js";
import { OpenTableAdapterError } from "../errors.js";
import { OpenTableBrowserSession } from "./browser-session.js";
import { PlaywrightOpenTableReadAdapter } from "./read-adapter.js";

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
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required --${name} argument`);
  }
  return value;
}

async function runLogin(
  session: OpenTableBrowserSession,
  adapter: PlaywrightOpenTableReadAdapter,
): Promise<void> {
  await session.start();
  await session.openLoginPage();
  output.write(
    [
      "A dedicated OpenTableBot Chrome window is open.",
      "Use OpenTable's normal interface to sign in. Credentials stay in the browser.",
      "Do not close the browser window while this command is running.",
      "",
    ].join("\n"),
  );
  const prompt = createInterface({ input, output });
  try {
    await prompt.question("Press Enter after normal OpenTable sign-in is complete... ");
  } finally {
    prompt.close();
  }
  const result = await adapter.checkAuthentication();
  output.write(`${JSON.stringify(result)}\n`);
}

async function runCheckAuth(adapter: PlaywrightOpenTableReadAdapter): Promise<void> {
  output.write(`${JSON.stringify(await adapter.checkAuthentication())}\n`);
}

async function runSlots(
  adapter: PlaywrightOpenTableReadAdapter,
  args: readonly string[],
): Promise<void> {
  const flags = parseFlags(args);
  const partySize = Number(requiredFlag(flags, "party"));
  const date = requiredFlag(flags, "date");
  const target = BookingTargetSchema.parse({
    id: "phase-1-read-only-cli",
    restaurant: {
      id: requiredFlag(flags, "restaurant-id"),
      name: requiredFlag(flags, "restaurant-name"),
      timeZone: requiredFlag(flags, "timezone"),
    },
    dateRange: { startDate: date, endDate: date },
    partySize,
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
    output.write("No normalized slots were observed.\n");
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
  if (!new Set(["login", "check-auth", "slots"]).has(command ?? "")) {
    throw new Error("Usage: cli.ts <login|check-auth|slots> [--name value ...]");
  }

  const session = new OpenTableBrowserSession();
  const adapter = new PlaywrightOpenTableReadAdapter(session, {
    onDiagnostic: (message) => console.warn(message),
  });
  try {
    if (command === "login") await runLogin(session, adapter);
    if (command === "check-auth") await runCheckAuth(adapter);
    if (command === "slots") await runSlots(adapter, args);
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
