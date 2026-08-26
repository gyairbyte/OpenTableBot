import { BookingTargetSchema } from "../../domain/booking-target.js";
import type { SeatingType } from "../../domain/primitives.js";
import type { BookingTarget } from "../../domain/booking-target.js";
import { rankAcceptableSlots } from "../../domain/slot-matcher.js";
import { validateBookingPreview } from "../../runner/booking-engine.js";
import { OpenTableAdapterError } from "../errors.js";
import { OpenTableBridgeClient } from "./client.js";
import { loadCredential } from "./credential-store.js";
import { BrowserBridgeOpenTableReadAdapter } from "./read-adapter.js";
import type { OpenTableReadAdapter } from "../adapter.js";
import { BrowserBridgeOpenTableBookingAdapter } from "./booking-adapter.js";
import { runControlledBooking } from "../../runner/controlled-booking.js";

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
  for (let index = 0; index < args.length;) {
    const key = args[index];
    const value = args[index + 1];
    if (key === "--execute") {
      flags.set("execute", "true");
      index += 1;
      continue;
    }
    if (key === undefined || !key.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Expected --name value arguments; received ${key ?? "end of input"}`);
    }
    flags.set(key.slice(2), value);
    index += 2;
  }
  return flags;
}

async function selectedSlot(
  adapter: OpenTableReadAdapter,
  target: BookingTarget,
  flags: ReadonlyMap<string, string>,
) {
  const slots = rankAcceptableSlots(target, await adapter.findSlots(target));
  const requestedSlotId = flags.get("slot-id");
  const requestedSeating = flags.get("seating");
  const requestedExperienceId = flags.get("experience-id");
  const slot = slots.find(
    (candidate) =>
      (requestedSlotId === undefined || candidate.id === requestedSlotId) &&
      (requestedSeating === undefined || candidate.seatingType === requestedSeating) &&
      (requestedExperienceId === undefined ||
        (candidate.reservationKind.kind === "experience" &&
          candidate.reservationKind.experienceId === requestedExperienceId)),
  );
  if (slot === undefined) throw new Error("No available slot matched the selection");
  return slot;
}

function requiredFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.trim() === "") throw new Error(`Missing required --${name} argument`);
  return value;
}

function booleanFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = flags.get(name);
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false`);
}

function targetFromFlags(flags: ReadonlyMap<string, string>): BookingTarget {
  const date = requiredFlag(flags, "date");
  return BookingTargetSchema.parse({
    id: "phase-2-read-only-preview-cli",
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
      allowPrepaid: booleanFlag(flags, "allow-prepaid", false),
      maxAuthorizedPrepaidCents: Number(flags.get("max-prepaid-cents") ?? "0"),
      maxAuthorizedCancellationNoShowCents: Number(
        flags.get("max-cancellation-no-show-cents") ?? "0",
      ),
      currency: flags.get("currency") ?? "USD",
      allowExperiences: booleanFlag(flags, "allow-experiences", false),
      allowPaymentMethodRequired: booleanFlag(
        flags,
        "allow-payment-method-required",
        false,
      ),
      autoBookAuthorized: booleanFlag(flags, "auto-book-authorized", false),
    },
    mode: "cancellation-watch",
  });
}

async function runSlots(
  adapter: OpenTableReadAdapter,
  flags: ReadonlyMap<string, string>,
): Promise<void> {
  const target = targetFromFlags(flags);
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
      reservation: slot.reservationKind.kind,
      experience:
        slot.reservationKind.kind === "experience"
          ? slot.reservationKind.experienceId
          : "",
      id: slot.id,
    })),
  );
}

async function runPreview(
  adapter: OpenTableReadAdapter,
  flags: ReadonlyMap<string, string>,
): Promise<void> {
  const target = targetFromFlags(flags);
  const slot = await selectedSlot(adapter, target, flags);
  const preview = await adapter.getBookingPreview(target, slot);
  const policy = validateBookingPreview(target, slot, preview);
  console.log(
    JSON.stringify(
      {
        slot: {
          restaurant: target.restaurant,
          date: slot.localDate,
          time: slot.localTime,
          party: slot.partySize,
          seating: slot.seatingType,
        },
        terms: {
          reservationKind: preview.reservationKind,
          prepaid: preview.prepaid,
          cancellation: preview.cancellationFee,
          noShow: preview.noShowFee,
          currency: preview.currency,
          paymentRequirement: preview.paymentRequirement,
          strongAuthentication: preview.strongAuthentication,
          ...(preview.termsSummary === undefined
            ? {}
            : { summary: preview.termsSummary }),
        },
        policy: policy.allowed
          ? { decision: "AUTHORIZED", reasons: [] }
          : { decision: "REJECTED", reasons: policy.reasons },
      },
      null,
      2,
    ),
  );
  console.log(
    "DRY RUN ONLY — NO INVENTORY WAS LOCKED AND NO RESERVATION WAS CREATED",
  );
}

async function runBook(
  adapter: BrowserBridgeOpenTableBookingAdapter,
  flags: ReadonlyMap<string, string>,
): Promise<void> {
  const target = targetFromFlags(flags);
  const slot = await selectedSlot(adapter, target, flags);
  const execute = flags.get("execute") === "true";
  console.log(JSON.stringify({
    exactSelection: {
      restaurant: target.restaurant,
      date: slot.localDate,
      time: slot.localTime,
      startsAt: slot.startsAt,
      party: slot.partySize,
      seating: slot.seatingType,
      reservationKind: slot.reservationKind,
      slotId: slot.id,
    },
    mode: execute ? "CONTROLLED_WRITE" : "DRY_RUN",
  }, null, 2));
  const result = await runControlledBooking(adapter, target, slot, { execute });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "dry-run") {
    console.log("DRY RUN ONLY — NO INVENTORY WAS LOCKED AND NO RESERVATION WAS CREATED");
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "check-auth" && command !== "slots" && command !== "preview" && command !== "book") {
    throw new Error("Usage: cli.ts <check-auth|slots|preview|book> [--name value ...] [--execute]");
  }
  const credential = await loadCredential();
  const client = new OpenTableBridgeClient({ credential });
  const flags = command === "check-auth" ? new Map<string, string>() : parseFlags(args);
  const databaseRegion = flags.get("database-region");
  const adapterOptions = {
    ...(databaseRegion === undefined ? {} : { databaseRegion }),
    onDiagnostic: (message: string) => console.warn(message),
  };
  const adapter = command === "book"
    ? new BrowserBridgeOpenTableBookingAdapter(client, adapterOptions)
    : new BrowserBridgeOpenTableReadAdapter(client, adapterOptions);
  try {
    if (command === "check-auth") console.log(JSON.stringify(await adapter.checkAuthentication()));
    else if (command === "slots") await runSlots(adapter, flags);
    else if (command === "preview") await runPreview(adapter, flags);
    else await runBook(adapter as BrowserBridgeOpenTableBookingAdapter, flags);
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
