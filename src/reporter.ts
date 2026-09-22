import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runAgent } from "./agent.js";
import type { ClientConfig } from "./config.js";
import { TRIAGE_SYSTEM } from "./prompts.js";
import {
  CATEGORIES,
  SEVERITIES,
  type Finding,
  type Issue,
  type SessionResult,
  type Severity,
  type Signal,
  type TestPlan,
} from "./types.js";
import { errMsg, escapeHtml, text, truncate, type Logger } from "./util.js";

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

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

export async function triage(
  cfg: ClientConfig,
  sessions: SessionResult[],
  autos: Finding[],
  opts: { cwd: string; log: Logger },
): Promise<{ issues: Issue[]; summary: string[]; costUsd: number }> {
  const findings = sessions.flatMap((session) => session.findings);
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));
  let submitted:
    | { summary: string[]; groups: { title: string; severity: Severity; category: Issue["category"]; ids: string[]; needsVerification: boolean; notes?: string[] }[] }
    | undefined;

  const submit = tool(
    "submit_triage",
    "Submit grouped, triaged findings and the executive summary.",
    {
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
    },
    async (submission) => {
      submitted = {
        summary: submission.executive_summary,
        groups: submission.groups.map((group) => ({
          title: group.title,
          severity: group.severity,
          category: group.category,
          ids: group.finding_ids.filter((id) => findingById.has(id)),
          needsVerification: group.needs_verification,
          notes: group.notes,
        })),
      };
      return text("Triage received. You are done.");
    },
  );

  let costUsd = 0;
  if (findings.length || autos.length) {
    const payload = {
      findings: findings.map(({ screenshots, timestamp, source, ...finding }) => finding),
      runtime_errors_detected_automatically: autos.map((auto) => ({ title: auto.title, severity: auto.severity, occurrences: auto.occurrences })),
      coverage: sessions.map((session) => ({ charter: session.charter.title, stop: session.stopReason, summary: session.summary, not_covered: session.areasNotCovered })),
    };
    try {
      const run = await runAgent({
        name: "triage",
        systemPrompt: TRIAGE_SYSTEM,
        prompt: `Application: ${cfg.name} (${cfg.baseUrl})\n\n${cfg.description}\n\nSession output:\n${JSON.stringify(payload, null, 2)}`,
        server: createSdkMcpServer({ name: "qa", version: "1.0.0", tools: [submit] }),
        toolNames: ["submit_triage"],
        model: cfg.run.plannerModel,
        maxTurns: 4,
        cwd: opts.cwd,
        log: opts.log,
      });
      costUsd = run.costUsd;
    } catch (err) {
      opts.log(`triage failed, falling back to untriaged findings: ${errMsg(err)}`);
    }
  }

  const usedIds = new Set<string>();
  const issues: Issue[] = [];
  const confidenceRank = (finding: Finding) => (finding.reproduced ? 0 : 2) + (finding.confidence === "high" ? 0 : finding.confidence === "medium" ? 1 : 2);
  for (const group of submitted?.groups ?? []) {
    const members = group.ids.filter((id) => !usedIds.has(id)).map((id) => findingById.get(id)!);
    if (!members.length) continue;
    members.forEach((member) => usedIds.add(member.id));
    const [primary, ...related] = [...members].sort((findingA, findingB) => confidenceRank(findingA) - confidenceRank(findingB));
    issues.push({ id: "", title: group.title, severity: group.severity, category: group.category, needsVerification: group.needsVerification, triageNotes: group.notes, primary, related });
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
    submitted?.summary ??
    [`${issues.length} issue(s) recorded by the testing agent.`, `${autos.length} runtime error pattern(s) detected automatically.`];
  return { issues, summary, costUsd };
}

export interface RunReport {
  cfg: ClientConfig;
  plan: TestPlan;
  sessions: SessionResult[];
  issues: Issue[];
  autos: Finding[];
  summary: string[];
  totalCostUsd: number;
  startedAt: string;
  endedAt: string;
}

const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;

