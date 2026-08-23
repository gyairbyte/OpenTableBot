const REQUEST_MARKER = "opentablebot:availability-request";
const RESPONSE_MARKER = "opentablebot:availability-response";
const APOLLO_OPERATION_NAME = "RestaurantsAvailability";
const APOLLO_WRAPPED_MARKER = "__opentablebotAvailabilityWrapped";
const FETCH_WRAPPED_MARKER = "__opentablebotAvailabilityFetchWrapped";

interface ApolloOperation {
  readonly operationName?: string;
  readonly query?: unknown;
  readonly variables?: unknown;
}

interface ObservableLike {
  subscribe(observer: unknown): unknown;
}

type LinkRequest = (operation: ApolloOperation, forward?: unknown) => ObservableLike;
type MarkedFetch = typeof fetch & { [FETCH_WRAPPED_MARKER]?: true };

interface ApolloClientLike {
  link?: { request?: LinkRequest & { [APOLLO_WRAPPED_MARKER]?: true } };
  query?(options: {
    query: unknown;
    variables: Record<string, unknown>;
    fetchPolicy: "no-cache";
    errorPolicy: "all";
  }): Promise<unknown>;
}

interface ApolloWindow extends Window {
  __APOLLO_CLIENT__?: ApolloClientLike;
  fetch: MarkedFetch;
}

interface PageRequest {
  readonly marker: typeof REQUEST_MARKER;
  readonly id: string;
  readonly variables: Record<string, unknown>;
}

interface AvailabilityFetchTemplate {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly credentials: RequestCredentials;
  readonly payloadWasArray: boolean;
  readonly operation: Record<string, unknown>;
}

const availabilityFetchTemplates: AvailabilityFetchTemplate[] = [];
let availabilityDocument: unknown;
let availabilityApolloVariables: Record<string, unknown> | undefined;
let messageListenerInstalled = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePageRequest(value: unknown): PageRequest | undefined {
  if (!isRecord(value) || value.marker !== REQUEST_MARKER) return undefined;
  if (typeof value.id !== "string" || !isRecord(value.variables)) return undefined;
  return { marker: REQUEST_MARKER, id: value.id, variables: value.variables };
}

export function findAvailabilityOperation(value: unknown): {
  readonly operation: Record<string, unknown>;
  readonly payloadWasArray: boolean;
} | undefined {
  const candidates = Array.isArray(value) ? value : [value];
  const operation = candidates.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.operationName === APOLLO_OPERATION_NAME,
  );
  return operation === undefined ? undefined : { operation, payloadWasArray: Array.isArray(value) };
}

export function mergeAvailabilityVariables(
  captured: Record<string, unknown>,
  requested: Record<string, unknown>,
): Record<string, unknown> {
  const restaurantIds = Array.isArray(requested.restaurantIds)
    ? requested.restaurantIds.map(String)
    : [];
  const tokenValues = Array.isArray(captured.restaurantAvailabilityTokens)
    ? captured.restaurantAvailabilityTokens
    : undefined;
  const keyedTokens = tokenValues?.filter(
    (candidate) =>
      isRecord(candidate) &&
      restaurantIds.includes(String(candidate.restaurantId)),
  );
  const capturedRestaurantIds = Array.isArray(captured.restaurantIds)
    ? captured.restaurantIds.map(String)
    : [];
  const capturedTime = typeof captured.time === "string" ? captured.time.slice(0, 5) : undefined;
  const requestExactlyMatchesPage =
    restaurantIds.length > 0 &&
    restaurantIds.every((id) => capturedRestaurantIds.includes(id)) &&
    captured.date === requested.date &&
    capturedTime === requested.time &&
    String(captured.partySize) === String(requested.partySize) &&
    (captured.databaseRegion === undefined ||
      requested.databaseRegion === undefined ||
      captured.databaseRegion === requested.databaseRegion);
  if (requestExactlyMatchesPage) return { ...captured };
  const positionalTokens =
    tokenValues !== undefined && tokenValues.length === capturedRestaurantIds.length
      ? tokenValues.filter((_token, index) =>
          restaurantIds.includes(capturedRestaurantIds[index] ?? ""),
        )
      : [];
  const capturedTokens =
    tokenValues === undefined
      ? undefined
      : keyedTokens !== undefined && keyedTokens.length > 0
        ? keyedTokens
        : positionalTokens;
  const approvedOverrides = {
    ...(Array.isArray(requested.restaurantIds)
      ? { restaurantIds: requested.restaurantIds }
      : {}),
    ...(typeof requested.date === "string" ? { date: requested.date } : {}),
    ...(typeof requested.time === "string" ? { time: requested.time } : {}),
    ...(typeof requested.partySize === "number"
      ? { partySize: requested.partySize }
      : {}),
    ...(typeof requested.databaseRegion === "string"
      ? { databaseRegion: requested.databaseRegion }
      : {}),
  };
  return {
    ...captured,
    ...approvedOverrides,
    ...(capturedTokens === undefined
      ? {}
      : { restaurantAvailabilityTokens: capturedTokens }),
  };
}

function allowedAvailabilityUrl(rawUrl: string, targetWindow: Window): boolean {
  try {
    const url = new URL(rawUrl, targetWindow.location.href);
    return url.protocol === "https:" && url.hostname === "www.opentable.com";
  } catch {
    return false;
  }
}

