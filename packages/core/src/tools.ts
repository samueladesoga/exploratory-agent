import { z } from "zod";
import { defineTool, type AnyToolDef } from "./agent.js";
import type { RunObserver } from "./context.js";
import type { BrowserDriver } from "./driver.js";
import { CATEGORIES, SEVERITIES, type ActionLogEntry, type Finding } from "./types.js";
import { errMsg, firstLines, text, truncate } from "./util.js";

export interface SessionState {
  sessionId: string;
  charterId: string;
  steps: number;
  maxSteps: number;
  snapshotChars: number;
  findings: Finding[];
  log: ActionLogEntry[];
  ended: boolean;
  summary?: string;
  covered: string[];
  notCovered: string[];
}

export function buildSessionTools(browser: BrowserDriver, session: SessionState, observer?: RunObserver): AnyToolDef[] {
  const budget = (): string => {
    const remaining = session.maxSteps - session.steps;
    return remaining <= 5
      ? `[steps used ${session.steps}/${session.maxSteps}. WRAP UP NOW: record outstanding findings, then call end_session.]`
      : `[steps used ${session.steps}/${session.maxSteps}]`;
  };
  const closed = () => text("This session has ended. Do not call any more tools.");

  const exhausted = () =>
    text(`Step budget exhausted (${session.maxSteps}/${session.maxSteps}). No more browser actions are possible. Record any outstanding findings, then call end_session.`);

  async function act(name: string, args: unknown, action: () => Promise<unknown>, withSnapshot = true) {
    if (session.ended) return closed();
    if (session.steps >= session.maxSteps) return exhausted();
    session.steps += 1;
    let ok = true;
    let error = "";
    try {
      await action();
    } catch (err) {
      ok = false;
      error = firstLines(errMsg(err));
    }
    const entry = {
      step: session.steps,
      tool: name,
      args: truncate(JSON.stringify(args), 300),
      pageUrl: browser.currentUrl(),
      ok,
      note: ok ? undefined : error,
      timestamp: new Date().toISOString(),
    };
    session.log.push(entry);
    observer?.action?.(session.sessionId, entry);
    const parts = [ok ? `OK: ${name}` : `FAILED: ${name}: ${error}`];
    const updates = browser.drainNew();
    if (updates) parts.push(updates);
    if (withSnapshot) parts.push(await browser.snapshot(session.snapshotChars));
    parts.push(budget());
    return text(parts.join("\n\n"));
  }

  const target = z.string().describe(browser.targetHint);

  return [
    defineTool(
      "navigate",
      "Open a URL: absolute, or a path relative to the current page. Only the application's own origins are allowed. Returns the new page snapshot.",
      { url: z.string() },
      (args) => act("navigate", args, () => browser.navigate(args.url)),
    ),
    defineTool("click", "Click an element. Returns the resulting page snapshot.", { target }, (args) =>
      act("click", args, () => browser.click(args.target)),
    ),
    defineTool(
      "fill",
      "Clear an input or textarea and enter a value. Returns no snapshot; submit, press a key, or call snapshot to see validation messages.",
      { target, value: z.string() },
      (args) => act("fill", args, () => browser.fill(args.target, args.value), false),
    ),
    defineTool(
      "press_key",
      "Press a key (e.g. Enter, Tab, Escape, ArrowDown), optionally focused on an element.",
      { key: z.string(), target: target.optional() },
      (args) => act("press_key", args, () => browser.press(args.key, args.target)),
    ),
    defineTool(
      "select_option",
      "Choose an option in a native <select> by its value or visible label.",
      { target, value: z.string() },
      (args) => act("select_option", args, () => browser.selectOption(args.target, args.value)),
    ),
    defineTool("set_checked", "Check or uncheck a checkbox or radio button.", { target, checked: z.boolean() }, (args) =>
      act("set_checked", args, () => browser.setChecked(args.target, args.checked)),
    ),
    defineTool("hover", "Hover over an element, e.g. to open a menu or tooltip.", { target }, (args) =>
      act("hover", args, () => browser.hover(args.target)),
    ),
    defineTool("go_back", "Press the browser Back button.", {}, (args) => act("go_back", args, () => browser.goBack())),
    defineTool("reload", "Reload the current page.", {}, (args) => act("reload", args, () => browser.reload())),
    defineTool(
      "set_viewport",
      "Resize the viewport to test responsive layout, e.g. 390x844 (phone), 768x1024 (tablet), 1366x900 (desktop).",
      { width: z.number().int().min(320).max(2560), height: z.number().int().min(480).max(1600) },
      (args) => act("set_viewport", args, () => browser.setViewport(args.width, args.height)),
    ),
    defineTool(
      "wait",
      "Wait up to 10 seconds for something asynchronous to finish, then return the snapshot.",
      { seconds: z.number().min(0.5).max(10) },
      (args) => act("wait", args, () => browser.wait(args.seconds)),
    ),
    defineTool("snapshot", "Get the current page's accessibility tree, URL and any new runtime signals.", {}, (args) =>
      act("snapshot", args, async () => {}),
    ),
    defineTool(
      "screenshot",
      "Capture the visible viewport as an image to judge visual layout. The image is saved as evidence.",
      { label: z.string().describe("Short description of what the screenshot shows") },
      async (args) => {
        if (session.ended) return closed();
        if (session.steps >= session.maxSteps) return exhausted();
        session.steps += 1;
        try {
          const shot = await browser.screenshot(args.label);
          return {
            content: [
              { type: "image" as const, data: shot.base64, mimeType: "image/jpeg" },
              { type: "text" as const, text: `Saved ${shot.file}\n${budget()}` },
            ],
          };
        } catch (err) {
          return text(`FAILED: screenshot: ${firstLines(errMsg(err))}\n${budget()}`);
        }
      },
    ),
    defineTool(
      "record_finding",
      "Record a confirmed defect. A screenshot of the current page is attached unless attach_screenshot is false. Does not use a step.",
      {
        title: z.string().describe("Specific summary, e.g. 'Quantity field accepts -3 and cart total goes negative'"),
        severity: z.enum(SEVERITIES),
        category: z.enum(CATEGORIES),
        steps: z.array(z.string()).min(1).describe("Concrete, replayable steps starting from a URL"),
        expected: z.string().describe("One short, plain sentence (under 25 words). No semicolons — put a second point in details instead."),
        actual: z.string().describe("One short, plain sentence (under 25 words). No semicolons — put a second point in details instead."),
        details: z
          .array(z.string())
          .optional()
          .describe("Optional short bullet points of extra context (caveats, related evidence, why it matters). Do not repeat expected/actual."),
        confidence: z.enum(["high", "medium", "low"]),
        reproduced: z.boolean().describe("True only if you reproduced it a second time"),
        attach_screenshot: z.boolean().optional(),
      },
      async (args) => {
        if (session.ended) return closed();
        const screenshots: string[] = [];
        if (args.attach_screenshot !== false) {
          try {
            screenshots.push((await browser.screenshot(`finding-${args.title}`)).file);
          } catch {}
        }
        const id = `${session.sessionId}-F${String(session.findings.length + 1).padStart(2, "0")}`;
        session.findings.push({
          id,
          sessionId: session.sessionId,
          charterId: session.charterId,
          title: args.title,
          severity: args.severity,
          category: args.category,
          steps: args.steps,
          expected: args.expected,
          actual: args.actual,
          details: args.details,
          confidence: args.confidence,
          reproduced: args.reproduced,
          pageUrl: browser.currentUrl(),
          screenshots,
          source: "agent",
          timestamp: new Date().toISOString(),
        });
        observer?.finding?.(session.findings[session.findings.length - 1]);
        return text(`Recorded ${id}. Continue exploring.\n${budget()}`);
      },
    ),
    defineTool(
      "end_session",
      "Finish the session with an honest summary of coverage. Call this when the charter is covered or the budget is nearly spent.",
      {
        summary: z.string().describe("2-4 short, plain sentences: what you explored and your impression of quality. One idea per sentence, no semicolons."),
        areas_covered: z.array(z.string()),
        areas_not_covered: z.array(z.string()).describe("Parts of the charter you did not get to, and why"),
      },
      async (args) => {
        session.ended = true;
        session.summary = args.summary;
        session.covered = args.areas_covered;
        session.notCovered = args.areas_not_covered;
        return text("Session closed. Do not call any more tools; reply with a one-line sign-off.");
      },
    ),
  ];
}
