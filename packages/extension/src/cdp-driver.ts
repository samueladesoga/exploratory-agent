import {
  PAGE_INFO_SCRIPT,
  SafetyPolicy,
  SignalBuffer,
  slug,
  stripQuery,
  truncate,
  type BrowserDriver,
  type ClientConfig,
  type PageInfo,
  type RunStorage,
  type Signal,
} from "@exploratory-agent/core";
import { formatAxTree, type AxNode } from "./ax-tree.js";
import { keyEvents } from "./keys.js";

const SELECTOR_GUIDE = `Targets are element refs from the accessibility snapshot, written like e42. Every element you can act on is shown with [ref=e42] after its role and name, e.g.
  - button "Save" [ref=e42]      → click with target e42
  - textbox "Email" [ref=e57]    → fill with target e57
Always take refs from the most recent snapshot. A ref stops working once its element leaves the page; if an action says so, look at the fresh snapshot and use the new ref instead of retrying.
Only elements in the main page have refs. Content inside iframes is not shown.`;

const NETWORK_TYPES_TO_SETTLE = new Set(["XHR", "Fetch", "Document"]);

export interface CdpDriverOptions {
  storage: RunStorage;
  label: string;
  // The window to open the testing tab in (the side panel's window).
  windowId?: number;
  // Called if the user dismisses Chrome's "is debugging this browser" bar, which detaches the driver.
  onUserDetach?: () => void;
}

interface TabState {
  mainFrameId?: string;
}

// Drives a Chrome tab through the DevTools Protocol (chrome.debugger), with the same guardrails and
// runtime-signal capture as the CLI's Playwright driver. Each driver opens and owns its own tab, so
// the user's own tabs are never navigated.
export class CdpDriver implements BrowserDriver {
  readonly targetHint = "Element ref from the latest snapshot, e.g. e42";
  readonly selectorGuide = SELECTOR_GUIDE;

  tabId?: number;
  private readonly tabs = new Map<number, TabState>();
  private readonly ownedTabs = new Set<number>();
  private url = "";
  private viewport?: { width: number; height: number };
  private detachedByUser = false;
  private screenshotCount = 0;
  private readonly inflight = new Set<string>();
  // Main-frame loading state of the active tab, from Page events.
  private mainFrameLoading = false;
  // Set when the guard blocks a top-level navigation; Chrome then shows its own error page.
  private blockedNavigation?: string;
  private loadCount = 0;
  private readonly requests = new Map<string, { url: string; method: string }>();
  private readonly blockedUrls = new Set<string>();
  private readonly policy: SafetyPolicy;
  private readonly buffer: SignalBuffer;

  constructor(
    private readonly cfg: ClientConfig,
    private readonly opts: CdpDriverOptions,
  ) {
    this.policy = new SafetyPolicy(cfg);
    this.buffer = new SignalBuffer(cfg, () => this.currentUrl());
  }