async function captureAvailabilityFetch(
  targetWindow: ApolloWindow,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<void> {
  let request: Request;
  try {
    request = new Request(input, init);
  } catch {
    return;
  }
  if (request.method !== "POST" || !allowedAvailabilityUrl(request.url, targetWindow)) return;
  let payload: unknown;
  try {
    payload = JSON.parse(await request.clone().text()) as unknown;
  } catch {
    return;
  }
  const found = findAvailabilityOperation(payload);
  if (found === undefined) return;
  availabilityFetchTemplates.push({
    url: request.url,
    method: request.method,
    headers: new Headers(request.headers),
    credentials: request.credentials,
    operation: found.operation,
    payloadWasArray: found.payloadWasArray,
  });
  if (availabilityFetchTemplates.length > 20) availabilityFetchTemplates.shift();
}

function selectAvailabilityFetchTemplate(
  variables: Record<string, unknown>,
): AvailabilityFetchTemplate | undefined {
  const requestedIds = Array.isArray(variables.restaurantIds)
    ? variables.restaurantIds.map(String)
    : [];
  return availabilityFetchTemplates
    .toReversed()
    .find((template) => {
      const capturedVariables = isRecord(template.operation.variables)
        ? template.operation.variables
        : {};
      const capturedIds = Array.isArray(capturedVariables.restaurantIds)
        ? capturedVariables.restaurantIds.map(String)
        : [];
      return requestedIds.length > 0 && requestedIds.every((id) => capturedIds.includes(id));
    });
}

async function executeCapturedAvailability(
  targetWindow: ApolloWindow,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const template = selectAvailabilityFetchTemplate(variables);
  if (template === undefined) {
    throw new Error("The RestaurantsAvailability operation has not been observed on this page");
  }
  const capturedVariables = isRecord(template.operation.variables)
    ? template.operation.variables
    : {};
  const mergedVariables = mergeAvailabilityVariables(capturedVariables, variables);
  const operation = { ...template.operation, variables: mergedVariables };
  const body = JSON.stringify(template.payloadWasArray ? [operation] : operation);
  const response = await targetWindow.fetch(template.url, {
    method: template.method,
    headers: template.headers,
    credentials: template.credentials,
    body,
  });
  if (!response.ok) {
    const tokenCount = Array.isArray(mergedVariables.restaurantAvailabilityTokens)
      ? mergedVariables.restaurantAvailabilityTokens.length
      : 0;
    throw new Error(
      `RestaurantsAvailability returned HTTP ${response.status}; captured variable keys: ${Object.keys(capturedVariables).sort().join(",").slice(0, 220)}; matching page token count: ${tokenCount}`,
    );
  }
  const payload = (await response.json()) as unknown;
  return template.payloadWasArray && Array.isArray(payload) ? payload[0] : payload;
}

function respond(
  targetWindow: Window,
  pageRequest: PageRequest,
  result: { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string },
): void {
  targetWindow.postMessage(
    { marker: RESPONSE_MARKER, id: pageRequest.id, ...result },
    targetWindow.location.origin,
  );
}

function installMessageListener(targetWindow: ApolloWindow): void {
  if (messageListenerInstalled) return;
  messageListenerInstalled = true;
  targetWindow.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== targetWindow) return;
    const pageRequest = parsePageRequest(event.data);
    if (pageRequest === undefined) return;
    const operation =
      availabilityFetchTemplates.length > 0
        ? executeCapturedAvailability(targetWindow, pageRequest.variables)
        : availabilityDocument !== undefined && targetWindow.__APOLLO_CLIENT__?.query !== undefined
          ? targetWindow.__APOLLO_CLIENT__.query({
            query: availabilityDocument,
            variables: mergeAvailabilityVariables(
              availabilityApolloVariables ?? {},
              pageRequest.variables,
            ),
            fetchPolicy: "no-cache",
            errorPolicy: "all",
          })
          : executeCapturedAvailability(targetWindow, pageRequest.variables);
    void operation
      .then((result) => respond(targetWindow, pageRequest, { ok: true, result }))
      .catch((error: unknown) =>
        respond(targetWindow, pageRequest, {
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 300) : "Availability operation failed",
        }),
      );
  });
}

export function installAvailabilityFetchBridge(targetWindow: ApolloWindow = window): boolean {
  const originalFetch = targetWindow.fetch;
  if (originalFetch[FETCH_WRAPPED_MARKER] === true) return true;
  const wrapped: MarkedFetch = (input, init) => {
    void captureAvailabilityFetch(targetWindow, input, init);
    return originalFetch.call(targetWindow, input, init);
  };
  wrapped[FETCH_WRAPPED_MARKER] = true;
  targetWindow.fetch = wrapped;
  installMessageListener(targetWindow);
  return true;
}

export function installAvailabilityApolloBridge(targetWindow: ApolloWindow = window): boolean {
  const client = targetWindow.__APOLLO_CLIENT__;
  const request = client?.link?.request;
  if (client?.query === undefined || request === undefined) return false;
  if (request[APOLLO_WRAPPED_MARKER] === true) return true;
  const wrapped: LinkRequest & { [APOLLO_WRAPPED_MARKER]?: true } = (operation, forward) => {
    if (operation.operationName === APOLLO_OPERATION_NAME && operation.query !== undefined) {
      availabilityDocument = operation.query;
      availabilityApolloVariables = isRecord(operation.variables)
        ? operation.variables
        : undefined;
    }
    return request.call(client.link, operation, forward);
  };
  wrapped[APOLLO_WRAPPED_MARKER] = true;
  client.link!.request = wrapped;
  installMessageListener(targetWindow);
  return true;
}

if (typeof window !== "undefined") {
  installAvailabilityFetchBridge();
  const polling = window.setInterval(() => {
    installAvailabilityFetchBridge();
    installAvailabilityApolloBridge();
  }, 100);
  window.setTimeout(() => window.clearInterval(polling), 60_000);
}
