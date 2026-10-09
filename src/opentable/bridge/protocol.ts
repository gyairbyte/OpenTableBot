import { z } from "zod";
import { SafeAvailabilityDataSchema } from "../browser/availability-types.js";
import { SafeBookingPreviewDataSchema } from "../browser/preview-types.js";
import { SafeDiningAreaCandidatesSchema } from "../browser/dining-area-types.js";
import { SeatingTypeSchema } from "../../domain/primitives.js";
import { DiningAreaOptionSchema } from "../../domain/dining-area.js";
import {
  BookingConfirmationSchema,
  BookingPreviewSchema,
} from "../../domain/reservation-slot.js";
import { LockTelemetryStage } from "./lock-lifecycle.js";

export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_BRIDGE_HOST = "127.0.0.1" as const;
export const DEFAULT_BRIDGE_PORT = 38_471;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const LOCK_OPERATION_TIMEOUT_MS = 25_000;

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
    diningArea: DiningAreaOptionSchema,
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

export const ListDiningAreasRequestPayloadSchema = z.strictObject({
  baseSlotId: z.string().min(1).max(200),
  previewReference: z.string().uuid(),
  restaurantId: z.string().min(1).max(80),
  date: DateSchema,
  time: TimeSchema,
  partySize: z.number().int().positive().max(50),
  seatingType: SeatingTypeSchema,
  reservationKind: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("standard") }),
    z.strictObject({ kind: z.literal("experience"), experienceId: z.string().min(1).max(80) }),
    z.strictObject({ kind: z.literal("unknown"), providerType: z.string().min(1).max(100) }),
  ]),
});

export const ListDiningAreasRequestSchema = z.strictObject({
  ...requestBaseShape,
  type: z.literal("LIST_DINING_AREAS"),
  request: ListDiningAreasRequestPayloadSchema,
});

export const ListDiningAreasResultSchema = z.strictObject({
  ...baseShape,
  type: z.literal("LIST_DINING_AREAS_RESULT"),
  request: ListDiningAreasRequestPayloadSchema,
  candidates: SafeDiningAreaCandidatesSchema,
});

/** Exact, provider-neutral booking intent. Provider request bodies are never accepted. */
export const BookingIntentSchema = z
  .object({
    targetId: z.string().min(1).max(200),
    slotId: z.string().min(1).max(200),
    previewReference: z.string().uuid(),
    restaurantId: z.string().min(1).max(80),
    date: DateSchema,
    time: TimeSchema,
    startsAt: z.string().datetime({ offset: true }),
    partySize: z.number().int().positive().max(50),
    seatingType: SeatingTypeSchema,
    diningArea: DiningAreaOptionSchema,
    reservationKind: z.object({ kind: z.literal("standard") }).strict(),
    approvedPreview: BookingPreviewSchema,
  })
  .strict();

export const AuthorizeBookingRequestSchema = z
  .object({
    ...requestBaseShape,
    type: z.literal("AUTHORIZE_BOOKING"),
    request: BookingIntentSchema,
  })
  .strict();

export const AuthorizeBookingResultSchema = z
  .object({
    ...baseShape,
    type: z.literal("AUTHORIZE_BOOKING_RESULT"),
    authorizationHandle: z.string().uuid(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const LockSlotRequestSchema = z
  .object({
    ...requestBaseShape,
    type: z.literal("LOCK_SLOT"),
    authorizationHandle: z.string().uuid(),
    request: BookingIntentSchema,
  })
  .strict();

export const LockSlotResultSchema = z
  .object({
    ...baseShape,
    type: z.literal("LOCK_SLOT_RESULT"),
    outcome: z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("LOCK_CONFIRMED"),
        operationId: MessageIdSchema,
        preparedHandle: z.string().uuid(),
        expiresAt: z.string().datetime({ offset: true }),
      }),
      z.strictObject({ status: z.literal("LOCK_REJECTED"), message: z.string().min(1).max(500) }),
      z.strictObject({ status: z.literal("LOCK_NOT_DISPATCHED"), message: z.string().min(1).max(500) }),
      z.strictObject({ status: z.literal("LOCK_OUTCOME_UNKNOWN"), message: z.string().min(1).max(500) }),
    ]),
  })
  .strict();

export const AcknowledgeLockRequestSchema = z.strictObject({
  ...requestBaseShape,
  type: z.literal("ACKNOWLEDGE_LOCK"),
  operationId: MessageIdSchema,
  preparedHandle: z.string().uuid(),
});

export const AcknowledgeLockResultSchema = z.strictObject({
  ...baseShape,
  type: z.literal("ACKNOWLEDGE_LOCK_RESULT"),
  acknowledged: z.literal(true),
});

export const RevalidatePreparedBookingRequestSchema = z.strictObject({
  ...requestBaseShape,
  type: z.literal("REVALIDATE_PREPARED_BOOKING"),
  preparedHandle: z.string().uuid(),
  request: BookingIntentSchema,
});

