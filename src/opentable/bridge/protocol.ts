import { z } from "zod";
import { SafeAvailabilityDataSchema } from "../browser/availability-types.js";
import { SafeBookingPreviewDataSchema } from "../browser/preview-types.js";
import { SeatingTypeSchema } from "../../domain/primitives.js";

export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_BRIDGE_HOST = "127.0.0.1" as const;
export const DEFAULT_BRIDGE_PORT = 38_471;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

const MessageIdSchema = z.string().min(8).max(128);
const DeadlineSchema = z.number().int().positive();
export const CredentialSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const PairingCodeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/u);
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const TimeSchema = z.string().regex(/^\d{2}:\d{2}$/u);

function isAllowedOpenTableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.opentable.com";
  } catch {
    return false;
  }
}

export const OpenTablePageUrlSchema = z
  .string()
  .url()
  .refine(isAllowedOpenTableUrl, "Only https://www.opentable.com is allowed");

/** Remove all query/fragment state before an OpenTable page URL can leave Chrome. */
export function sanitizeOpenTablePageUrl(value: string): string {
  const allowed = OpenTablePageUrlSchema.parse(value);
  const url = new URL(allowed);
  return `${url.origin}${url.pathname}`;
}

const baseShape = {
  protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
  id: MessageIdSchema,
};

const requestBaseShape = {
  ...baseShape,
  deadlineEpochMs: DeadlineSchema,
};

export const PairRequestSchema = z
  .object({
    ...requestBaseShape,
    type: z.literal("PAIR"),
    pairingCode: PairingCodeSchema,
  })
  .strict();

export const PairResultSchema = z
  .object({
    ...baseShape,
    type: z.literal("PAIR_RESULT"),
    credential: CredentialSchema,
  })
  .strict();

export const HelloSchema = z
  .object({
    ...requestBaseShape,
    type: z.literal("HELLO"),
    role: z.enum(["extension", "controller"]),
    credential: CredentialSchema,
  })
  .strict();

export const HelloResultSchema = z
  .object({
    ...baseShape,
    type: z.literal("HELLO_RESULT"),
    authenticated: z.literal(true),
  })
  .strict();

export const ReadySchema = z
  .object({
    ...baseShape,
    type: z.literal("READY"),
    pageUrl: OpenTablePageUrlSchema,
    pageReady: z.boolean(),
  })
  .strict();

export const PingSchema = z
  .object({
    ...requestBaseShape,
    type: z.literal("PING"),
  })
  .strict();

export const PongSchema = z
  .object({
    ...baseShape,
    type: z.literal("PONG"),
    extensionConnected: z.boolean(),
    pageReady: z.boolean(),
    pageUrl: OpenTablePageUrlSchema.optional(),
  })
  .strict();

export const AuthStatusRequestSchema = z
  .object({
    ...requestBaseShape,
    type: z.literal("AUTH_STATUS"),
  })
  .strict();

export const AuthenticationStatusSchema = z.discriminatedUnion("authenticated", [
  z.object({ authenticated: z.literal(true) }).strict(),
  z
    .object({
      authenticated: z.literal(false),
      reason: z.enum(["required", "expired"]),
    })
    .strict(),
]);

export const AuthStatusResultSchema = z
  .object({
    ...baseShape,
    type: z.literal("AUTH_STATUS_RESULT"),
    status: AuthenticationStatusSchema,
  })
  .strict();

export const FindSlotsRequestPayloadSchema = z
  .object({
    restaurantId: z.string().min(1).max(80),
    date: DateSchema,
    time: TimeSchema,
    partySize: z.number().int().positive().max(50),
    databaseRegion: z.string().min(1).max(16),
  })
  .strict();

export const FindSlotsRequestSchema = z
  .object({
    ...requestBaseShape,
    type: z.literal("FIND_SLOTS"),
    request: FindSlotsRequestPayloadSchema,
  })
  .strict();

