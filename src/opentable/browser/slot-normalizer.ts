import { createHash } from "node:crypto";
import { z } from "zod";
import type { BookingTarget } from "../../domain/booking-target.js";
import {
  ReservationSlotSchema,
  type ReservationSlot,
} from "../../domain/reservation-slot.js";
import type { SeatingType } from "../../domain/primitives.js";
import {
  AdapterFailureCategory,
  OpenTableAdapterError,
} from "../errors.js";
import type { AvailabilityObservation } from "./availability-types.js";

const rawAvailableSlotSchema = z
  .object({
    isAvailable: z.literal(true),
    timeOffsetMinutes: z.number().int().optional(),
    attributes: z.array(z.string()).optional(),
    type: z.string().optional(),
    previewReference: z.string().uuid().optional(),
    experienceIds: z.array(z.union([z.string(), z.number()])).optional(),
    dateTime: z.string().optional(),
    startDateTime: z.string().optional(),
  })
  .passthrough()
  .superRefine((slot, context) => {
    if (
      slot.timeOffsetMinutes === undefined &&
      slot.dateTime === undefined &&
      slot.startDateTime === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Available slot has no authoritative or relative time",
      });
    }
  });

const rawUnavailableSlotSchema = z
  .object({ isAvailable: z.literal(false) })
  .passthrough();
const rawSlotSchema = z.union([
  rawAvailableSlotSchema,
  rawUnavailableSlotSchema,
]);
const rawDaySchema = z
  .object({
    dayOffset: z.number().int(),
    slots: z.array(z.unknown()),
  })
  .passthrough();
const rawRestaurantSchema = z
  .object({
    restaurantId: z.union([z.string(), z.number()]),
    availabilityDays: z.array(z.unknown()),
  })
  .passthrough();
const rawEnvelopeSchema = z
  .object({
    data: z.object({ availability: z.array(z.unknown()) }).passthrough(),
    errors: z.unknown().optional(),
  })
  .passthrough();
const authoritativeDateTimeSchema = z.string().datetime({ offset: true });

export interface SlotNormalizationDiagnostic {
  readonly code: "UNKNOWN_SEATING_LABEL";
  readonly label: string;
}

export interface NormalizedAvailability {
  readonly slots: readonly ReservationSlot[];
  readonly diagnostics: readonly SlotNormalizationDiagnostic[];
}

function malformed(message: string): OpenTableAdapterError {
  return new OpenTableAdapterError(
    AdapterFailureCategory.MALFORMED_RESPONSE,
    message,
  );
}

function invariant(message: string): OpenTableAdapterError {
  return new OpenTableAdapterError(
    AdapterFailureCategory.INVARIANT_MISMATCH,
    message,
  );
}

function addDaysAndMinutes(
  baseDate: string,
  baseTime: string,
  dayOffset: number,
  minuteOffset: number,
): { readonly date: string; readonly time: string } {
  const [year, month, day] = baseDate.split("-").map(Number);
  const [hour, minute] = baseTime.split(":").map(Number);
  const shifted = new Date(
    Date.UTC(
      year ?? 0,
      (month ?? 1) - 1,
      (day ?? 0) + dayOffset,
      hour ?? 0,
      (minute ?? 0) + minuteOffset,
    ),
  );
  return {
    date: `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(
      shifted.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`,
    time: `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(
      shifted.getUTCMinutes(),
    ).padStart(2, "0")}`,
  };
}

interface LocalDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function getLocalParts(instant: Date, timeZone: string): LocalDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
  };
}

function requestedParts(date: string, time: string): LocalDateTimeParts {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return {
    year: year ?? 0,
    month: month ?? 0,
    day: day ?? 0,
    hour: hour ?? 0,
    minute: minute ?? 0,
  };
}

