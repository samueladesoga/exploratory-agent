import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runAgent } from "./agent.js";
import { BrowserHarness } from "./browser.js";
import type { ClientConfig } from "./config.js";
import { explorerPrompt, explorerSystem } from "./prompts.js";
import { buildSessionTools, SESSION_TOOL_NAMES, type SessionState } from "./tools.js";
import type { Charter, SessionResult } from "./types.js";
import { errMsg, firstLines, type Logger } from "./util.js";

export interface SessionContext {
  runDir: string;
  storageState?: string;
  headless: boolean;
  verbose: boolean;
  log: Logger;
}

export async function runSession(cfg: ClientConfig, charter: Charter, ctx: SessionContext): Promise<SessionResult> {
  const sessionId = charter.id.replace(/^C/, "S");
  const startedAt = new Date().toISOString();
  const browser = new BrowserHarness(cfg, {
    screensDir: path.join(ctx.runDir, "screens"),
    label: sessionId,
    headless: ctx.headless,
  });
  const state: SessionState = {
    sessionId,
    charterId: charter.id,
    steps: 0,
    maxSteps: charter.maxSteps,
    snapshotChars: cfg.run.snapshotMaxChars,
    findings: [],
    log: [],
    ended: false,
    covered: [],
    notCovered: [],
  };

  let stopReason = "not_started";
  let costUsd = 0;
  let error: string | undefined;
  ctx.log(`${sessionId} ▶ ${charter.title}`);

  try {
    await browser.start(ctx.storageState);
    let startNote = "";
    try {
      await browser.navigate(charter.startUrl);
    } catch (err) {
      startNote = `Note: opening the start URL failed: ${firstLines(errMsg(err), 1)}\n\n`;
    }
    const pending = browser.drainNew();
    const startSnapshot = `${startNote}${pending ? `${pending}\n\n` : ""}${await browser.snapshot(cfg.run.snapshotMaxChars)}`;

    const run = await runAgent({
      name: sessionId,
      systemPrompt: explorerSystem(cfg),
      prompt: explorerPrompt(charter, startSnapshot),
      server: createSdkMcpServer({ name: "qa", version: "1.0.0", tools: buildSessionTools(browser, state) }),
      toolNames: SESSION_TOOL_NAMES,
      model: cfg.run.explorerModel,
      maxTurns: charter.maxSteps + 20,
      maxBudgetUsd: cfg.run.maxBudgetUsdPerSession,
      timeoutMinutes: cfg.run.maxMinutesPerSession,
      cwd: ctx.runDir,
      log: ctx.log,
      verbose: ctx.verbose,
    });
    costUsd = run.costUsd;
    stopReason = state.ended ? "completed" : run.stopReason;
  } catch (err) {
    error = errMsg(err);
    stopReason = "error";
    ctx.log(`${sessionId} ✖ ${firstLines(error, 2)}`);
  } finally {
    await browser.close();
  }

  const result: SessionResult = {
    sessionId,
    charter,
    startedAt,
    endedAt: new Date().toISOString(),
    stepsUsed: state.steps,
    stopReason,
    summary: state.summary,
    areasCovered: state.covered,
    areasNotCovered: state.notCovered,
    findings: state.findings,
    signals: browser.signals.map((signal) => ({ ...signal, sessionId })),
    actionLog: state.log,
    costUsd,
    error,
  };
  await writeFile(path.join(ctx.runDir, "sessions", `${sessionId}.json`), JSON.stringify(result, null, 2));
  ctx.log(
    `${sessionId} ■ ${stopReason}: ${state.steps} steps, ${state.findings.length} findings, ` +
      `${result.signals.filter((signal) => signal.kind !== "blocked-request").length} runtime signals, $${costUsd.toFixed(2)}`,
  );
  return result;
}