export const FindSlotsResultSchema = z
  .object({
    ...baseShape,
    type: z.literal("FIND_SLOTS_RESULT"),
    request: FindSlotsRequestPayloadSchema,
    data: SafeAvailabilityDataSchema,
  })
  .strict();

export const BookingPreviewRequestPayloadSchema = z
  .object({
    slotId: z.string().min(1).max(200),
    previewReference: z.string().uuid(),
    restaurantId: z.string().min(1).max(80),
    date: DateSchema,
    time: TimeSchema,
    partySize: z.number().int().positive().max(50),
    seatingType: SeatingTypeSchema,
    reservationKind: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("standard") }).strict(),
      z
        .object({
          kind: z.literal("experience"),
          experienceId: z.string().min(1).max(80),
        })
        .strict(),
      z
        .object({
          kind: z.literal("unknown"),
          providerType: z.string().min(1).max(100),
        })
        .strict(),
    ]),
  })
  .strict();

export const GetBookingPreviewRequestSchema = z
  .object({
    ...requestBaseShape,
    type: z.literal("GET_BOOKING_PREVIEW"),
    request: BookingPreviewRequestPayloadSchema,
  })
  .strict();

export const GetBookingPreviewResultSchema = z
  .object({
    ...baseShape,
    type: z.literal("GET_BOOKING_PREVIEW_RESULT"),
    request: BookingPreviewRequestPayloadSchema,
    data: SafeBookingPreviewDataSchema,
  })
  .strict();

export const BridgeErrorCodeSchema = z.enum([
  "AUTHENTICATION_FAILED",
  "OPENTABLE_AUTHENTICATION_REQUIRED",
  "PAGE_CHALLENGE",
  "ACCESS_CONTROL_RESPONSE",
  "RATE_LIMITED",
  "DEADLINE_EXCEEDED",
  "EXTENSION_UNAVAILABLE",
  "MALFORMED_MESSAGE",
  "PAGE_NOT_READY",
  "PAGE_OPERATION_UNAVAILABLE",
  "PAIRING_FAILED",
  "UNSUPPORTED_PROTOCOL",
]);

export const ErrorMessageSchema = z
  .object({
    ...baseShape,
    type: z.literal("ERROR"),
    code: BridgeErrorCodeSchema,
    message: z.string().min(1).max(500),
  })
  .strict();

export const BridgeMessageSchema = z.discriminatedUnion("type", [
  PairRequestSchema,
  PairResultSchema,
  HelloSchema,
  HelloResultSchema,
  ReadySchema,
  PingSchema,
  PongSchema,
  AuthStatusRequestSchema,
  AuthStatusResultSchema,
  FindSlotsRequestSchema,
  FindSlotsResultSchema,
  GetBookingPreviewRequestSchema,
  GetBookingPreviewResultSchema,
  ErrorMessageSchema,
]);

export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;
export type PairRequest = z.infer<typeof PairRequestSchema>;
export type PairResult = z.infer<typeof PairResultSchema>;
export type Hello = z.infer<typeof HelloSchema>;
export type Pong = z.infer<typeof PongSchema>;
export type Ready = z.infer<typeof ReadySchema>;
export type Ping = z.infer<typeof PingSchema>;
export type AuthStatusRequest = z.infer<typeof AuthStatusRequestSchema>;
export type AuthStatusResult = z.infer<typeof AuthStatusResultSchema>;
export type FindSlotsRequest = z.infer<typeof FindSlotsRequestSchema>;
export type FindSlotsResult = z.infer<typeof FindSlotsResultSchema>;
export type GetBookingPreviewRequest = z.infer<
  typeof GetBookingPreviewRequestSchema
>;
export type GetBookingPreviewResult = z.infer<
  typeof GetBookingPreviewResultSchema
>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

export function parseBridgeMessage(raw: string): BridgeMessage {
  return BridgeMessageSchema.parse(JSON.parse(raw) as unknown);
}

export function bridgeUrl(port = DEFAULT_BRIDGE_PORT): string {
  return `ws://${DEFAULT_BRIDGE_HOST}:${port}`;
}