function sameParts(left: LocalDateTimeParts, right: LocalDateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(
    absolute % 60,
  ).padStart(2, "0")}`;
}

/** Convert an unambiguous local IANA time to an ISO string with its real offset. */
export function localDateTimeToOffsetIso(
  date: string,
  time: string,
  timeZone: string,
): string {
  const desired = requestedParts(date, time);
  const naiveUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
  );
  const matches: { readonly instant: number; readonly offsetMinutes: number }[] = [];

  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const instant = naiveUtc - offsetMinutes * 60_000;
    if (sameParts(getLocalParts(new Date(instant), timeZone), desired)) {
      matches.push({ instant, offsetMinutes });
    }
  }

  if (matches.length !== 1) {
    throw invariant(
      `Local reservation time ${date} ${time} is ambiguous or invalid in ${timeZone}`,
    );
  }
  return `${date}T${time}:00${formatOffset(matches[0]!.offsetMinutes)}`;
}

function localDateTimeFromInstant(
  startsAt: string,
  timeZone: string,
): { readonly date: string; readonly time: string } {
  const instant = new Date(startsAt);
  if (Number.isNaN(instant.valueOf())) throw malformed("Invalid slot timestamp");
  const parts = getLocalParts(instant, timeZone);
  return {
    date: `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(
      2,
      "0",
    )}-${String(parts.day).padStart(2, "0")}`,
    time: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(
      2,
      "0",
    )}`,
  };
}

function sanitizeLabel(label: string): string {
  return [...label]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .trim()
    .slice(0, 80);
}

function normalizeSeating(
  attributes: readonly string[] | undefined,
  type: string | undefined,
): {
  readonly seatingTypes: readonly SeatingType[];
  readonly diagnostics: readonly SlotNormalizationDiagnostic[];
} {
  const labels = attributes !== undefined && attributes.length > 0 ? attributes : [type ?? "unknown"];
  const seatingTypes: SeatingType[] = [];
  const diagnostics: SlotNormalizationDiagnostic[] = [];

  for (const originalLabel of labels) {
    const compact = originalLabel.toLowerCase().replace(/[\s_-]/g, "");
    const seatingType: SeatingType =
      compact === "default" || compact === "standard"
        ? "standard"
        : compact === "outdoor" || compact === "patio" || compact === "terrace"
          ? "outdoor"
          : compact === "bar"
            ? "bar"
            : compact === "counter"
              ? "counter"
              : compact === "hightop"
                ? "high-top"
                : compact === "privatedining"
                  ? "private-dining"
                  : "other";
    if (seatingType === "other") {
      diagnostics.push({
        code: "UNKNOWN_SEATING_LABEL",
        label: sanitizeLabel(originalLabel),
      });
    }
    if (!seatingTypes.includes(seatingType)) seatingTypes.push(seatingType);
  }
  return { seatingTypes, diagnostics };
}

function stableSlotId(parts: readonly (string | number)[]): string {
  const digest = createHash("sha256").update(parts.join("|")).digest("hex");
  return `ot-read-${digest.slice(0, 20)}`;
}

function reservationKinds(
  slot: z.infer<typeof rawAvailableSlotSchema>,
): readonly ReservationSlot["reservationKind"][] {
  const providerType = slot.type?.trim() || "unknown";
  if (/^standard$/iu.test(providerType)) return [{ kind: "standard" }];
  if (/^experience$/iu.test(providerType)) {
    const experienceIds = [...new Set((slot.experienceIds ?? []).map(String))];
    return experienceIds.length > 0
      ? experienceIds.map((experienceId) => ({ kind: "experience", experienceId }))
      : [{ kind: "unknown", providerType: "Experience without an identifier" }];
  }
  return [{ kind: "unknown", providerType }];
}

function parseAvailableSlot(value: unknown): z.infer<typeof rawAvailableSlotSchema> {
  const parsed = rawSlotSchema.safeParse(value);
  if (!parsed.success) throw malformed("Malformed slot in availability response");
  if (!parsed.data.isAvailable) throw malformed("Expected an available slot");
  return parsed.data;
}

