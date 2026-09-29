import {
  PAGE_INFO_SCRIPT,
  SafetyPolicy,
  SignalBuffer,
  firstLines,
  slug,
  stripQuery,
  truncate,
  type BrowserDriver,
  type ClientConfig,
  type PageInfo,
  type RunStorage,
  type Signal,
} from "@exploratory-agent/core";
import { chromium, errors, type Browser, type BrowserContext, type Locator, type Page, type Request, type Route } from "playwright";

const ACTIONABILITY_PROBLEM = /intercepts pointer events|not visible|not enabled|not stable|outside of the viewport|not editable|detached/i;

// Playwright buries the reason an element wasn't actionable deep in its call log; pull out the most recent one.
function actionabilityReason(message: string): string | undefined {
  const lines = message
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim());
  const reason = lines.reverse().find((line) => ACTIONABILITY_PROBLEM.test(line));
  return reason ? truncate(reason, 200) : undefined;
}

const SELECTOR_GUIDE = `Targets are Playwright selectors. Prefer, in order:
  role=button[name="Save"]   role=link[name="Pricing"]   role=textbox[name="Email"]
  text="Exact visible text"
  css=input[name="email"]    css=[data-testid="submit"]
Build them from the accessibility snapshot. If one fails, look at a fresh snapshot and adapt rather than retrying the same selector.
A selector that matches more than one element fails with "strict mode violation" instead of silently acting on the first match — when two fields share a name (e.g. two date inputs both called "Select date"), add ">> nth=0" / ">> nth=1", or scope the selector to a container near a distinguishing label, rather than assuming DOM order.`;

export interface PlaywrightDriverOptions {
  storage: RunStorage;
  label: string;
  headless: boolean;
  storageState?: string;
}

export class PlaywrightDriver implements BrowserDriver {
  page!: Page;
  readonly targetHint = 'Playwright selector, e.g. role=button[name="Save"], text="Sign in", css=#email';
  readonly selectorGuide = SELECTOR_GUIDE;

  private browser?: Browser;
  private context?: BrowserContext;
  private ready = false;
  private blockedRequests = new WeakSet<Request>();
  private attachedPages = new WeakSet<Page>();
  private screenshotCount = 0;
  private inflightRequests = new Set<Request>();
  private readonly policy: SafetyPolicy;
  private readonly buffer: SignalBuffer;

  constructor(
    private readonly cfg: ClientConfig,
    private readonly opts: PlaywrightDriverOptions,
  ) {
    this.policy = new SafetyPolicy(cfg);
    this.buffer = new SignalBuffer(cfg, () => this.currentUrl());
  }

