import { OpenTablePageUrlSchema } from "../../src/opentable/bridge/protocol.js";

/** The single OpenTable page the bridge is currently bound to. */
export interface ActivePage {
  readonly tabId: number;
  readonly pageUrl: string;
}

/**
 * Validate a value restored from chrome.storage.session. Persisting the active
 * page lets the MV3 service worker re-establish readiness after an idle
 * teardown instead of losing it until the next page load.
 */
export function parseActivePage(value: unknown): ActivePage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { tabId, pageUrl } = record;
  if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) {
    return undefined;
  }
  if (typeof pageUrl !== "string" || !OpenTablePageUrlSchema.safeParse(pageUrl).success) {
    return undefined;
  }
  return { tabId, pageUrl };
}