  get signals(): Signal[] {
    return this.buffer.signals;
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  async start(): Promise<void> {
    chrome.debugger.onEvent.addListener(this.onEvent);
    chrome.debugger.onDetach.addListener(this.onDetach);
    chrome.tabs.onCreated.addListener(this.onTabCreated);
    chrome.tabs.onRemoved.addListener(this.onTabRemoved);
    const tab = await chrome.tabs.create({ url: "about:blank", active: true, windowId: this.opts.windowId });
    this.ownedTabs.add(tab.id!);
    await this.groupTab(tab.id!);
    this.url = await this.attach(tab.id!);
    this.tabId = tab.id!;
  }

  async close(): Promise<void> {
    chrome.debugger.onEvent.removeListener(this.onEvent);
    chrome.debugger.onDetach.removeListener(this.onDetach);
    chrome.tabs.onCreated.removeListener(this.onTabCreated);
    chrome.tabs.onRemoved.removeListener(this.onTabRemoved);
    for (const tabId of this.tabs.keys()) await chrome.debugger.detach({ tabId }).catch(() => {});
    for (const tabId of this.ownedTabs) await chrome.tabs.remove(tabId).catch(() => {});
    this.tabs.clear();
  }

  private async groupTab(tabId: number): Promise<void> {
    try {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: "Exploratory Agent", color: "purple" });
    } catch {
      // Grouping is cosmetic.
    }
  }

  // Attaches to a tab and returns its current URL.
  private async attach(tabId: number): Promise<string> {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (err) {
      throw new Error(`Could not control the tab (${err instanceof Error ? err.message : String(err)}). Chrome doesn't allow extensions to control some pages, such as chrome:// pages and the Chrome Web Store.`);
    }
    this.tabs.set(tabId, {});
    const send = (method: string, params?: object) => this.send(method, params, tabId);
    await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Log.enable"), send("Network.enable"), send("DOM.enable"), send("Accessibility.enable")]);
    await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    const { frameTree } = await this.send<{ frameTree: { frame: { id: string; url: string } } }>("Page.getFrameTree", {}, tabId);
    this.tabs.get(tabId)!.mainFrameId = frameTree.frame.id;
    return frameTree.frame.url;
  }

  private send<T = Record<string, unknown>>(method: string, params: object = {}, tabId = this.tabId): Promise<T> {
    if (this.detachedByUser) return Promise.reject(new Error("Testing was stopped from Chrome's debugging bar."));
    if (tabId === undefined) return Promise.reject(new Error("The testing tab is not open."));
    return chrome.debugger.sendCommand({ tabId }, method, params as Record<string, unknown>) as unknown as Promise<T>;
  }

  // ---- events ----------------------------------------------------------------------------------

  private readonly onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (source.tabId === undefined || !this.tabs.has(source.tabId)) return;
    this.tabs.delete(source.tabId);
    if (reason === "canceled_by_user") {
      this.detachedByUser = true;
      this.opts.onUserDetach?.();
    }
  };

  private readonly onTabCreated = (tab: chrome.tabs.Tab) => {
    if (tab.id === undefined || tab.openerTabId === undefined || !this.tabs.has(tab.openerTabId)) return;
    this.ownedTabs.add(tab.id);
    void this.attach(tab.id)
      .then((url) => {
        this.tabId = tab.id;
        this.mainFrameLoading = false;
        this.url = url && url !== "about:blank" ? url : (tab.pendingUrl ?? tab.url ?? url);
        this.buffer.note("A new tab/window opened; subsequent actions apply to it.");
      })
      .catch(() => {});
  };

  private readonly onTabRemoved = (tabId: number) => {
    if (!this.tabs.has(tabId)) return;
    this.tabs.delete(tabId);
    this.ownedTabs.delete(tabId);
    if (tabId !== this.tabId) return;
    const remaining = [...this.tabs.keys()];
    this.tabId = remaining[remaining.length - 1];
    if (this.tabId !== undefined) this.buffer.note("The active tab closed; switched to the remaining tab.");
  };

  private readonly onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    const tabId = source.tabId;
    if (tabId === undefined || !this.tabs.has(tabId)) return;
    // Protocol payloads are untyped here; each case reads only the fields it needs.
    const p = (params ?? {}) as any;
    switch (method) {
      case "Fetch.requestPaused":
        void this.guard(tabId, p);
        break;
      case "Page.frameNavigated":
        if (tabId === this.tabId && !p.frame.parentId) this.url = p.frame.url;
        break;
      case "Page.frameStartedLoading":
        if (tabId === this.tabId && p.frameId === this.tabs.get(tabId)?.mainFrameId) this.mainFrameLoading = true;
        break;
      case "Page.frameStoppedLoading":
        if (tabId === this.tabId && p.frameId === this.tabs.get(tabId)?.mainFrameId) this.mainFrameLoading = false;
        break;
      case "Page.loadEventFired":
        if (tabId === this.tabId) this.loadCount += 1;
        break;
      case "Page.navigatedWithinDocument":
        if (tabId === this.tabId && p.frameId === this.tabs.get(tabId)?.mainFrameId) this.url = p.url;
        break;
      case "Page.javascriptDialogOpening": {
        const accept = this.cfg.browser.acceptDialogs || p.type === "alert" || p.type === "beforeunload";
        this.buffer.note(`A ${p.type} dialog appeared: "${truncate(p.message, 200)}" (${accept ? "accepted" : "dismissed"} automatically).`);
        void this.send("Page.handleJavaScriptDialog", { accept }, tabId).catch(() => {});
        break;
      }
      case "Network.requestWillBeSent":
        this.requests.set(p.requestId, { url: p.request.url, method: p.request.method });
        if (NETWORK_TYPES_TO_SETTLE.has(p.type)) this.inflight.add(p.requestId);
        break;
      case "Network.loadingFinished":
        this.inflight.delete(p.requestId);
        break;
      case "Network.loadingFailed": {
        this.inflight.delete(p.requestId);
        const request = this.requests.get(p.requestId);
        if (!request || p.canceled || this.blockedUrls.has(request.url) || !this.policy.isAppUrl(request.url)) break;
        if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT|cancelled/i.test(p.errorText)) break;
        this.buffer.push({ kind: "request-failed", message: `${request.method} ${stripQuery(request.url)} failed: ${p.errorText}`, url: request.url, pageUrl: this.url });
        break;
      }
      case "Network.responseReceived": {
        const status: number = p.response.status;
        const url: string = p.response.url;
        if (status < 400 || !this.policy.isAppUrl(url)) break;
        const requestMethod = this.requests.get(p.requestId)?.method ?? "GET";
        this.buffer.push({ kind: "http-error", status, message: `${requestMethod} ${stripQuery(url)} → HTTP ${status}`, url, pageUrl: this.url });
        break;
      }
      case "Runtime.exceptionThrown": {
        const details = p.exceptionDetails;
        const description: string = details.exception?.description ?? details.text ?? "Uncaught exception";
        this.buffer.push({ kind: "page-error", message: truncate(description.split("\n")[0], 500), pageUrl: this.url });
        break;
      }
      case "Runtime.consoleAPICalled": {
        if (p.type !== "error") break;
        const message = (p.args ?? []).map((arg: any) => arg.value ?? arg.description ?? "").join(" ");
        this.pushConsoleError(message, p.stackTrace?.callFrames?.[0]?.url);
        break;
      }
      case "Log.entryAdded":
        if (p.entry.level === "error") this.pushConsoleError(p.entry.text, p.entry.url);
        break;
    }
  };

  // Same filtering as the Playwright driver: failed app requests are already reported as HTTP or
  // request errors, and our own blocks aren't the app's fault.
  private pushConsoleError(message: string, source: string | undefined): void {
    if (message.includes("ERR_BLOCKED_BY_CLIENT")) return;
    if (message.startsWith("Failed to load resource") && source && this.policy.isAppUrl(source)) return;
    this.buffer.push({ kind: "console-error", message: truncate(message, 500), url: source || undefined, pageUrl: this.url });
  }

  private async guard(tabId: number, p: { requestId: string; request: { url: string; method: string }; frameId: string; resourceType: string }): Promise<void> {
    const isTopLevel = p.resourceType === "Document" && p.frameId === this.tabs.get(tabId)?.mainFrameId;
    const reason = this.policy.blockReason(p.request.url, p.request.method, isTopLevel);
    if (!reason) {
      await this.send("Fetch.continueRequest", { requestId: p.requestId }, tabId).catch(() => {});
      return;
    }
    this.blockedUrls.add(p.request.url);
    if (isTopLevel) this.blockedNavigation = p.request.url;
    this.buffer.push({ kind: "blocked-request", message: this.policy.blockedMessage(p.request.url, p.request.method, reason), url: p.request.url });
    await this.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, tabId).catch(() => {});
  }

  // ---- state -----------------------------------------------------------------------------------

  currentUrl(): string {
    return this.url;
  }

  isAppUrl(url: string): boolean {
    return this.policy.isAppUrl(url);
  }

  drainNew(): string {
    return this.buffer.drain();
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  private async waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (condition()) return true;
      await sleep(50);
    }
    return condition();
  }

  // Runs a navigation and waits for the new document's load event, so snapshots never see the
  // previous page. Same-document navigations (SPA history) don't fire load; the wait just times out
  // briefly for those.
  private async navigation(start: () => Promise<void>, sameDocumentTimeoutMs = this.cfg.browser.navigationTimeoutMs): Promise<void> {
    const loadsBefore = this.loadCount;
    await start();
    await this.waitUntil(() => this.loadCount > loadsBefore, sameDocumentTimeoutMs);
  }

  // Waits for the page to load and for XHR/fetch to go quiet, like the Playwright driver, so runtime
  // signals are attributed to the action that caused them.
  async settle(): Promise<void> {
    await sleep(50);
    await this.waitUntil(() => !this.mainFrameLoading, 3000);
    const deadline = Date.now() + 4000;
    let quietSince = Date.now();
    await sleep(150);
    while (Date.now() < deadline) {
      if (this.inflight.size > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= 300) break;
      await sleep(50);
    }
    await this.leaveBlockedPage();
  }

  // A blocked navigation leaves the tab on Chrome's error page; go back so the agent can carry on.
  private async leaveBlockedPage(): Promise<void> {
    const blocked = this.blockedNavigation;
    this.blockedNavigation = undefined;
    if (!blocked || !this.url.startsWith("chrome-error://")) return;
    const history = await this.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory").catch(() => undefined);
    if (!history || history.currentIndex === 0) return;
    await this.navigation(async () => {
      await this.send("Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex - 1].id });
    }, 3000);
    this.buffer.note(`Navigation to ${stripQuery(blocked)} was blocked by the harness, so the browser went back to the previous page.`);
  }

  // ---- elements --------------------------------------------------------------------------------

  private backendNodeId(target: string): number {
    const match = /^\s*\[?(?:ref=)?e(\d+)\]?\s*$/i.exec(target);
    if (!match) throw new Error(`"${target}" is not an element ref. Use a ref from the latest snapshot, e.g. e42.`);
    return Number(match[1]);
  }

  private async objectId(target: string): Promise<string> {
    try {
      const { object } = await this.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: this.backendNodeId(target) });
      return object.objectId;
    } catch (err) {
      if (err instanceof Error && err.message.includes("not an element ref")) throw err;
      throw new Error(`Element ${target} is no longer on the page. Use a ref from the latest snapshot.`);
    }
  }

  private async callOn<T>(target: string, fn: (this: any, ...args: any[]) => unknown, ...args: unknown[]): Promise<T> {
    const objectId = await this.objectId(target);
    const result = await this.send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fn.toString(),
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const message = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(message.split("\n")[0].replace(/^Error: /, ""));
    }
    return result.result.value;
  }

  // Scrolls the element into view and waits, like Playwright's actionability checks, until it has
  // stopped moving and is the topmost element at its centre (React apps often re-render or shift
  // layout just after a route change). Returns the centre and, if it never became topmost, what covers it.
  private async centre(target: string): Promise<{ x: number; y: number; obstruction: string }> {
    const box = await this.callOn<{ x: number; y: number; width: number; height: number; disabled: boolean; vw: number; vh: number; obstruction: string }>(target, async function (this: any) {
      const el = this.nodeType === 1 ? this : this.parentElement;
      // Two animation frames, or 100ms if the tab isn't rendering frames.
      const frames = () => new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, 100); });
      const measure = () => {
        const rect = el.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        const hit = !top || el === top || el.contains(top) || top.contains(el);
        const cls = top && typeof top.className === "string" && top.className ? `.${top.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
        return { x, y, width: rect.width, height: rect.height, obstruction: hit ? "" : `<${top!.tagName.toLowerCase()}${cls}>` };
      };
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      let previous = measure();
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        await frames();
        const current = measure();
        const stable = current.x === previous.x && current.y === previous.y && current.width === previous.width && current.height === previous.height;
        previous = current;
        if (stable && !current.obstruction) break;
      }
      const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
      return { ...previous, disabled, vw: innerWidth, vh: innerHeight };
    });
    if (box.disabled) throw new Error(`${target} is disabled`);
    if (box.width === 0 || box.height === 0) throw new Error(`${target} is not visible`);
    if (box.x < 0 || box.y < 0 || box.x > box.vw || box.y > box.vh) throw new Error(`${target} is outside the visible viewport and could not be scrolled into view`);
    return { x: box.x, y: box.y, obstruction: box.obstruction };
  }

  private async mouse(type: string, x: number, y: number, extra: object = {}): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
  }

  // ---- actions ---------------------------------------------------------------------------------

  async navigate(url: string): Promise<void> {
    const base = this.url.startsWith("http") ? this.url : this.cfg.baseUrl;
    const absoluteUrl = new URL(url, base).toString();
    if (!this.policy.isAllowed(absoluteUrl)) {
      throw new Error(`${absoluteUrl} is outside the allowed origins (${[...this.policy.allowedOrigins].join(", ")})`);
    }
    const reason = this.policy.blockReason(absoluteUrl, "GET", true);
    if (reason) {
      const message = this.policy.blockedMessage(absoluteUrl, "GET", reason);
      this.buffer.push({ kind: "blocked-request", message, url: absoluteUrl });
      throw new Error(message);
    }
    await this.navigation(async () => {
      const result = await this.send<{ errorText?: string }>("Page.navigate", { url: absoluteUrl });
      if (result.errorText && !/ERR_ABORTED/.test(result.errorText)) throw new Error(`${result.errorText} at ${absoluteUrl}`);
    });
    await this.settle();
  }

  async click(target: string): Promise<void> {
    const { x, y, obstruction } = await this.centre(target);
    await this.mouse("mouseMoved", x, y, { button: "none" });
    await this.mouse("mousePressed", x, y, { clickCount: 1 });
    await this.mouse("mouseReleased", x, y, { clickCount: 1 });
    if (obstruction) {
      this.buffer.note(`${target} is covered at its centre by ${obstruction}, so the click may have landed on that instead. Check the snapshot to confirm it took effect.`);
    }
    await this.settle();
  }

  async fill(target: string, value: string): Promise<void> {
    await this.callOn(target, function (this: any) {
      const el = this.nodeType === 1 ? this : this.parentElement;
      const nonText = ["checkbox", "radio", "button", "submit", "reset", "file", "image", "hidden", "range", "color"];
      const isField = (el.tagName === "INPUT" && !nonText.includes(el.type)) || el.tagName === "TEXTAREA";
      if (!isField && !el.isContentEditable) throw new Error("element is not an editable field");
      if (el.disabled) throw new Error("element is disabled");
      if (el.readOnly) throw new Error("element is read-only");
      el.focus();
      if (isField) {
        el.select();
      } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
    if (value) await this.send("Input.insertText", { text: value });
    else for (const event of keyEvents("Backspace")) await this.send("Input.dispatchKeyEvent", event);
    // Date, time and similar inputs ignore typed text; set their value the way a picker would.
    await this.callOn(
      target,
      function (this: any, wanted: string) {
        const el = this.nodeType === 1 ? this : this.parentElement;
        if (el.tagName !== "INPUT" || el.value === wanted) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(el, wanted);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      value,
    );
  }

  async press(key: string, target?: string): Promise<void> {
    if (target) await this.callOn(target, function (this: any) {
      (this.nodeType === 1 ? this : this.parentElement).focus();
    });
    for (const event of keyEvents(key)) await this.send("Input.dispatchKeyEvent", event);
    await this.settle();
  }

  async selectOption(target: string, value: string): Promise<void> {
    await this.callOn(
      target,
      function (this: any, wanted: string) {
        if (this.tagName !== "SELECT") throw new Error("element is not a <select>; click it and then click the option instead");
        if (this.disabled) throw new Error("element is disabled");
        const options = Array.from(this.options) as HTMLOptionElement[];
        const option = options.find((candidate) => candidate.value === wanted || candidate.label.trim() === wanted || (candidate.textContent ?? "").trim() === wanted);
        if (!option) throw new Error(`no option "${wanted}". Options: ${options.map((candidate) => candidate.label.trim()).join(", ")}`);
        this.value = option.value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
      },
      value,
    );
    await this.settle();
  }

  async setChecked(target: string, checked: boolean): Promise<void> {
    const isChecked = () =>
      this.callOn<boolean>(target, function (this: any) {
        const el = this.nodeType === 1 ? this : this.parentElement;
        return typeof el.checked === "boolean" ? el.checked : el.getAttribute("aria-checked") === "true";
      });
    if ((await isChecked()) === checked) return;
    await this.click(target);
    if ((await isChecked()) !== checked) throw new Error(`clicking ${target} did not ${checked ? "check" : "uncheck"} it`);
  }

  async hover(target: string): Promise<void> {
    const { x, y } = await this.centre(target);
    await this.mouse("mouseMoved", x, y, { button: "none" });
  }

  async goBack(): Promise<void> {
    const history = await this.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
    if (history.currentIndex === 0) throw new Error("there is no previous page in this tab's history");
    await this.navigation(async () => {
      await this.send("Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex - 1].id });
    }, 3000);
    await this.settle();
  }

  async reload(): Promise<void> {
    await this.navigation(async () => {
      await this.send("Page.reload");
    });
    await this.settle();
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 0, mobile: width < 768 });
    this.viewport = { width, height };
    await this.settle();
  }

  async wait(seconds: number): Promise<void> {
    await sleep(Math.min(Math.max(seconds, 0), 10) * 1000);
  }

  async snapshot(maxChars: number): Promise<string> {
    const title = await this.evaluate<string>("document.title").catch(() => "");
    const viewport = this.viewport ?? (await this.evaluate<{ width: number; height: number }>("({ width: innerWidth, height: innerHeight })").catch(() => undefined));
    let tree: string;
    try {
      const { nodes } = await this.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
      tree = formatAxTree(nodes);
    } catch (err) {
      tree = `(accessibility snapshot unavailable: ${err instanceof Error ? err.message : String(err)})`;
    }
    return [`Page: ${this.url}`, `Title: ${title}`, viewport ? `Viewport: ${viewport.width}x${viewport.height}` : "", "", truncate(tree, maxChars)].join("\n");
  }

  async screenshot(label: string): Promise<{ file: string; base64: string }> {
    this.screenshotCount += 1;
    const file = `screens/${this.opts.label}-${String(this.screenshotCount).padStart(3, "0")}-${slug(label, 30)}.jpg`;
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 60 });
    await this.opts.storage.write(file, Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));
    return { file, base64: data };
  }

  async pageInfo(): Promise<PageInfo | null> {
    return this.evaluate<PageInfo | null>(PAGE_INFO_SCRIPT);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