export function normalizeAvailabilityObservation(
  observation: AvailabilityObservation,
  target: BookingTarget,
  requestedDate: string,
): NormalizedAvailability {
  const { requestContext } = observation;
  if (!requestContext.restaurantIds.includes(target.restaurant.id)) {
    throw invariant("Availability request did not include the requested restaurant");
  }
  if (requestContext.date !== requestedDate) {
    throw invariant("Availability request date did not match the requested date");
  }
  if (requestContext.partySize !== target.partySize) {
    throw invariant("Availability request party size did not match the target");
  }
  if (requestContext.time === undefined) {
    throw malformed("Availability request time was not observable");
  }

  const envelope = rawEnvelopeSchema.safeParse(observation.payload);
  if (!envelope.success) throw malformed("Malformed availability payload");
  if (
    envelope.data.errors !== undefined &&
    (!Array.isArray(envelope.data.errors) || envelope.data.errors.length > 0)
  ) {
    throw malformed("Availability payload contained provider errors");
  }

  const restaurants = envelope.data.data.availability.map((value) => {
    const parsed = rawRestaurantSchema.safeParse(value);
    if (!parsed.success) throw malformed("Malformed restaurant availability entry");
    return parsed.data;
  });
  const matchingRestaurants = restaurants.filter(
    (restaurant) => String(restaurant.restaurantId) === target.restaurant.id,
  );
  if (matchingRestaurants.length === 0) {
    throw invariant("Availability response did not contain the requested restaurant");
  }

  const slots: ReservationSlot[] = [];
  const diagnostics: SlotNormalizationDiagnostic[] = [];
  let rawSlotIndex = 0;

  for (const restaurant of matchingRestaurants) {
    for (const rawDay of restaurant.availabilityDays) {
      const dayResult = rawDaySchema.safeParse(rawDay);
      if (!dayResult.success) throw malformed("Malformed availability day");
      for (const rawSlot of dayResult.data.slots) {
        const slotResult = rawSlotSchema.safeParse(rawSlot);
        if (!slotResult.success) throw malformed("Malformed slot in availability response");
        if (!slotResult.data.isAvailable) continue;
        const slot = parseAvailableSlot(rawSlot);
        rawSlotIndex += 1;

        const relativeLocal = addDaysAndMinutes(
          requestContext.date,
          requestContext.time,
          dayResult.data.dayOffset,
          slot.timeOffsetMinutes ?? 0,
        );
        const authoritative = slot.startDateTime ?? slot.dateTime;
        let localDate = relativeLocal.date;
        let localTime = relativeLocal.time;
        let startsAt: string;

        if (authoritative !== undefined) {
          if (!authoritativeDateTimeSchema.safeParse(authoritative).success) {
            throw malformed("Availability slot timestamp lacked an offset");
          }
          const authoritativeLocal = localDateTimeFromInstant(
            authoritative,
            target.restaurant.timeZone,
          );
          if (
            slot.timeOffsetMinutes !== undefined &&
            (authoritativeLocal.date !== relativeLocal.date ||
              authoritativeLocal.time !== relativeLocal.time)
          ) {
            throw invariant("Authoritative slot timestamp disagreed with response offsets");
          }
          localDate = authoritativeLocal.date;
          localTime = authoritativeLocal.time;
          startsAt = authoritative;
        } else {
          startsAt = localDateTimeToOffsetIso(
            localDate,
            localTime,
            target.restaurant.timeZone,
          );
        }

        const seating = normalizeSeating(slot.attributes, slot.type);
        diagnostics.push(...seating.diagnostics);
        for (const reservationKind of reservationKinds(slot)) {
          for (const seatingType of seating.seatingTypes) {
            slots.push(
              ReservationSlotSchema.parse({
                id: stableSlotId([
                  target.restaurant.id,
                  localDate,
                  localTime,
                  seatingType,
                  reservationKind.kind,
                  reservationKind.kind === "experience"
                    ? reservationKind.experienceId
                    : reservationKind.kind === "unknown"
                      ? reservationKind.providerType
                      : "standard",
                  rawSlotIndex,
                ]),
                restaurantId: target.restaurant.id,
                startsAt,
                localDate,
                localTime,
                partySize: target.partySize,
                seatingType,
                reservationKind,
                ...(slot.previewReference === undefined
                  ? {}
                  : { previewReference: slot.previewReference }),
              }),
            );
          }
        }
      }
    }
  }

  return {
    slots: slots.toSorted((left, right) =>
      `${left.localDate}${left.localTime}${left.seatingType}${left.id}`.localeCompare(
        `${right.localDate}${right.localTime}${right.seatingType}${right.id}`,
      ),
    ),
    diagnostics,
  };
}
