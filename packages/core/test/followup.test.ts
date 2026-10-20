import assert from "node:assert/strict";
import { test } from "node:test";
import { coverageGaps, createFollowUpPlan, planToMarkdown, renderReports, withPriorIssues, type AgentRunner, type Charter, type SessionResult } from "../src/index.js";
import { makeConfig, makeFinding } from "./fixtures.js";

const charter = (id: string, startUrl = "https://app.example.com/"): Charter => ({
  id,
  title: `Charter ${id}`,
  mission: "Explore it",
  area: "Area",
  startUrl,
  risks: [],
  techniques: [],
  priority: "high",
  maxSteps: 60,
});

const session = (id: string, overrides: Partial<SessionResult> = {}): SessionResult => ({
  sessionId: id.replace(/^C/, "S"),
  charter: charter(id, `https://app.example.com/${id.toLowerCase()}`),
  startedAt: "",
  endedAt: "",
  stepsUsed: 40,
  stopReason: "completed",
  areasCovered: ["Happy path"],
  areasNotCovered: [],
  findings: [],
  signals: [],
  actionLog: [],
  costUsd: 0,
  ...overrides,
});

const issue = { id: "BUG-001", title: "Total goes negative", severity: "high" as const, category: "functional" as const, needsVerification: false, primary: makeFinding(), related: [] };

test("coverageGaps keeps sessions with listed gaps or that stopped early", () => {
  const gaps = coverageGaps([
    session("C01"),
    session("C02", { areasNotCovered: ["Coupon codes"] }),
    session("C03", { stopReason: "max_turns" }),
  ]);
  assert.deepEqual(gaps.map((gap) => [gap.charter.id, gap.notCovered]), [["C02", ["Coupon codes"]], ["C03", []]]);
});

test("withPriorIssues adds earlier issues to the known issues once", () => {
  const cfg = withPriorIssues(makeConfig({ knownIssues: ["Old one"] }), [issue]);
  assert.deepEqual(cfg.knownIssues, ["Old one", "Total goes negative (on https://app.example.com/cart, reported earlier as BUG-001)"]);
  assert.equal(withPriorIssues(cfg, [issue]).knownIssues.length, 2);
});

test("createFollowUpPlan skips the model when nothing was left uncovered", async () => {
  const runner: AgentRunner = { run: () => assert.fail("the planner should not run") };
  const { plan, gaps } = await createFollowUpPlan(makeConfig(), { label: "runs/acme/1", sessions: [session("C01")], issues: [] }, { runner, log: () => {} });
  assert.equal(gaps.length, 0);
  assert.equal(plan.charters.length, 0);
  assert.equal(plan.followUpOf, "runs/acme/1");
});

test("createFollowUpPlan links charters to their parents and caps the count", async () => {
  let prompt = "";
  const runner: AgentRunner = {
    async run(options) {
      prompt = options.prompt;
      const submit = options.tools.find((tool) => tool.name === "submit_plan")!;
      const input = (title: string, follows_up: string, start_path: string) => ({ title, mission: "m", area: "a", start_path, risks: [], techniques: [], priority: "high", follows_up });
      await submit.handler({
        overview: "Gaps",
        charters: [input("Coupons", "c02", "https://evil.test/"), input("Unknown parent", "C09", "/x"), input("Over the cap", "C03", "/y")],
      });
      return { stopReason: "end_turn", costUsd: 0.5, turns: 1 };
    },
  };
  const prior = { label: "runs/acme/1", sessions: [session("C01"), session("C02", { areasNotCovered: ["Coupon codes"] }), session("C03", { stopReason: "max_turns" })], issues: [issue] };
  const { plan, costUsd } = await createFollowUpPlan(makeConfig(), prior, { runner, log: () => {} });

  assert.match(prompt, /### C02 · Charter C02[\s\S]*Not covered:\n- Coupon codes/);
  assert.match(prompt, /### C03[\s\S]*did not finish \(max_turns\)/);
  assert.doesNotMatch(prompt, /### C01/);
  assert.match(prompt, /at most 2 charters/);
  assert.equal(costUsd, 0.5);
  assert.deepEqual(
    plan.charters.map((c) => [c.id, c.title, c.followsUp, c.startUrl]),
    [
      ["C01", "Coupons", "C02", "https://app.example.com/c02"],
      ["C02", "Unknown parent", undefined, "https://app.example.com/x"],
    ],
  );
  assert.match(planToMarkdown(plan), /Follow-up of: runs\/acme\/1[\s\S]*\*\*Follows up:\*\* C02/);

  const files = renderReports({
    cfg: { name: "Acme", baseUrl: "https://app.example.com/" },
    plan,
    sessions: [session("C01", { charter: plan.charters[0] })],
    issues: [],
    autos: [],
    summary: [],
    totalCostUsd: 0,
    startedAt: "2026-10-20T10:00:00.000Z",
    endedAt: "2026-10-20T10:30:00.000Z",
  });
  assert.match(files["report.md"], /\*\*Follow-up of:\*\* runs\/acme\/1/);
  assert.match(files["report.md"], /Follows up C02 from the earlier run\./);
  assert.match(files["report.html"], /follow-up of runs\/acme\/1/);
});
