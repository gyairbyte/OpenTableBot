import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import { evaluateBookingPreview } from "../domain/booking-policy.js";
import { BookingTargetSchema, type BookingTarget } from "../domain/booking-target.js";
import type { DiningAreaOption } from "../domain/dining-area.js";
import {
  IanaTimeZoneSchema,
  LocalDateSchema,
  LocalTimeSchema,
} from "../domain/primitives.js";
import type { BookingPreview, ReservationSlot } from "../domain/reservation-slot.js";
import { TargetState, canTransitionTarget } from "../domain/target-state.js";
import type { RestaurantSearchQuery } from "../opentable/adapter.js";
import type { SafeSearchResults } from "../opentable/browser/search-types.js";
import { SearchRestaurantsRequestPayloadSchema } from "../opentable/bridge/protocol.js";
import { AdapterFailureCategory, OpenTableAdapterError } from "../opentable/errors.js";
import { TargetStoreConflictError } from "../storage/file-target-store.js";
import type { RemovableTargetStore, TargetRecord } from "../storage/target-store.js";
import { FRONTEND_HTML } from "./frontend.js";

const MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_UI_HOST = "127.0.0.1";
export const DEFAULT_UI_PORT = 8790;

/**
 * States a stored definition may be rewritten from. Mid-flight and terminal
 * states are excluded so an edit cannot change the terms of a booking that is
 * already being locked, submitted, or finished.
 */
const EDITABLE_TARGET_STATES: readonly TargetState[] = [
  TargetState.DRAFT,
  TargetState.ARMED,
  TargetState.WAITING,
  TargetState.PAUSED,
  TargetState.SLOT_LOST,
];

export interface UiTargetStore extends RemovableTargetStore {
  list(): Promise<readonly TargetRecord[]>;
}

export interface UiAdapter {
  searchRestaurants(query: RestaurantSearchQuery): Promise<SafeSearchResults>;
  findSlots(target: BookingTarget): Promise<readonly ReservationSlot[]>;
  getBookingPreview(
    target: BookingTarget,
    slot: ReservationSlot,
  ): Promise<BookingPreview>;
}

const ProbeRequestSchema = z.strictObject({
  restaurantId: z.string().min(1).max(80),
  restaurantName: z.string().min(1).max(200),
  timeZone: IanaTimeZoneSchema,
  date: LocalDateSchema,
  partySize: z.number().int().min(1).max(20),
  earliest: LocalTimeSchema,
  latest: LocalTimeSchema,
  preferred: LocalTimeSchema,
});

/** Selection fields of a preview request; the target is validated separately. */
const PreviewSelectionSchema = z.object({
  time: LocalTimeSchema.optional(),
  diningAreaLabel: z.string().min(1).max(80).optional(),
});

/** Permissive policy for a read-only probe: it can never authorize a booking. */
const PROBE_BOOKING_POLICY = {
  allowPrepaid: true,
  maxAuthorizedPrepaidCents: 0,
  maxAuthorizedCancellationNoShowCents: 0,
  currency: "USD",
  allowExperiences: true,
  allowPaymentMethodRequired: true,
  autoBookAuthorized: false,
} as const;

export interface UiRuntimeStatus {
  readonly bridgeReachable: boolean;
  readonly authenticated: boolean;
  readonly mode: "dry-run" | "execute";
  readonly stateDirectory: string;
  readonly lastTickAt?: string;
  readonly lastTickError?: string;
  /** Set when this console is deliberately not running targets. */
  readonly schedulerSkippedReason?: string;
}

export interface UiServerOptions {
  readonly store: UiTargetStore;
  readonly adapter: UiAdapter;
  readonly status: () => Promise<UiRuntimeStatus>;
  readonly host?: string;
  readonly port?: number;
  readonly now?: () => Date;
}

export interface UiServerAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Categories the operator must resolve in the paired browser session. */
const browserSessionCategories: ReadonlySet<AdapterFailureCategory> = new Set([
  AdapterFailureCategory.AUTHENTICATION_REQUIRED,
  AdapterFailureCategory.AUTHENTICATION_EXPIRED,
  AdapterFailureCategory.CAPTCHA_OR_CHALLENGE,
  AdapterFailureCategory.ACCESS_CONTROL_RESPONSE,
  AdapterFailureCategory.RATE_LIMITED,
]);