export async function writeReports(runDir: string, report: RunReport): Promise<void> {
  await writeFile(
    path.join(runDir, "report.json"),
    JSON.stringify({ ...report, cfg: { name: report.cfg.name, baseUrl: report.cfg.baseUrl } }, null, 2),
  );
  await writeFile(path.join(runDir, "report.md"), toMarkdown(report));
  await writeFile(path.join(runDir, "report.html"), toHtml(report));

  const header = ["ID", "Title", "Severity", "Category", "Needs verification", "URL", "Steps", "Expected", "Actual", "Charter", "Screenshots"];
  const rows = report.issues.map((issue) =>
    [
      issue.id,
      issue.title,
      issue.severity,
      issue.category,
      issue.needsVerification ? "yes" : "no",
      issue.primary.pageUrl,
      issue.primary.steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
      issue.primary.expected,
      issue.primary.actual,
      issue.primary.charterId,
      [issue.primary, ...issue.related].flatMap((finding) => finding.screenshots).join(" "),
    ].map((value) => csvCell(String(value))).join(","),
  );
  await writeFile(path.join(runDir, "issues.csv"), [header.map(csvCell).join(","), ...rows].join("\n"));
}

interface SeverityCount {
  total: number;
  toVerify: number;
}

// Counts every issue by severity, not just confirmed ones — triage can flag a reproduced,
// high-confidence bug as needing verification, and it should still show up in the headline
// counts rather than silently disappear.
function severityCounts(issues: Issue[]): Record<Severity, SeverityCount> {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, { total: 0, toVerify: 0 }])) as Record<Severity, SeverityCount>;
  for (const issue of issues) {
    counts[issue.severity].total += 1;
    if (issue.needsVerification) counts[issue.severity].toVerify += 1;
  }
  return counts;
}

function toMarkdown(report: RunReport): string {
  const counts = severityCounts(report.issues);
  const confirmed = report.issues.filter((issue) => !issue.needsVerification);
  const toVerify = report.issues.filter((issue) => issue.needsVerification);
  const lines: string[] = [
    `# Exploratory testing report: ${report.cfg.name}`,
    "",
    `**Application:** ${report.cfg.baseUrl}  `,
    `**Run:** ${report.startedAt} → ${report.endedAt}  `,
    `**Sessions:** ${report.sessions.length} · **Issues:** ${confirmed.length} confirmed, ${toVerify.length} to verify · **Runtime error patterns:** ${report.autos.length}  `,
    `**Estimated model cost:** $${report.totalCostUsd.toFixed(2)}`,
    "",
    "## Summary",
    "",
    ...report.summary.map((line) => `- ${line}`),
    "",
    "| | Critical | High | Medium | Low | Info |",
    "|---|---|---|---|---|---|",
    `| Total | ${counts.critical.total} | ${counts.high.total} | ${counts.medium.total} | ${counts.low.total} | ${counts.info.total} |`,
    `| Awaiting verification | ${counts.critical.toVerify} | ${counts.high.toVerify} | ${counts.medium.toVerify} | ${counts.low.toVerify} | ${counts.info.toVerify} |`,
    "",
  ];
  const issueBlock = (issue: Issue) => {
    const finding = issue.primary;
    const screenshots = [finding, ...issue.related].flatMap((related) => related.screenshots);
    lines.push(
      `### ${issue.id} · ${issue.title}`,
      "",
      `**Severity:** ${issue.severity} · **Category:** ${issue.category} · **Confidence:** ${finding.confidence}${finding.reproduced ? ", reproduced" : ", not reproduced"} · **Found in:** ${[finding, ...issue.related].map((related) => related.charterId).filter((charterId, index, all) => all.indexOf(charterId) === index).join(", ")}  `,
      `**Page:** ${finding.pageUrl}`,
      "",
      "**Steps to reproduce**",
      "",
      ...finding.steps.map((step, index) => `${index + 1}. ${step}`),
      "",
      `**Expected:** ${finding.expected}`,
      "",
      `**Actual:** ${finding.actual}`,
      "",
    );
    if (finding.details?.length) lines.push(...finding.details.map((detail) => `- ${detail}`), "");
    if (issue.triageNotes?.length) lines.push("**Triage notes**", "", ...issue.triageNotes.map((note) => `- ${note}`), "");
    if (issue.related.length) lines.push(`**Also observed as:** ${issue.related.map((related) => `${related.id} (${related.title})`).join(", ")}`, "");
    if (screenshots.length) lines.push(screenshots.map((screenshot) => `![${issue.id}](${screenshot})`).join(" "), "");
  };
  lines.push("## Issues", "");
  confirmed.length ? confirmed.forEach(issueBlock) : lines.push("No confirmed issues.", "");
  if (toVerify.length) {
    lines.push("## Needs verification", "", "These were not reproduced, are low confidence, or may be intended behaviour.", "");
    toVerify.forEach(issueBlock);
  }
  lines.push("## Runtime errors detected automatically", "");
  if (report.autos.length) {
    lines.push("| ID | Severity | Occurrences | Error | Pages |", "|---|---|---|---|---|");
    for (const auto of report.autos) {
      lines.push(`| ${auto.id} | ${auto.severity} | ${auto.occurrences} | ${auto.actual.replace(/\|/g, "\\|")} | ${(auto.pages ?? []).slice(0, 3).join("<br>")} |`);
    }
  } else lines.push("None detected.");
  lines.push("", "## Session coverage", "");
  for (const session of report.sessions) {
    lines.push(
      `### ${session.sessionId} · ${session.charter.title}`,
      "",
      `*${session.charter.mission}*`,
      "",
      `Result: ${session.stopReason}, ${session.stepsUsed}/${session.charter.maxSteps} steps, ${session.findings.length} findings, $${session.costUsd.toFixed(2)}.${session.error ? ` Error: ${session.error}` : ""}`,
      "",
    );
    if (session.summary) lines.push(session.summary, "");
    if (session.areasCovered.length) lines.push("**Covered:**", "", ...session.areasCovered.map((area) => `- ${area}`), "");
    if (session.areasNotCovered.length) lines.push("**Not covered:**", "", ...session.areasNotCovered.map((area) => `- ${area}`), "");
  }
  return lines.join("\n");
}