export const RevalidatePreparedBookingResultSchema = z.strictObject({
  ...baseShape,
  type: z.literal("REVALIDATE_PREPARED_BOOKING_RESULT"),
  preparedHandle: z.string().uuid(),
  request: BookingIntentSchema,
  data: SafeBookingPreviewDataSchema,
});

export const LockProgressSchema = z.strictObject({
  ...baseShape,
  type: z.literal("LOCK_PROGRESS"),
  stage: z.nativeEnum(LockTelemetryStage),
  elapsedMs: z.number().int().nonnegative(),
  outcome: z.enum(["LOCK_NOT_DISPATCHED", "LOCK_REJECTED", "LOCK_CONFIRMED", "LOCK_OUTCOME_UNKNOWN"]).optional(),
});

export const AbandonLockOperationSchema = z.strictObject({
  ...baseShape,
  type: z.literal("ABANDON_LOCK_OPERATION"),
  reason: z.enum(["DEADLINE", "CONTROLLER_DISCONNECTED", "BRIDGE_DISCONNECTED"]),
});

export const SubmitReservationRequestSchema = z
  .object({
    ...requestBaseShape,
    type: z.literal("SUBMIT_RESERVATION"),
    preparedHandle: z.string().uuid(),
    request: BookingIntentSchema,
  })
  .strict();

export const SubmitReservationResultSchema = z
  .object({
    ...baseShape,
    type: z.literal("SUBMIT_RESERVATION_RESULT"),
    result: z.discriminatedUnion("status", [
      z.object({ status: z.literal("confirmed"), confirmation: BookingConfirmationSchema }).strict(),
      z.object({ status: z.literal("outcome-unknown"), message: z.string().min(1).max(500) }).strict(),
    ]),
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
  "BOOKING_AUTHORIZATION_INVALID",
  "BOOKING_AUTHORIZATION_EXPIRED",
  "BOOKING_INVARIANT_MISMATCH",
  "LOCK_REJECTED",
  "LOCK_NOT_DISPATCHED",
  "LOCK_OUTCOME_UNKNOWN",
  "LOCK_EXPIRED",
  "REVALIDATION_OUTCOME_UNKNOWN",
  "TERMS_CHANGED",
  "PAYMENT_REQUIRED",
  "SCA_REQUIRED",
  "SUBMISSION_REJECTED",
  "SUBMISSION_OUTCOME_UNKNOWN",
  "DUPLICATE_SUBMISSION_PREVENTED",
]);

export const ErrorMessageSchema = z
  .object({
    ...baseShape,
    type: z.literal("ERROR"),
    code: BridgeErrorCodeSchema,
    message: z.string().min(1).max(800),
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
  ListDiningAreasRequestSchema,
  ListDiningAreasResultSchema,
  GetBookingPreviewRequestSchema,
  GetBookingPreviewResultSchema,
  AuthorizeBookingRequestSchema,
  AuthorizeBookingResultSchema,
  LockSlotRequestSchema,
  LockSlotResultSchema,
  AcknowledgeLockRequestSchema,
  AcknowledgeLockResultSchema,
  RevalidatePreparedBookingRequestSchema,
  RevalidatePreparedBookingResultSchema,
  LockProgressSchema,
  AbandonLockOperationSchema,
  SubmitReservationRequestSchema,
  SubmitReservationResultSchema,
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
export type ListDiningAreasRequest = z.infer<typeof ListDiningAreasRequestSchema>;
export type ListDiningAreasResult = z.infer<typeof ListDiningAreasResultSchema>;
export type GetBookingPreviewRequest = z.infer<
  typeof GetBookingPreviewRequestSchema
>;
export type GetBookingPreviewResult = z.infer<
  typeof GetBookingPreviewResultSchema
>;
export type BookingIntent = z.infer<typeof BookingIntentSchema>;
export type AuthorizeBookingRequest = z.infer<typeof AuthorizeBookingRequestSchema>;
export type AuthorizeBookingResult = z.infer<typeof AuthorizeBookingResultSchema>;
export type LockSlotRequest = z.infer<typeof LockSlotRequestSchema>;
export type LockSlotResult = z.infer<typeof LockSlotResultSchema>;
export type AcknowledgeLockRequest = z.infer<typeof AcknowledgeLockRequestSchema>;
export type AcknowledgeLockResult = z.infer<typeof AcknowledgeLockResultSchema>;
export type RevalidatePreparedBookingRequest = z.infer<typeof RevalidatePreparedBookingRequestSchema>;
export type RevalidatePreparedBookingResult = z.infer<typeof RevalidatePreparedBookingResultSchema>;
export type LockProgress = z.infer<typeof LockProgressSchema>;
export type AbandonLockOperation = z.infer<typeof AbandonLockOperationSchema>;
export type SubmitReservationRequest = z.infer<typeof SubmitReservationRequestSchema>;
export type SubmitReservationResult = z.infer<typeof SubmitReservationResultSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

export function parseBridgeMessage(raw: string): BridgeMessage {
  return BridgeMessageSchema.parse(JSON.parse(raw) as unknown);
}

export function bridgeUrl(port = DEFAULT_BRIDGE_PORT): string {
  return `ws://${DEFAULT_BRIDGE_HOST}:${port}`;
}
