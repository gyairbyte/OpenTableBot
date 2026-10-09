import { z } from "zod";
import type { BookingTarget } from "./booking-target.js";
import type { SeatingType } from "./primitives.js";

export const DiningAreaCategorySchema = z.enum([
  "dining-room",
  "indoor",
  "outdoor",
  "patio",
  "terrace",
  "rooftop",
  "bar",
  "bar-seating",
  "counter",
  "high-top",
  "lounge",
  "garden",
  "communal",
  "private-dining",
  "chefs-counter",
  "other",
  "unknown",
]);

export type DiningAreaCategory = z.infer<typeof DiningAreaCategorySchema>;

export const DiningAreaOptionSchema = z.strictObject({
  category: DiningAreaCategorySchema,
  label: z.string().min(1).max(80),
  providerOrder: z.number().int().nonnegative(),
});

export type DiningAreaOption = z.infer<typeof DiningAreaOptionSchema>;

export const DiningAreaPreferenceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("category"), value: DiningAreaCategorySchema }),
  z.strictObject({ type: z.literal("label"), value: z.string().min(1).max(80) }),
]);

export type DiningAreaPreference = z.infer<typeof DiningAreaPreferenceSchema>;

export const DiningAreaPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("any"), selection: z.literal("provider-order") }),
  z.strictObject({
    mode: z.literal("allow"),
    categories: z.array(DiningAreaCategorySchema),
    labels: z.array(z.string().min(1).max(80)),
    selection: z.literal("provider-order"),
  }).refine((value) => value.categories.length + value.labels.length > 0, {
    message: "ALLOW dining-area policy requires at least one category or label",
  }),
  z.strictObject({
    mode: z.literal("prefer"),
    preferences: z.array(DiningAreaPreferenceSchema).min(1),
    fallback: z.enum(["any", "none"]),
    selection: z.literal("provider-order"),
  }),
]);

export type DiningAreaPolicy = z.infer<typeof DiningAreaPolicySchema>;

export const AnyDiningAreaPolicy: DiningAreaPolicy = {
  mode: "any",
  selection: "provider-order",
};

/**
 * Resolves the effective dining-area policy for a target. Lives here rather
 * than in booking-target.ts so booking-policy.ts can depend on it without a
 * circular import back into the target schema.
 */
export function effectiveDiningAreaPolicy(target: BookingTarget): DiningAreaPolicy {
  if (target.diningAreaPolicy !== undefined) return target.diningAreaPolicy;
  if (target.allowedSeatingTypes === undefined) return AnyDiningAreaPolicy;
  return {
    mode: "allow",
    categories: [...new Set(target.allowedSeatingTypes.map(legacySeatingCategory))],
    labels: [],
    selection: "provider-order",
  };
}

export function sanitizeDiningAreaLabel(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function normalizeDiningAreaCategory(label: string): DiningAreaCategory {
  const value = compact(label);
  if (value === "diningroom" || value === "default" || value === "standard" || value === "mainroom") return "dining-room";
  if (value === "indoor" || value === "inside") return "indoor";
  if (value === "outdoor" || value === "outside") return "outdoor";
  if (value === "patio" || value === "sidewalk") return "patio";
  if (value === "terrace" || value === "veranda") return "terrace";
  if (value === "rooftop" || value === "roof") return "rooftop";
  if (value === "bar") return "bar";
  if (value === "barseating") return "bar-seating";
  if (value === "counter") return "counter";
  if (value === "hightop") return "high-top";
  if (value === "lounge") return "lounge";
  if (value === "garden") return "garden";
  if (value === "communal" || value === "sharedtable") return "communal";
  if (value === "privatedining" || value === "privateroom") return "private-dining";
  if (value === "chefscounter" || value === "chefcounter") return "chefs-counter";
  if (value === "other") return "other";
  return "unknown";
}

export function legacySeatingCategory(seatingType: SeatingType): DiningAreaCategory {
  if (seatingType === "standard") return "dining-room";
  if (seatingType === "outdoor") return "outdoor";
  if (seatingType === "bar") return "bar";
  if (seatingType === "counter") return "counter";
  if (seatingType === "high-top") return "high-top";
  if (seatingType === "private-dining") return "private-dining";
  return "unknown";
}

export function legacySeatingForCategory(category: DiningAreaCategory): SeatingType {
  if (["outdoor", "patio", "terrace", "rooftop", "garden"].includes(category)) return "outdoor";
  if (category === "bar" || category === "bar-seating") return "bar";
  if (category === "counter" || category === "chefs-counter") return "counter";
  if (category === "high-top") return "high-top";
  if (category === "private-dining") return "private-dining";
  if (category === "unknown" || category === "other") return "other";
  return "standard";
}

function preferenceIndex(policy: DiningAreaPolicy, area: DiningAreaOption): number | undefined {
  if (policy.mode !== "prefer") return undefined;
  const index = policy.preferences.findIndex((preference) =>
    preference.type === "category"
      ? area.category === preference.value
      : area.label === preference.value,
  );
  return index < 0 ? undefined : index;
}

export function diningAreaPreferenceRank(
  policy: DiningAreaPolicy,
  area: DiningAreaOption,
): number {
  if (policy.mode !== "prefer") return 0;
  return preferenceIndex(policy, area) ?? policy.preferences.length;
}

export function isDiningAreaAllowed(policy: DiningAreaPolicy, area: DiningAreaOption): boolean {
  if (policy.mode === "any") return true;
  if (policy.mode === "allow") {
    return policy.categories.includes(area.category) || policy.labels.includes(area.label);
  }
  return preferenceIndex(policy, area) !== undefined || policy.fallback === "any";
}

export function sameDiningAreaOption(
  left: DiningAreaOption | undefined,
  right: DiningAreaOption | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.category === right.category &&
    left.label === right.label &&
    left.providerOrder === right.providerOrder;
}

export function rankDiningAreaOptions<T extends { readonly diningArea: DiningAreaOption }>(
  policy: DiningAreaPolicy,
  options: readonly T[],
): readonly T[] {
  return options
    .filter((option) => isDiningAreaAllowed(policy, option.diningArea))
    .map((option, inputOrder) => ({ option, inputOrder }))
    .toSorted((left, right) => {
      return (
        diningAreaPreferenceRank(policy, left.option.diningArea) -
          diningAreaPreferenceRank(policy, right.option.diningArea) ||
        left.option.diningArea.providerOrder - right.option.diningArea.providerOrder ||
        left.inputOrder - right.inputOrder
      );
    })
    .map(({ option }) => option);
}
