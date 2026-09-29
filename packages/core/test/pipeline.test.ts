import assert from "node:assert/strict";
import { test } from "node:test";
import { autoFindings, buildPlan, buildSessionTools, mergeTriage, renderReports, type SessionState } from "../src/index.js";
import { FakeDriver, makeConfig, makeFinding, makeSignal } from "./fixtures.js";

const charterInput = (title: string, priority: "high" | "medium" | "low", start_path = "/") => ({
  title,
  mission: "Explore it",
  area: "Area",
  start_path,
  risks: [],
  techniques: [],
  priority,
});

test("buildPlan orders charters by priority and keeps start URLs inside the app", () => {
  const plan = buildPlan(makeConfig(), {
    overview: "Strategy",
    charters: [charterInput("Low", "low", "https://evil.test/"), charterInput("High", "high", "/cart"), charterInput("Medium", "medium")],
  });
  assert.deepEqual(
    plan.charters.map((charter) => [charter.id, charter.title, charter.startUrl]),
    [
      ["C01", "High", "https://app.example.com/cart"],
      ["C02", "Medium", "https://app.example.com/"],
      ["C03", "Low", "https://app.example.com/"],
    ],
  );
  assert.equal(plan.charters[0].maxSteps, 60);
});

test("autoFindings groups signals that differ only by ids and numbers", () => {
  const autos = autoFindings([
    makeSignal({ kind: "http-error", status: 500, message: "GET https://app.example.com/api/orders/123 → HTTP 500" }),
    makeSignal({ kind: "http-error", status: 500, message: "GET https://app.example.com/api/orders/456 → HTTP 500", sessionId: "S02" }),
    makeSignal({ kind: "console-error", message: "Warning" }),
    makeSignal({ kind: "blocked-request", message: "POST blocked" }),
  ]);
  assert.equal(autos.length, 2);
  assert.equal(autos[0].id, "AUTO-001");
  assert.equal(autos[0].severity, "high");
  assert.equal(autos[0].category, "network-error");
  assert.equal(autos[0].occurrences, 2);
  assert.equal(autos[0].sessionId, "S01, S02");
  assert.equal(autos[1].severity, "medium");
});

test("mergeTriage applies groups, ignores unknown ids and never drops a finding", () => {
  const findings = [
    makeFinding({ id: "S01-F01", reproduced: false }),
    makeFinding({ id: "S02-F01" }),
    makeFinding({ id: "S02-F02", title: "Typo", severity: "low", category: "content" }),
  ];
  const { issues, summary } = mergeTriage(findings, [], {
    executive_summary: ["One", "Two", "Three"],
    groups: [{ title: "Negative totals", severity: "critical", category: "functional", finding_ids: ["S01-F01", "S02-F01", "S99-F09"], needs_verification: false }],
  });
  assert.deepEqual(summary, ["One", "Two", "Three"]);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].id, "BUG-001");
  assert.equal(issues[0].primary.id, "S02-F01", "the reproduced finding becomes the primary");
  assert.deepEqual(issues[0].related.map((finding) => finding.id), ["S01-F01"]);
  assert.equal(issues[1].primary.id, "S02-F02");
  assert.deepEqual(issues[1].triageNotes, ["Not grouped during triage."]);
});

test("mergeTriage falls back to one issue per finding when triage failed", () => {
  const { issues, summary } = mergeTriage([makeFinding({ confidence: "low" })], [], undefined);
  assert.equal(issues[0].needsVerification, true);
  assert.deepEqual(issues[0].triageNotes, ["Triage unavailable; reported as recorded."]);
  assert.match(summary[0], /1 issue/);
});

test("renderReports produces every format and escapes content", () => {
  const finding = makeFinding({ title: 'Says "<b>hi</b>"' });
  const files = renderReports({
    cfg: { name: "Acme", baseUrl: "https://app.example.com/" },
    plan: { client: "Acme", baseUrl: "https://app.example.com/", createdAt: "", overview: "", charters: [] },
    sessions: [],
    issues: [{ id: "BUG-001", title: finding.title, severity: "high", category: "functional", needsVerification: false, primary: finding, related: [] }],
    autos: [],
    summary: ["Fine"],
    totalCostUsd: 1.234,
    startedAt: "2026-09-29T10:00:00.000Z",
    endedAt: "2026-09-29T10:30:00.000Z",
  });
  assert.deepEqual(Object.keys(files).sort(), ["issues.csv", "report.html", "report.json", "report.md"]);
  assert.ok(files["report.html"].includes("Says &quot;&lt;b&gt;hi&lt;/b&gt;&quot;"));
  assert.ok(files["issues.csv"].includes('"Says ""<b>hi</b>"""'));
  assert.ok(files["report.md"].includes("**Estimated model cost:** $1.23"));
});

test("session tools enforce the step budget and record findings without using a step", async () => {
  const driver = new FakeDriver();
  const session: SessionState = { sessionId: "S01", charterId: "C01", steps: 0, maxSteps: 2, snapshotChars: 1000, findings: [], log: [], ended: false, covered: [], notCovered: [] };
  const tools = Object.fromEntries(buildSessionTools(driver, session).map((tool) => [tool.name, tool]));
  const textOf = async (name: string, args: Record<string, unknown>) => {
    const result = await tools[name].handler(args);
    return result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
  };

  assert.equal(tools.click.shape.target.description, "fake target");
  assert.match(await textOf("click", { target: "Save" }), /^OK: click\n\nSNAPSHOT\n\n\[steps used 1\/2\. WRAP UP NOW/);
  driver.failNext = true;
  assert.match(await textOf("fill", { target: "Email", value: "x" }), /^FAILED: fill: element not found/);
  assert.match(await textOf("reload", {}), /Step budget exhausted/);

  await textOf("record_finding", {
    title: "Broken",
    severity: "low",
    category: "content",
    steps: ["a"],
    expected: "b",
    actual: "c",
    confidence: "high",
    reproduced: true,
  });
  assert.equal(session.steps, 2);
  assert.equal(session.findings[0].id, "S01-F01");
  assert.deepEqual(session.findings[0].screenshots, ["screens/finding-Broken.jpg"]);
  assert.deepEqual(session.log.map((entry) => [entry.tool, entry.ok]), [["click", true], ["fill", false]]);

  await textOf("end_session", { summary: "Done", areas_covered: ["cart"], areas_not_covered: [] });
  assert.equal(session.ended, true);
  assert.match(await textOf("click", { target: "Save" }), /session has ended/);
  assert.deepEqual(driver.calls, ["click Save", "fill Email x", "screenshot finding-Broken"]);
});
