import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  AdapterFailureCategory,
  OpenTableAdapterError,
} from "../errors.js";
import {
  AvailabilityResponseObserver,
  type AvailabilityObservationOutcome,
} from "./availability-observer.js";
import {
  classifyOpenTablePage,
  OpenTablePageKind,
  type OpenTablePageEvidence,
} from "./page-classifier.js";

const OPENTABLE_HOME_URL = "https://www.opentable.com/";
const OPENTABLE_AUTH_CHECK_URL =
  "https://www.opentable.com/user/dining-dashboard";

export interface BrowserAvailabilityResult {
  readonly pageEvidence: OpenTablePageEvidence;
  readonly outcome: AvailabilityObservationOutcome;
}

export interface OpenTableBrowserSessionPort {
  start(): Promise<void>;
  close(): Promise<void>;
  openLoginPage(): Promise<void>;
  getAuthenticationEvidence(): Promise<OpenTablePageEvidence>;
  observeAvailability(
    pageUrl: string,
    timeoutMs: number,
  ): Promise<BrowserAvailabilityResult>;
}

export interface OpenTableBrowserSessionOptions {
  readonly profileDirectory?: string;
  readonly headless?: boolean;
  readonly channel?: string;
}

export function resolveOpenTableProfileDirectory(
  override = process.env.OPENTABLE_BROWSER_PROFILE_DIR,
): string {
  const configuredDirectory = override?.trim();
  return path.resolve(
    configuredDirectory && configuredDirectory.length > 0
      ? configuredDirectory
      : path.join(process.cwd(), ".local", "opentable-browser-profile"),
  );
}

async function existingSignal(page: Page, selector: string): Promise<boolean> {
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    return false;
  }
}

async function collectPageEvidence(
  page: Page,
  httpStatus?: number,
): Promise<OpenTablePageEvidence> {
  const authenticatedSignals: string[] = [];
  const unauthenticatedSignals: string[] = [];
  const authenticatedSelectors: readonly [string, string][] = [
    ["account-navigation", 'a[href*="/user/"]'],
    ["profile-control", '[data-test*="profile" i], [data-testid*="profile" i]'],
    ["account-control", 'button[aria-label*="account" i], button[aria-label*="profile" i]'],
  ];
  const unauthenticatedSelectors: readonly [string, string][] = [
    ["login-link", 'a[href*="/login" i], a[href*="/signin" i], a[href*="/sign-in" i]'],
    ["sign-in-control", 'button:has-text("Sign in"), a:has-text("Sign in")'],
  ];

  for (const [name, selector] of authenticatedSelectors) {
    if (await existingSignal(page, selector)) authenticatedSignals.push(name);
  }
  for (const [name, selector] of unauthenticatedSelectors) {
    if (await existingSignal(page, selector)) unauthenticatedSignals.push(name);
  }

  const url = page.url();
  let title = "";
  let bodyText = "";
  try {
    title = await page.title();
  } catch {
    // Missing title remains an explicit absence of evidence.
  }
  try {
    bodyText = (await page.locator("body").innerText({ timeout: 2_000 })).slice(
      0,
      20_000,
    );
  } catch {
    // Missing body text remains an explicit absence of evidence.
  }

  if (/\/user\//i.test(url)) authenticatedSignals.push("authenticated-url");
  if (
    /my reservations|upcoming reservations|past reservations|dining history|my profile/i.test(
      bodyText,
    )
  ) {
    authenticatedSignals.push("authenticated-content");
  }
  if (/\bsign in\b|\blog in\b|create an account|join opentable/i.test(bodyText)) {
    unauthenticatedSignals.push("unauthenticated-content");
  }

  return {
    url,
    title,
    bodyText,
    authenticatedSignals,
    unauthenticatedSignals,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

export class OpenTableBrowserSession implements OpenTableBrowserSessionPort {
  private context: BrowserContext | undefined;
  private page: Page | undefined;

  constructor(private readonly options: OpenTableBrowserSessionOptions = {}) {}

  async start(): Promise<void> {
    if (this.context !== undefined) return;
    try {
      this.context = await chromium.launchPersistentContext(
        resolveOpenTableProfileDirectory(this.options.profileDirectory),
        {
          channel: this.options.channel ?? "chrome",
          headless: this.options.headless ?? false,
          viewport: null,
        },
      );
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
    } catch (error) {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.UNKNOWN,
        "Could not launch the dedicated OpenTable browser profile with installed Chrome",
        { cause: error },
      );
    }
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
  }

  async openLoginPage(): Promise<void> {
    const page = await this.requirePage();
    await this.navigate(page, OPENTABLE_HOME_URL);
  }

  async getAuthenticationEvidence(): Promise<OpenTablePageEvidence> {
    const page = await this.requirePage();
    const response = await this.navigate(page, OPENTABLE_AUTH_CHECK_URL);
    await page.waitForTimeout(1_500);
    return collectPageEvidence(page, response?.status());
  }

  async observeAvailability(
    pageUrl: string,
    timeoutMs: number,
  ): Promise<BrowserAvailabilityResult> {
    const page = await this.requirePage();
    const observer = new AvailabilityResponseObserver(page);
    observer.start();
    try {
      const response = await this.navigate(page, pageUrl);
      const pageEvidence = await collectPageEvidence(page, response?.status());
      const classification = classifyOpenTablePage(pageEvidence);
      const safetyFailureKinds = new Set<OpenTablePageKind>([
        OpenTablePageKind.CHALLENGE,
        OpenTablePageKind.ACCESS_DENIED,
        OpenTablePageKind.RATE_LIMITED,
        OpenTablePageKind.UNAUTHENTICATED,
      ]);
      const safetyFailure = safetyFailureKinds.has(classification.kind);
      const outcome = safetyFailure
        ? ({ kind: "not-observed" } as const)
        : await observer.wait(timeoutMs);
      return { pageEvidence, outcome };
    } finally {
      observer.stop();
    }
  }

  private async requirePage(): Promise<Page> {
    await this.start();
    if (this.page === undefined) {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.UNKNOWN,
        "Browser session did not create a page",
      );
    }
    return this.page;
  }

  private async navigate(page: Page, url: string) {
    try {
      return await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch (error) {
      throw new OpenTableAdapterError(
        AdapterFailureCategory.TRANSIENT_TRANSPORT,
        "Normal browser navigation did not complete",
        { cause: error },
      );
    }
  }
}