  get signals(): Signal[] {
    return this.buffer.signals;
  }

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.opts.headless });
    this.context = await this.browser.newContext({
      viewport: this.cfg.browser.viewport,
      ignoreHTTPSErrors: this.cfg.browser.ignoreHttpsErrors,
      storageState: this.opts.storageState,
    });
    this.context.setDefaultTimeout(this.cfg.browser.actionTimeoutMs);
    this.context.setDefaultNavigationTimeout(this.cfg.browser.navigationTimeoutMs);
    await this.context.route("**/*", (route) => this.guard(route));
    this.context.on("page", (newPage) => {
      if (this.attachedPages.has(newPage)) return;
      this.attach(newPage);
      this.page = newPage;
      if (this.ready) this.buffer.note("A new tab/window opened; subsequent actions apply to it.");
    });
    const firstPage = await this.context.newPage();
    if (!this.attachedPages.has(firstPage)) this.attach(firstPage);
    this.page = firstPage;
    this.ready = true;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }

  isAppUrl(url: string): boolean {
    return this.policy.isAppUrl(url);
  }

  currentUrl(): string {
    try {
      return this.page?.url() ?? "";
    } catch {
      return "";
    }
  }

  private isTopLevelNavigation(request: Request): boolean {
    if (!request.isNavigationRequest()) return false;
    try {
      return request.frame().parentFrame() === null;
    } catch {
      return true;
    }
  }

  private async guard(route: Route): Promise<void> {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    const reason = this.policy.blockReason(url, method, this.isTopLevelNavigation(request));

    if (!reason) {
      await route.continue().catch(() => {});
      return;
    }
    this.blockedRequests.add(request);
    this.push({ kind: "blocked-request", message: this.policy.blockedMessage(url, method, reason), url });
    await route.abort("blockedbyclient").catch(() => {});
  }

  private push(signal: Omit<Signal, "timestamp" | "pageUrl"> & { pageUrl?: string }): void {
    this.buffer.push(signal);
  }

  private attach(page: Page): void {
    this.attachedPages.add(page);

    const markRequestDone = (request: Request) => this.inflightRequests.delete(request);
    page.on("request", (request) => {
      const type = request.resourceType();
      if (type === "xhr" || type === "fetch" || type === "document") this.inflightRequests.add(request);
    });
    page.on("requestfinished", markRequestDone);
    page.on("requestfailed", markRequestDone);

    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const messageText = msg.text();
      const source = msg.location()?.url || undefined;
      if (messageText.includes("ERR_BLOCKED_BY_CLIENT")) return;
      if (messageText.startsWith("Failed to load resource") && source && this.isAppUrl(source)) return;
      this.push({ kind: "console-error", message: truncate(messageText, 500), url: source, pageUrl: page.url() });
    });

    page.on("pageerror", (err) => {
      this.push({ kind: "page-error", message: truncate(`${err.name}: ${err.message}`, 500), pageUrl: page.url() });
    });

    page.on("response", (response) => {
      const status = response.status();
      if (status < 400 || !this.isAppUrl(response.url())) return;
      this.push({
        kind: "http-error",
        status,
        message: `${response.request().method()} ${stripQuery(response.url())} → HTTP ${status}`,
        url: response.url(),
        pageUrl: page.url(),
      });
    });

    page.on("requestfailed", (request) => {
      if (this.blockedRequests.has(request) || !this.isAppUrl(request.url())) return;
      const reason = request.failure()?.errorText ?? "unknown error";
      if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(reason)) return;
      this.push({
        kind: "request-failed",
        message: `${request.method()} ${stripQuery(request.url())} failed: ${reason}`,
        url: request.url(),
        pageUrl: page.url(),
      });
    });

    page.on("dialog", async (dialog) => {
      const accept = this.cfg.browser.acceptDialogs || dialog.type() === "alert" || dialog.type() === "beforeunload";
      this.buffer.note(
        `A ${dialog.type()} dialog appeared: "${truncate(dialog.message(), 200)}" (${accept ? "accepted" : "dismissed"} automatically).`,
      );
      await (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });

    page.on("close", () => {
      if (this.page !== page || !this.context) return;
      const openPages = this.context.pages().filter((candidate) => !candidate.isClosed());
      if (openPages.length) {
        this.page = openPages[openPages.length - 1];
        this.buffer.note("The active tab closed; switched to the remaining tab.");
      }
    });
  }

  drainNew(): string {
    return this.buffer.drain();
  }

  private resolve(url: string): string {
    const base = this.currentUrl().startsWith("http") ? this.currentUrl() : this.cfg.baseUrl;
    return new URL(url, base).toString();
  }

  // Deliberately no .first() here: Playwright's default strict mode throws when a selector
  // matches more than one element, which surfaces ambiguous selectors as a tool failure the
  // agent can react to, instead of silently acting on the wrong (but matching) element.
  private locate(target: string) {
    return this.page.locator(target);
  }

  async settle(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
    const deadline = Date.now() + 4000;
    let quietSince = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 150));
    while (Date.now() < deadline) {
      if (this.inflightRequests.size > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= 300) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async navigate(url: string): Promise<void> {
    const absoluteUrl = this.resolve(url);
    if (!this.policy.isAllowed(absoluteUrl)) {
      throw new Error(`${absoluteUrl} is outside the allowed origins (${[...this.policy.allowedOrigins].join(", ")})`);
    }
    await this.page.goto(absoluteUrl, { waitUntil: "domcontentloaded" });
    await this.settle();
  }

  // Playwright refuses to click when its actionability checks fail (covered by another element,
  // still animating, partly off-screen), even though a real user clicking that spot would succeed —
  // common with custom dropdowns and date pickers. After a short normal attempt, fall back to a real
  // mouse click at the element's on-screen centre, and tell the agent what happened so it can judge
  // whether the obstruction is itself a defect.
  async click(target: string): Promise<void> {
    const locator = this.locate(target);
    await locator.waitFor({ state: "attached" });
    try {
      await locator.click({ timeout: Math.min(this.cfg.browser.actionTimeoutMs, 3000) });
    } catch (err) {
      if (!(err instanceof errors.TimeoutError)) throw err;
      await this.clickAtCentre(target, locator, actionabilityReason(err.message));
    }
    await this.settle();
  }

  private async clickAtCentre(target: string, locator: Locator, reason: string | undefined): Promise<void> {
    const why = reason ? ` (${reason})` : "";
    if (await locator.isDisabled().catch(() => false)) throw new Error(`${target} is disabled${why}`);
    await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const box = await locator.boundingBox();
    const viewport = this.page.viewportSize();
    if (!box || box.width === 0 || box.height === 0) throw new Error(`${target} is not visible${why}`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (viewport && (x < 0 || y < 0 || x > viewport.width || y > viewport.height)) {
      throw new Error(`${target} is outside the visible viewport and could not be scrolled into view${why}`);
    }
    const hit = await locator
      .evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (!top || el === top || el.contains(top) || top.contains(el)) return "";
        const cls = typeof top.className === "string" && top.className ? `.${top.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
        return `<${top.tagName.toLowerCase()}${cls}>`;
      })
      .catch(() => "");
    await this.page.mouse.click(x, y);
    this.buffer.note(
      `Standard click on ${target} was not actionable${why}; clicked its on-screen position with the mouse instead` +
        (hit ? `, where the topmost element is ${hit}, so the click may have landed on that instead.` : ".") +
        " Check the snapshot to confirm it took effect.",
    );
  }

  async fill(target: string, value: string): Promise<void> {
    await this.locate(target).fill(value);
  }

  async press(key: string, target?: string): Promise<void> {
    if (target) await this.locate(target).press(key);
    else await this.page.keyboard.press(key);
    await this.settle();
  }

  async selectOption(target: string, value: string): Promise<void> {
    await this.locate(target).selectOption(value);
    await this.settle();
  }

  async setChecked(target: string, checked: boolean): Promise<void> {
    await this.locate(target).setChecked(checked);
    await this.settle();
  }

  async hover(target: string): Promise<void> {
    await this.locate(target).hover();
  }

  async goBack(): Promise<void> {
    await this.page.goBack({ waitUntil: "domcontentloaded" });
    await this.settle();
  }

  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: "domcontentloaded" });
    await this.settle();
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.page.setViewportSize({ width, height });
    await this.settle();
  }

  async wait(seconds: number): Promise<void> {
    await this.page.waitForTimeout(Math.min(Math.max(seconds, 0), 10) * 1000);
  }

  async snapshot(maxChars: number): Promise<string> {
    const page = this.page;
    const title = await page.title().catch(() => "");
    const viewport = page.viewportSize();
    let tree: string;
    try {
      tree = await page.locator("body").ariaSnapshot({ timeout: 5000 });
    } catch (err) {
      tree = `(accessibility snapshot unavailable: ${firstLines(err instanceof Error ? err.message : String(err), 1)})`;
    }
    return [
      `Page: ${page.url()}`,
      `Title: ${title}`,
      viewport ? `Viewport: ${viewport.width}x${viewport.height}` : "",
      "",
      truncate(tree, maxChars),
    ].join("\n");
  }

  async screenshot(label: string): Promise<{ file: string; base64: string }> {
    this.screenshotCount += 1;
    const name = `${this.opts.label}-${String(this.screenshotCount).padStart(3, "0")}-${slug(label, 30)}.jpg`;
    const file = `screens/${name}`;
    const buffer = await this.page.screenshot({ type: "jpeg", quality: 60 });
    await this.opts.storage.write(file, buffer);
    return { file, base64: buffer.toString("base64") };
  }

  async pageInfo(): Promise<PageInfo | null> {
    return (await this.page.evaluate(PAGE_INFO_SCRIPT)) as PageInfo | null;
  }
}
