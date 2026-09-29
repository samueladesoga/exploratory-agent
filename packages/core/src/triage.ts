import { z } from "zod";
import { defineTool } from "./agent.js";
import type { ClientConfig } from "./config.js";
import type { RunContext } from "./context.js";
import { TRIAGE_SYSTEM } from "./prompts.js";
import { CATEGORIES, SEVERITIES, type Finding, type Issue, type SessionResult, type Severity, type Signal } from "./types.js";
import { errMsg, text, truncate } from "./util.js";

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const normaliseMessage = (message: string) =>
  message
    .replace(/https?:\/\/[^\s)]+/g, (url) => url.replace(/\?.*$/, ""))
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hash>")
    .replace(/\d+/g, "#");

function autoSeverity(signal: Signal): Severity {
  if (signal.kind === "page-error") return "high";
  if (signal.kind === "http-error") return (signal.status ?? 0) >= 500 ? "high" : signal.status === 404 ? "medium" : "low";
  if (signal.kind === "request-failed") return "medium";
  return "medium";
}

const AUTO_TITLES: Record<string, string> = {
  "page-error": "Uncaught JavaScript exception",
  "console-error": "Console error",
  "http-error": "Failing HTTP request",
  "request-failed": "Network request failed",
};

export function autoFindings(signals: Signal[]): Finding[] {
  const groups = new Map<string, Signal[]>();
  for (const signal of signals) {
    if (signal.kind === "blocked-request") continue;
    const key = `${signal.kind}|${normaliseMessage(signal.message)}`;
    const group = groups.get(key) ?? [];
    group.push(signal);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const first = group[0];
      const pages = [...new Set(group.map((signal) => signal.pageUrl).filter(Boolean))];
      const sessionIds = [...new Set(group.map((signal) => signal.sessionId ?? "?"))];
      return {
        id: "",
        sessionId: sessionIds.join(", "),
        charterId: "",
        title: `${AUTO_TITLES[first.kind]}: ${truncate(first.message, 110)}`,
        severity: autoSeverity(first),
        category: first.kind === "http-error" || first.kind === "request-failed" ? "network-error" : "runtime-error",
        steps: [`Observed automatically during session(s) ${sessionIds.join(", ")} on: ${pages.slice(0, 5).join(", ")}`],
        expected: "No runtime errors or failing requests during normal use.",
        actual: first.message,
        confidence: "high",
        reproduced: group.length > 1,
        pageUrl: first.pageUrl,
        screenshots: [],
        source: "auto",
        occurrences: group.length,
        pages,
        timestamp: first.timestamp,
      } satisfies Finding;
    })
    .sort((findingA, findingB) => SEVERITY_RANK[findingA.severity] - SEVERITY_RANK[findingB.severity] || (findingB.occurrences ?? 0) - (findingA.occurrences ?? 0))
    .map((finding, index) => ({ ...finding, id: `AUTO-${String(index + 1).padStart(3, "0")}` }));
}

const TriageSubmissionShape = {
  executive_summary: z.array(z.string()).min(3).max(5).describe("3-5 short, plain sentences, one per array item"),
  groups: z.array(
    z.object({
      title: z.string(),
      severity: z.enum(SEVERITIES),
      category: z.enum(CATEGORIES),
      finding_ids: z.array(z.string()).min(1),
      needs_verification: z.boolean(),
      notes: z.array(z.string()).optional().describe("Short bullet points: why it needs verification, or other triage context. One point per item."),
    }),
  ),
};

export type TriageSubmission = z.infer<z.ZodObject<typeof TriageSubmissionShape>>;

export async function triage(
  cfg: ClientConfig,
  sessions: SessionResult[],
  autos: Finding[],
  ctx: Pick<RunContext, "runner" | "log">,
): Promise<{ issues: Issue[]; summary: string[]; costUsd: number }> {
  const findings = sessions.flatMap((session) => session.findings);
  let submitted: TriageSubmission | undefined;

  const submit = defineTool("submit_triage", "Submit grouped, triaged findings and the executive summary.", TriageSubmissionShape, async (submission) => {
    submitted = submission;
    return text("Triage received. You are done.");
  });

  let costUsd = 0;
  if (findings.length || autos.length) {
    const payload = {
      findings: findings.map(({ screenshots, timestamp, source, ...finding }) => finding),
      runtime_errors_detected_automatically: autos.map((auto) => ({ title: auto.title, severity: auto.severity, occurrences: auto.occurrences })),
      coverage: sessions.map((session) => ({ charter: session.charter.title, stop: session.stopReason, summary: session.summary, not_covered: session.areasNotCovered })),
    };
    try {
      const run = await ctx.runner.run({
        name: "triage",
        systemPrompt: TRIAGE_SYSTEM,
        prompt: `Application: ${cfg.name} (${cfg.baseUrl})\n\n${cfg.description}\n\nSession output:\n${JSON.stringify(payload, null, 2)}`,
        tools: [submit],
        model: cfg.run.plannerModel,
        maxTurns: 4,
        log: ctx.log,
      });
      costUsd = run.costUsd;
    } catch (err) {
      ctx.log(`triage failed, falling back to untriaged findings: ${errMsg(err)}`);
    }
  }

  const { issues, summary } = mergeTriage(findings, autos, submitted);
  return { issues, summary, costUsd };
}

// Applies the triage agent's grouping to the findings. Nothing is dropped: findings the agent
// left out (or every finding, when triage failed) become issues of their own.
export function mergeTriage(findings: Finding[], autos: Finding[], submitted: TriageSubmission | undefined): { issues: Issue[]; summary: string[] } {
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));
  const usedIds = new Set<string>();
  const issues: Issue[] = [];
  const confidenceRank = (finding: Finding) => (finding.reproduced ? 0 : 2) + (finding.confidence === "high" ? 0 : finding.confidence === "medium" ? 1 : 2);
  for (const group of submitted?.groups ?? []) {
    const members = group.finding_ids.filter((id) => findingById.has(id) && !usedIds.has(id)).map((id) => findingById.get(id)!);
    if (!members.length) continue;
    members.forEach((member) => usedIds.add(member.id));
    const [primary, ...related] = [...members].sort((findingA, findingB) => confidenceRank(findingA) - confidenceRank(findingB));
    issues.push({ id: "", title: group.title, severity: group.severity, category: group.category, needsVerification: group.needs_verification, triageNotes: group.notes, primary, related });
  }
  for (const finding of findings) {
    if (usedIds.has(finding.id)) continue;
    issues.push({
      id: "",
      title: finding.title,
      severity: finding.severity,
      category: finding.category,
      needsVerification: !finding.reproduced || finding.confidence === "low",
      triageNotes: [submitted ? "Not grouped during triage." : "Triage unavailable; reported as recorded."],
      primary: finding,
      related: [],
    });
  }
  issues.sort((issueA, issueB) => Number(issueA.needsVerification) - Number(issueB.needsVerification) || SEVERITY_RANK[issueA.severity] - SEVERITY_RANK[issueB.severity]);
  issues.forEach((issue, index) => (issue.id = `BUG-${String(index + 1).padStart(3, "0")}`));

  const summary =
    submitted?.executive_summary ??
    [`${issues.length} issue(s) recorded by the testing agent.`, `${autos.length} runtime error pattern(s) detected automatically.`];
  return { issues, summary };
}
