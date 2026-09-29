import { appOrigins, type ClientConfig } from "./config.js";
import type { Signal } from "./types.js";
import { stripQuery } from "./util.js";

// Everything the exploring agent and recon need from a browser. The CLI implements it with
// Playwright; the extension implements it over the Chrome DevTools Protocol.
export interface BrowserDriver {
  readonly signals: Signal[];
  // How targets are written for this driver: a short hint for the tool schema, and the
  // "## Selectors" section of the explorer prompt.
  readonly targetHint: string;
  readonly selectorGuide: string;

  start(): Promise<void>;
  close(): Promise<void>;
  currentUrl(): string;
  isAppUrl(url: string): boolean;
  // Notes and runtime signals gathered since the last call, formatted for the agent.
  drainNew(): string;

  navigate(url: string): Promise<void>;
  click(target: string): Promise<void>;
  fill(target: string, value: string): Promise<void>;
  press(key: string, target?: string): Promise<void>;
  selectOption(target: string, value: string): Promise<void>;
  setChecked(target: string, checked: boolean): Promise<void>;
  hover(target: string): Promise<void>;
  goBack(): Promise<void>;
  reload(): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  wait(seconds: number): Promise<void>;
  snapshot(maxChars: number): Promise<string>;
  screenshot(label: string): Promise<{ file: string; base64: string }>;
  pageInfo(): Promise<PageInfo | null>;
}

export interface PageInfo {
  title: string;
  headings: string[];
  links: string[];
  nav: string[];
  forms: string[][];
  looseInputs: string[];
  buttons: string[];
}

// Evaluated in the page by any driver to summarise its structure for recon.
export const PAGE_INFO_SCRIPT = `(() => {
  const textOf = (element) => ((element && element.textContent) || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const labelFor = (element) => {
    const label = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]') : element.closest("label");
    return textOf(label) || element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("name") || element.getAttribute("type") || element.tagName.toLowerCase();
  };
  const fieldSelector = 'input:not([type=hidden]),select,textarea';
  return {
    title: document.title,
    headings: Array.from(document.querySelectorAll("h1,h2,h3")).map(textOf).filter(Boolean).slice(0, 12),
    links: Array.from(document.querySelectorAll("a[href]")).map((anchor) => anchor.href),
    nav: Array.from(document.querySelectorAll("nav a, header a, [role=navigation] a")).map(textOf).filter(Boolean).slice(0, 25),
    forms: Array.from(document.querySelectorAll("form")).slice(0, 5).map((form) => Array.from(form.querySelectorAll(fieldSelector)).map(labelFor).slice(0, 15)),
    looseInputs: Array.from(document.querySelectorAll(fieldSelector)).filter((element) => !element.closest("form")).map(labelFor).slice(0, 15),
    buttons: Array.from(document.querySelectorAll("button,[role=button],input[type=submit]")).map((button) => textOf(button) || button.value || button.getAttribute("aria-label") || "").filter(Boolean).slice(0, 20),
  };
})()`;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PASSTHROUGH_PROTOCOLS = new Set(["about:", "data:", "blob:", "javascript:"]);

// The safety rules from the client config, independent of how a driver intercepts requests.
export class SafetyPolicy {
  readonly allowedOrigins: Set<string>;
  private readonly blockRules: { method?: string; urlPattern: RegExp }[];

  constructor(private readonly cfg: ClientConfig) {
    this.allowedOrigins = appOrigins(cfg);
    this.blockRules = cfg.safety.blockedRequests.map((rule) => ({
      method: rule.method?.toUpperCase(),
      urlPattern: new RegExp(rule.urlPattern, "i"),
    }));
  }

  isAllowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      return PASSTHROUGH_PROTOCOLS.has(parsed.protocol) || this.allowedOrigins.has(parsed.origin);
    } catch {
      return false;
    }
  }

  isAppUrl(url: string): boolean {
    try {
      return this.allowedOrigins.has(new URL(url).origin);
    } catch {
      return false;
    }
  }

  // Why a request must be blocked, or undefined to let it through.
  blockReason(url: string, method: string, isTopLevelNavigation: boolean): string | undefined {
    const upperMethod = method.toUpperCase();
    if (isTopLevelNavigation && !this.isAllowed(url)) return "navigation outside the allowed origins";
    if (this.cfg.safety.blockMutations && MUTATING_METHODS.has(upperMethod) && this.isAppUrl(url)) {
      return "mutating request blocked by safety.blockMutations";
    }
    const rule = this.blockRules.find((blockRule) => (!blockRule.method || blockRule.method === upperMethod) && blockRule.urlPattern.test(url));
    return rule ? `matches safety.blockedRequests /${rule.urlPattern.source}/` : undefined;
  }

  blockedMessage(url: string, method: string, reason: string): string {
    return `${method.toUpperCase()} ${stripQuery(url)} blocked: ${reason}`;
  }
}

// Collects runtime signals and notes for the agent, dropping ignored ones and deduplicating what
// is shown between steps.
export class SignalBuffer {
  readonly signals: Signal[] = [];
  private pendingSignals: Signal[] = [];
  private pendingNotes: string[] = [];
  private readonly ignoredSignalPatterns: RegExp[];

  constructor(
    cfg: ClientConfig,
    private readonly currentUrl: () => string,
  ) {
    this.ignoredSignalPatterns = cfg.safety.ignoreSignals.map((pattern) => new RegExp(pattern, "i"));
  }

  push(signal: Omit<Signal, "timestamp" | "pageUrl"> & { pageUrl?: string }): void {
    if (this.ignoredSignalPatterns.some((pattern) => pattern.test(signal.message) || (signal.url !== undefined && pattern.test(signal.url)))) {
      return;
    }
    const record: Signal = { ...signal, pageUrl: signal.pageUrl ?? this.currentUrl(), timestamp: new Date().toISOString() };
    this.signals.push(record);
    if (!this.pendingSignals.some((pending) => pending.kind === record.kind && pending.message === record.message)) {
      this.pendingSignals.push(record);
    }
  }

  note(message: string): void {
    this.pendingNotes.push(message);
  }

  drain(): string {
    const lines: string[] = this.pendingNotes.map((note) => `Note: ${note}`);
    const pending = this.pendingSignals;
    if (pending.length) {
      lines.push("Runtime signals since last step:");
      for (const signal of pending.slice(0, 10)) lines.push(`- [${signal.kind}] ${signal.message}`);
      if (pending.length > 10) lines.push(`- …and ${pending.length - 10} more`);
    }
    this.pendingNotes = [];
    this.pendingSignals = [];
    return lines.join("\n");
  }
}