function toHtml(report: RunReport): string {
  const escape = escapeHtml;
  const counts = severityCounts(report.issues);

  const ul = (items: string[]) => (items.length ? `<ul>${items.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>` : "");

  // Splits after sentence-ending punctuation followed by whitespace. Uses split() rather
  // than a matching regex so no text is ever dropped (a matching regex can fail to find a
  // valid boundary near abbreviations or URLs and silently skip the text in between).
  const splitSentences = (str: string): string[] => {
    const trimmed = str.trim();
    if (!trimmed) return [];
    return trimmed
      .split(/(?<=[.!?])\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
  };

  // Groups sentences two at a time so long free-text fields still get paragraph breaks.
  const prose = (str: string): string => {
    const sentences = splitSentences(str);
    const paragraphs: string[] = [];
    for (let i = 0; i < sentences.length; i += 2) paragraphs.push(sentences.slice(i, i + 2).join(" "));
    return paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join("");
  };

  const issueCard = (issue: Issue) => {
    const finding = issue.primary;
    const screenshots = [finding, ...issue.related].flatMap((related) => related.screenshots);
    return `<article class="issue">
  <header><span class="sev sev-${issue.severity}">${issue.severity}</span><h3>${escape(issue.id)} · ${escape(issue.title)}</h3></header>
  <p class="meta">${escape(issue.category)} · confidence ${escape(finding.confidence)} · ${finding.reproduced ? "reproduced" : "not reproduced"} · ${escape(finding.charterId)} · <a href="${escape(finding.pageUrl)}">${escape(finding.pageUrl)}</a></p>
  <h4>Steps to reproduce</h4><ol>${finding.steps.map((step) => `<li>${escape(step)}</li>`).join("")}</ol>
  <div class="ea"><div><h4>Expected</h4><p>${escape(finding.expected)}</p></div><div><h4>Actual</h4><p>${escape(finding.actual)}</p></div></div>
  ${finding.details?.length ? `<div class="details"><h4>Details</h4>${ul(finding.details)}</div>` : ""}
  ${issue.triageNotes?.length ? `<div class="note"><h4>Triage notes</h4>${ul(issue.triageNotes)}</div>` : ""}
  ${issue.related.length ? `<p class="meta">Also observed as: ${issue.related.map((related) => escape(`${related.id} (${related.title})`)).join(", ")}</p>` : ""}
  ${screenshots.length ? `<div class="shots">${screenshots.map((screenshot) => `<a href="${escape(screenshot)}" target="_blank"><img src="${escape(screenshot)}" alt="${escape(issue.id)} evidence" loading="lazy"></a>`).join("")}</div>` : ""}
</article>`;
  };
  const confirmed = report.issues.filter((issue) => !issue.needsVerification);
  const toVerify = report.issues.filter((issue) => issue.needsVerification);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Exploratory testing report · ${escape(report.cfg.name)}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#e3e3e0;--crit:#b3261e;--high:#d9480f;--med:#b7791f;--low:#2f6f9f;--info:#6b6b70}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:980px;margin:0 auto;padding:40px 20px 80px}h1{font-size:28px;margin:0 0 4px}h2{margin:48px 0 16px;font-size:20px;border-bottom:1px solid var(--line);padding-bottom:8px}
h3{font-size:16px;margin:0}h4{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:18px 0 6px}
p{max-width:70ch}ul{margin:6px 0;padding-left:20px}li{margin:4px 0}
.sub{color:var(--muted);margin:0 0 24px}.summary{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px}
.summary ul{margin:0;padding-left:20px}.summary li{margin:0 0 8px}.summary li:last-child{margin-bottom:0}
.counts{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:16px}.count{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;text-align:center}
.count b{display:block;font-size:24px}.count small{display:block;color:var(--muted);font-size:11px;margin-top:2px}.issue{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:14px}
.issue header{display:flex;gap:10px;align-items:center}.meta{color:var(--muted);font-size:13px;margin:6px 0;word-break:break-all}
.sev{font-size:11px;font-weight:600;text-transform:uppercase;color:#fff;padding:3px 8px;border-radius:99px;flex-shrink:0}
.sev-critical{background:var(--crit)}.sev-high{background:var(--high)}.sev-medium{background:var(--med)}.sev-low{background:var(--low)}.sev-info{background:var(--info)}
.ea{display:grid;grid-template-columns:1fr 1fr;gap:16px}.ea p{margin:0}.details{margin-top:16px}
.note{background:#fff8e6;border-left:3px solid var(--med);padding:8px 12px;margin-top:12px}.note h4{margin-top:0}.note ul,.details ul{font-size:14px}
.shots{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.shots img{height:140px;border:1px solid var(--line);border-radius:6px}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--card);font-size:13px}td,th{border:1px solid var(--line);padding:8px;text-align:left;vertical-align:top;word-break:break-word}
.session{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin-bottom:10px}
@media(max-width:640px){.ea{grid-template-columns:1fr}.counts{grid-template-columns:repeat(3,1fr)}}
</style></head><body><main>
<h1>Exploratory testing report</h1>
<p class="sub">${escape(report.cfg.name)} · <a href="${escape(report.cfg.baseUrl)}">${escape(report.cfg.baseUrl)}</a> · ${escape(report.startedAt.slice(0, 16).replace("T", " "))} UTC · ${report.sessions.length} sessions</p>
<section class="summary">${ul(report.summary)}</section>
<div class="counts">${SEVERITIES.map((severity) => {
  const c = counts[severity];
  return `<div class="count"><b>${c.total}</b><span class="sev sev-${severity}">${severity}</span>${c.toVerify ? `<small>${c.toVerify} to verify</small>` : ""}</div>`;
}).join("")}</div>
<h2>Issues (${confirmed.length})</h2>
${confirmed.length ? confirmed.map(issueCard).join("\n") : "<p>No confirmed issues.</p>"}
${toVerify.length ? `<h2>Needs verification (${toVerify.length})</h2><p class="sub">Not reproduced, low confidence, or possibly intended behaviour.</p>${toVerify.map(issueCard).join("\n")}` : ""}
<h2>Runtime errors detected automatically (${report.autos.length})</h2>
${report.autos.length ? `<div class="table"><table><tr><th>ID</th><th>Severity</th><th>Seen</th><th>Error</th><th>Pages</th></tr>${report.autos
    .map((auto) => `<tr><td>${auto.id}</td><td><span class="sev sev-${auto.severity}">${auto.severity}</span></td><td>${auto.occurrences}×</td><td>${escape(auto.actual)}</td><td>${(auto.pages ?? []).slice(0, 3).map(escape).join("<br>")}</td></tr>`)
    .join("")}</table></div>` : "<p>None detected.</p>"}
<h2>Session coverage</h2>
${report.sessions
  .map(
    (session) => `<div class="session"><h3>${escape(session.sessionId)} · ${escape(session.charter.title)}</h3><p class="meta">${escape(session.charter.mission)}</p>
<p class="meta">${escape(session.stopReason)} · ${session.stepsUsed}/${session.charter.maxSteps} steps · ${session.findings.length} findings · $${session.costUsd.toFixed(2)}${session.error ? ` · error: ${escape(session.error)}` : ""}</p>
${session.summary ? prose(session.summary) : ""}${session.areasNotCovered.length ? `<h4>Not covered</h4>${ul(session.areasNotCovered)}` : ""}</div>`,
  )
  .join("\n")}
<p class="sub" style="margin-top:40px">Generated by an AI exploratory testing agent. Estimated model cost $${report.totalCostUsd.toFixed(2)}.</p>
</main></body></html>`;
}
