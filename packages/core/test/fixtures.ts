import { parseClientConfig, type BrowserDriver, type ClientConfig, type Finding, type PageInfo, type Signal } from "../src/index.js";

export function makeConfig(overrides: Record<string, unknown> = {}): ClientConfig {
  return parseClientConfig({ name: "Acme", baseUrl: "https://app.example.com/", description: "Test app", ...overrides }, "test");
}

export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "S01-F01",
    sessionId: "S01",
    charterId: "C01",
    title: "Total goes negative",
    severity: "high",
    category: "functional",
    steps: ["Open /cart", "Set quantity to -3"],
    expected: "Quantity is rejected.",
    actual: "Total shows -£30.",
    confidence: "high",
    reproduced: true,
    pageUrl: "https://app.example.com/cart",
    screenshots: [],
    source: "agent",
    timestamp: "2026-09-29T10:00:00.000Z",
    ...overrides,
  };
}

export function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    kind: "page-error",
    message: "TypeError: x is undefined",
    pageUrl: "https://app.example.com/",
    timestamp: "2026-09-29T10:00:00.000Z",
    sessionId: "S01",
    ...overrides,
  };
}

// Records calls instead of driving a browser.
export class FakeDriver implements BrowserDriver {
  readonly signals: Signal[] = [];
  readonly targetHint = "fake target";
  readonly selectorGuide = "fake guide";
  readonly calls: string[] = [];
  failNext = false;

  private record(call: string): Promise<void> {
    this.calls.push(call);
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("element not found"));
    }
    return Promise.resolve();
  }

  async start() {}
  async close() {}
  currentUrl() {
    return "https://app.example.com/page";
  }
  isAppUrl(url: string) {
    return url.startsWith("https://app.example.com");
  }
  drainNew() {
    return "";
  }
  navigate(url: string) {
    return this.record(`navigate ${url}`);
  }
  click(target: string) {
    return this.record(`click ${target}`);
  }
  fill(target: string, value: string) {
    return this.record(`fill ${target} ${value}`);
  }
  press(key: string) {
    return this.record(`press ${key}`);
  }
  selectOption(target: string, value: string) {
    return this.record(`select ${target} ${value}`);
  }
  setChecked(target: string, checked: boolean) {
    return this.record(`check ${target} ${checked}`);
  }
  hover(target: string) {
    return this.record(`hover ${target}`);
  }
  goBack() {
    return this.record("back");
  }
  reload() {
    return this.record("reload");
  }
  setViewport(width: number, height: number) {
    return this.record(`viewport ${width}x${height}`);
  }
  wait(seconds: number) {
    return this.record(`wait ${seconds}`);
  }
  async snapshot() {
    return "SNAPSHOT";
  }
  async screenshot(label: string) {
    this.calls.push(`screenshot ${label}`);
    return { file: `screens/${label}.jpg`, base64: "AAAA" };
  }
  async pageInfo(): Promise<PageInfo | null> {
    return null;
  }
}
