import { z } from "zod";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 1) - 1 &&
    date.getUTCDate() === day
  );
}

export const LocalDateSchema = z.string().refine(isCalendarDate, {
  message: "Expected a valid local date in YYYY-MM-DD format",
});

export const LocalTimeSchema = z.string().regex(LOCAL_TIME_PATTERN, {
  message: "Expected a local time in HH:mm 24-hour format",
});

export const SeatingTypeSchema = z.enum([
  "standard",
  "outdoor",
  "bar",
  "counter",
  "high-top",
  "private-dining",
  "other",
]);

export type SeatingType = z.infer<typeof SeatingTypeSchema>;