function statusForAdapterError(error: OpenTableAdapterError): number {
  if (error.category === AdapterFailureCategory.TRANSIENT_TRANSPORT) return 503;
  return browserSessionCategories.has(error.category) ? 409 : 502;
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendError(
  response: ServerResponse,
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  sendJson(response, status, { ok: false, error: { message, ...extra } });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function zodIssues(error: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(error) || !Array.isArray(error.issues)) return [];
  return error.issues
    .filter(isRecord)
    .map((issue) => ({
      path: Array.isArray(issue.path) ? issue.path.map(String).join(".") : "",
      message: typeof issue.message === "string" ? issue.message : "Invalid value",
    }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown operator console failure";
}

/**
 * Local operator console. It is a loopback-only HTTP server that exposes the
 * paired browser session (search), the durable target store (task CRUD), and
 * the scheduler status. Mutations require a JSON body, so a cross-site HTML
 * form cannot reach them, and the socket never leaves 127.0.0.1.
 */
export class UiServer {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly now: () => Date;
  private server: Server | undefined;

  constructor(private readonly options: UiServerOptions) {
    this.host = options.host ?? DEFAULT_UI_HOST;
    this.requestedPort = options.port ?? DEFAULT_UI_PORT;
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<UiServerAddress> {
    if (this.server !== undefined) throw new Error("Operator console is already running");
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.requestedPort, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : this.requestedPort;
    return { host: this.host, port, url: `http://${this.host}:${port}` };
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
      server.closeAllConnections();
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      await this.route(request, response);
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(response, error.status, error.message, error.extra);
        return;
      }
      if (error instanceof TargetStoreConflictError) {
        sendError(response, 409, error.message, { reason: "VERSION_CONFLICT" });
        return;
      }
      if (error instanceof OpenTableAdapterError) {
        sendError(response, statusForAdapterError(error), error.message, {
          category: error.category,
          disposition: error.disposition,
        });
        return;
      }
      sendError(response, 500, describeError(error));
    }
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? this.host}`);
    const path = url.pathname;

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      const body = FRONTEND_HTML;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }
    if (method === "GET" && path === "/api/status") {
      sendJson(response, 200, { ok: true, status: await this.options.status() });
      return;
    }
    if (method === "GET" && path === "/api/search") {
      const payload = SearchRestaurantsRequestPayloadSchema.safeParse({
        term: (url.searchParams.get("term") ?? "").trim(),
        ...(url.searchParams.get("date") === null
          ? {}
          : { date: url.searchParams.get("date") ?? "" }),
        ...(url.searchParams.get("time") === null
          ? {}
          : { time: url.searchParams.get("time") ?? "" }),
        ...(url.searchParams.get("partySize") === null
          ? {}
          : { partySize: Number(url.searchParams.get("partySize")) }),
      });
      if (!payload.success) {
        throw new HttpError(400, "Search query is invalid", {
          issues: zodIssues(payload.error),
        });
      }
      const results = await this.options.adapter.searchRestaurants(payload.data);
      sendJson(response, 200, { ok: true, results: results.results });
      return;
    }
    if (method === "POST" && path === "/api/probe") {
      this.assertJsonMutation(request);
      const body = await readJsonBody(request);
      const payload = ProbeRequestSchema.safeParse(body);
      if (!payload.success) {
        throw new HttpError(400, "Availability probe is invalid", {
          issues: zodIssues(payload.error),
        });
      }
      sendJson(response, 200, { ok: true, probe: await this.probe(payload.data) });
      return;
    }
    if (method === "POST" && path === "/api/preview") {
      this.assertJsonMutation(request);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new HttpError(400, "Request body must be a JSON object");
      const selection = PreviewSelectionSchema.safeParse(body);
      if (!selection.success) {
        throw new HttpError(400, "Preview selection is invalid", {
          issues: zodIssues(selection.error),
        });
      }
      const target = this.parseTarget(isRecord(body.target) ? body.target : body);
      sendJson(response, 200, {
        ok: true,
        preview: await this.preview(target, selection.data),
      });
      return;
    }
    if (method === "GET" && path === "/api/targets") {
      const records = await this.options.store.list();
      sendJson(response, 200, {
        ok: true,
        targets: [...records].sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt),
        ),
      });
      return;
    }
    if (method === "POST" && path === "/api/targets") {
      this.assertJsonMutation(request);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new HttpError(400, "Request body must be a JSON object");
      const target = this.parseTarget(isRecord(body.target) ? body.target : body);
      const timestamp = this.now().toISOString();
      const saved = await this.options.store.save(
        {
          target,
          state: body.arm === true ? TargetState.ARMED : TargetState.DRAFT,
          version: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        0,
      );
      sendJson(response, 201, { ok: true, target: saved });
      return;
    }

    const transition = /^\/api\/targets\/([^/]+)\/state$/.exec(path);
    if (method === "POST" && transition !== null) {
      this.assertJsonMutation(request);
      const targetId = decodeURIComponent(transition[1] ?? "");
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new HttpError(400, "Request body must be a JSON object");
      const action = body.action;
      if (action !== "arm" && action !== "pause") {
        throw new HttpError(400, "action must be arm or pause");
      }
      const record = await this.options.store.get(targetId);
      if (record === undefined) {
        throw new HttpError(404, `Target ${targetId} was not found`);
      }
      const nextState = action === "arm" ? TargetState.ARMED : TargetState.PAUSED;
      if (!canTransitionTarget(record.state, nextState)) {
        throw new HttpError(
          409,
          `Cannot ${action} a target in state ${record.state}`,
          { reason: "INVALID_TRANSITION", from: record.state, to: nextState },
        );
      }
      const saved = await this.options.store.save(
        {
          target: record.target,
          state: nextState,
          version: record.version,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          ...(record.confirmation === undefined
            ? {}
            : { confirmation: record.confirmation }),
          ...(nextState === TargetState.PAUSED
            ? { pauseReason: "Paused from the operator console" }
            : {}),
        },
        typeof body.version === "number" ? body.version : record.version,
      );
      sendJson(response, 200, { ok: true, target: saved });
      return;
    }

    const edit = /^\/api\/targets\/([^/]+)$/.exec(path);
    if (method === "PUT" && edit !== null) {
      this.assertJsonMutation(request);
      const targetId = decodeURIComponent(edit[1] ?? "");
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new HttpError(400, "Request body must be a JSON object");
      const record = await this.options.store.get(targetId);
      if (record === undefined) {
        throw new HttpError(404, `Target ${targetId} was not found`);
      }
      if (!EDITABLE_TARGET_STATES.includes(record.state)) {
        throw new HttpError(409, `Cannot edit a target in state ${record.state}`, {
          reason: "NOT_EDITABLE",
          state: record.state,
        });
      }
      const raw = isRecord(body.target) ? body.target : body;
      const target = this.parseTarget({ ...raw, id: targetId });
      const saved = await this.options.store.save(
        {
          target,
          state: record.state,
          version: record.version,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
        typeof body.version === "number" ? body.version : record.version,
      );
      sendJson(response, 200, { ok: true, target: saved });
      return;
    }

    const removal = /^\/api\/targets\/([^/]+)$/.exec(path);
    if (method === "DELETE" && removal !== null) {
      this.assertJsonMutation(request);
      const targetId = decodeURIComponent(removal[1] ?? "");
      const version = Number(url.searchParams.get("version"));
      if (!Number.isInteger(version) || version < 0) {
        throw new HttpError(400, "A non-negative version query parameter is required");
      }
      const record = await this.options.store.get(targetId);
      if (record === undefined) {
        throw new HttpError(404, `Target ${targetId} was not found`);
      }
      await this.options.store.remove(targetId, version);
      sendJson(response, 200, { ok: true, removed: targetId });
      return;
    }

    throw new HttpError(404, `Unknown endpoint: ${method} ${path}`);
  }

  private parseTarget(raw: Record<string, unknown>): BookingTarget {
    const identifier =
      typeof raw.id === "string" && raw.id.trim() !== ""
        ? raw.id.trim()
        : `task-${randomUUID()}`;
    const parsed = BookingTargetSchema.safeParse({ ...raw, id: identifier });
    if (!parsed.success) {
      throw new HttpError(400, "Task definition is invalid", {
        issues: zodIssues(parsed.error),
      });
    }
    return parsed.data;
  }

  /**
   * Reads what the restaurant actually offers for one date and party: the
   * available times and the provider's own dining areas. The probe policy
   * cannot authorize a booking, so this stays a read.
   */
  private async probe(
    request: z.infer<typeof ProbeRequestSchema>,
  ): Promise<{
    readonly times: readonly string[];
    readonly diningAreas: readonly DiningAreaOption[];
    readonly options: readonly {
      readonly time: string;
      readonly label: string;
      readonly category: string;
      readonly reservationKind: string;
    }[];
  }> {
    const target = this.parseTarget({
      id: "probe",
      restaurant: {
        id: request.restaurantId,
        name: request.restaurantName,
        timeZone: request.timeZone,
      },
      dateRange: { startDate: request.date, endDate: request.date },
      partySize: request.partySize,
      timeWindow: {
        earliest: request.earliest,
        latest: request.latest,
        preferred: request.preferred,
      },
      diningAreaPolicy: { mode: "any", selection: "provider-order" },
      bookingPolicy: PROBE_BOOKING_POLICY,
      mode: "cancellation-watch",
    });
    const slots = await this.options.adapter.findSlots(target);
    const areas = new Map<string, DiningAreaOption>();
    for (const slot of slots) {
      if (slot.diningArea === undefined) continue;
      const key = `${slot.diningArea.category}|${slot.diningArea.label}`;
      const existing = areas.get(key);
      if (
        existing === undefined ||
        slot.diningArea.providerOrder < existing.providerOrder
      ) {
        areas.set(key, slot.diningArea);
      }
    }
    return {
      times: [...new Set(slots.map((slot) => slot.localTime))].sort(),
      diningAreas: [...areas.values()].sort(
        (left, right) =>
          left.providerOrder - right.providerOrder ||
          left.label.localeCompare(right.label),
      ),
      options: slots
        .filter((slot) => slot.diningArea !== undefined)
        .map((slot) => ({
          time: slot.localTime,
          label: slot.diningArea?.label ?? "",
          category: slot.diningArea?.category ?? "unknown",
          reservationKind: slot.reservationKind.kind,
        }))
        .sort(
          (left, right) =>
            left.time.localeCompare(right.time) || left.label.localeCompare(right.label),
        ),
    };
  }

  /**
   * Runs the engine's read-only path for one candidate time and reports the
   * exact terms plus the policy decision, so an operator can see a fail-closed
   * rejection before the drop instead of at it.
   */
  private async preview(
    target: BookingTarget,
    selection: z.infer<typeof PreviewSelectionSchema>,
  ): Promise<{
    readonly terms: BookingPreview;
    readonly allowed: boolean;
    readonly reasons: readonly string[];
    readonly time: string;
    readonly diningArea?: DiningAreaOption;
  }> {
    const time = selection.time ?? target.timeWindow.preferred;
    const narrowed: BookingTarget = {
      ...target,
      timeWindow: { earliest: time, latest: time, preferred: time },
    };
    const slots = await this.options.adapter.findSlots(narrowed);
    const slot =
      selection.diningAreaLabel === undefined
        ? slots[0]
        : slots.find((candidate) => candidate.diningArea?.label === selection.diningAreaLabel);
    if (slot === undefined) {
      throw new HttpError(
        409,
        selection.diningAreaLabel === undefined
          ? `No slot at ${time} matched this task's policy`
          : `No ${selection.diningAreaLabel} slot at ${time} matched this task's policy`,
        { reason: "NO_MATCHING_SLOT" },
      );
    }
    const terms = await this.options.adapter.getBookingPreview(target, slot);
    const evaluation = evaluateBookingPreview(target, slot, terms);
    return {
      terms,
      allowed: evaluation.allowed,
      reasons: evaluation.allowed ? [] : evaluation.reasons,
      time: slot.localTime,
      ...(slot.diningArea === undefined ? {} : { diningArea: slot.diningArea }),
    };
  }

  /**
   * Mutations must be same-origin JSON requests. Browsers never send
   * `application/json` from a cross-site HTML form, so this blocks drive-by
   * writes from a page the operator happens to have open.
   */
  private assertJsonMutation(request: IncomingMessage): void {
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      throw new HttpError(415, "Mutations require a JSON content type");
    }
    const origin = request.headers.origin;
    if (origin === undefined) return;
    const host = request.headers.host ?? `${this.host}:${this.requestedPort}`;
    if (origin !== `http://${host}`) {
      throw new HttpError(403, "Cross-origin mutations are not allowed");
    }
  }
}
