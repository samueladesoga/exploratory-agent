// The whole extension, end to end, with a scripted stand-in for the Anthropic API: onboarding, a
// Quick run on a local site, live progress, results, history and the report page. No API key or
// cost. Screenshots of each screen go to test-results/ for review.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page, type Route } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");
const shots = path.resolve(here, "../test-results");

let server: Server;
let origin: string;
let context: BrowserContext;
let extensionId: string;
let profile: string;
const apiCalls: string[] = [];

type Message = { role: string; content: unknown };
type Body = { model: string; tools?: { name: string }[]; messages: Message[] };

const reply = (content: unknown[], stop_reason = "tool_use") => ({
  id: `msg_${Math.random().toString(36).slice(2)}`,
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content,
  stop_reason,
  usage: { input_tokens: 3000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});
const toolUse = (name: string, input: unknown) => ({ type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2)}`, name, input });

// Plays the explorer (look at the page, fill a field, record a bug, end) and then triage.
function fakeModel(body: Body): unknown {
  const tools = new Set((body.tools ?? []).map((tool) => tool.name));
  const turn = body.messages.filter((message) => message.role === "assistant").length;
  if (tools.has("submit_plan")) {
    apiCalls.push(`planner:${turn}`);
    if (turn > 0) return reply([{ type: "text", text: "Planned." }], "end_turn");
    const charter = (title: string, priority: string) => ({ title, mission: `Explore ${title} to discover defects`, area: title, start_path: "/", risks: ["Bad input"], techniques: ["Boundaries"], priority });
    return reply([toolUse("submit_plan", { overview: "Two focused charters on the shop.", charters: [charter("Quantity field", "high"), charter("Totals", "medium")] })]);
  }
  if (tools.has("submit_triage")) {
    apiCalls.push(`triage:${turn}`);
    if (turn > 0) return reply([{ type: "text", text: "Done." }], "end_turn");
    return reply([
      toolUse("submit_triage", {
        executive_summary: ["The quantity field accepts negative numbers.", "No other problems were seen.", "Only the home page was covered."],
        groups: [{ title: "Negative quantity accepted", severity: "high", category: "validation", finding_ids: ["S01-F01"], needs_verification: false }],
      }),
    ]);
  }
  apiCalls.push(`explorer:${turn}`);
  const lastUser = JSON.stringify(body.messages[body.messages.length - 1]);
  const ref = /textbox \\"Quantity\\" \[ref=(e\d+)\]/.exec(JSON.stringify(body.messages))?.[1];
  switch (turn) {
    case 0:
      return reply([{ type: "text", text: "I'll try a negative quantity." }, toolUse("fill", { target: ref, value: "-3" })]);
    case 1:
      return reply([toolUse("press_key", { key: "Enter", target: ref })]);
    case 2:
      return reply([
        toolUse("record_finding", {
          title: "Quantity accepts -3 and the total goes negative",
          severity: "high",
          category: "validation",
          steps: [`Open ${origin}/`, "Enter -3 in Quantity", "Press Enter"],
          expected: "The quantity is rejected.",
          actual: "The total shows -£30.",
          confidence: "high",
          reproduced: true,
        }),
      ]);
    case 3:
      return reply([toolUse("end_session", { summary: "Checked the quantity field.", areas_covered: ["Quantity"], areas_not_covered: ["Checkout"] })]);
    default:
      assert.match(lastUser, /Session closed/);
      return reply([{ type: "text", text: "Signing off." }], "end_turn");
  }
}

async function fakeApi(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.pathname === "/v1/models") {
    apiCalls.push("models");
    return route.fulfill({ json: { data: [{ id: "claude-sonnet-5", type: "model" }], has_more: false, first_id: null, last_id: null } });
  }
  // Slow enough that the live view can be seen mid-run.
  await new Promise((resolve) => setTimeout(resolve, 700));
  return route.fulfill({ json: fakeModel(route.request().postDataJSON() as Body) });
}

before(async () => {
  await mkdir(shots, { recursive: true });
  server = createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://x").pathname !== "/") return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Tiny shop</title>
      <h1>Tiny shop</h1>
      <label>Quantity <input id="qty" type="number" value="1" onkeydown="if (event.key === 'Enter') document.getElementById('total').textContent = '£' + this.value * 10"></label>
      <p>Total: <span id="total">£10</span></p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  profile = await mkdtemp(path.join(os.tmpdir(), "ea-ui-"));
  context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, viewport: { width: 420, height: 900 }, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
  await context.route("https://api.anthropic.com/**", fakeApi);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
});

after(async () => {
  await context?.close();
  server?.close();
  await rm(profile, { recursive: true, force: true });
});

async function panelFor(site: Page): Promise<Page> {
  const tabId = await site.evaluate(() => 0).then(async () => {
    const helper = await context.newPage();
    await helper.goto(`chrome-extension://${extensionId}/report.html`);
    const id = await helper.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/*` }))[0]?.id, origin);
    await helper.close();
    return id;
  });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}`);
  return panel;
}

test("onboarding, quick run, results, history and report", async () => {
  const site = await context.newPage();
  await site.goto(`${origin}/`);
  const panel = await panelFor(site);

  await panel.getByLabel("API key").fill("sk-ant-test-key");
  await panel.screenshot({ path: path.join(shots, "1-onboarding.png") });
  await panel.getByRole("button", { name: "Save key" }).click();
  await panel.getByRole("button", { name: /developer or founder/ }).click();

  await panel.getByText(origin, { exact: true }).waitFor();
  await panel.screenshot({ path: path.join(shots, "2-home.png"), fullPage: true });
  await panel.getByRole("button", { name: "Find bugs" }).click();
  await panel.getByText("Confirm you're allowed to test this site first.").waitFor();
  await panel.getByLabel(/I own .* or have permission/).check();
  await panel.getByLabel(/What should this page do/).fill("A shop. Quantities must be 1 or more.");
  await panel.getByRole("button", { name: "Find bugs" }).click();

  await panel
    .getByText(/Findings so far \(1\)/)
    .waitFor({ timeout: 60_000 })
    .catch(async (err) => {
      await panel.screenshot({ path: path.join(shots, "failure.png"), fullPage: true });
      throw new Error(`${err}\nAPI calls: ${apiCalls.join(", ")}\nPanel:\n${await panel.locator("main").innerText()}`);
    });
  await panel.screenshot({ path: path.join(shots, "3-running.png"), fullPage: true });

  await panel.getByRole("heading", { name: "Done" }).waitFor({ timeout: 60_000 });
  await panel.screenshot({ path: path.join(shots, "4-results-summary.png"), fullPage: true });
  const summaryText = await panel.locator("main").innerText();
  assert.match(summaryText, /Negative quantity accepted/);
  assert.match(summaryText, /The quantity field accepts negative numbers\./);
  assert.match(summaryText, /1\s*issues/);

  await panel.getByRole("button", { name: "Detailed" }).click();
  assert.match(await panel.locator("main").innerText(), /Enter -3 in Quantity/);
  await panel.screenshot({ path: path.join(shots, "5-results-detailed.png"), fullPage: true });

  await panel.getByRole("button", { name: "History" }).click();
  await panel.getByText(/Quick check · done · 1 issues, 0 to verify/).waitFor();
  await panel.screenshot({ path: path.join(shots, "6-history.png"), fullPage: true });

  const reportPromise = context.waitForEvent("page", (page) => page.url().includes("/report.html?run="));
  await panel.getByRole("button", { name: "Report", exact: true }).click();
  const report = await reportPromise;
  await report.setViewportSize({ width: 1100, height: 900 });
  const frame = report.frameLocator("iframe");
  await frame.getByText("Negative quantity accepted").first().waitFor();
  assert.ok(await frame.locator('img[src^="data:image/jpeg;base64,"]').count(), "screenshots are inlined");
  assert.equal(await report.locator(".toolbar").count(), 1);
  assert.equal(await frame.locator(".toolbar").count(), 0, "the report must not nest the viewer");
  await report.screenshot({ path: path.join(shots, "7-report.png") });

  assert.deepEqual(apiCalls, ["models", "explorer:0", "explorer:1", "explorer:2", "explorer:3", "explorer:4", "triage:0", "triage:1"]);
  await report.close();
  await panel.close();
});

test("QA flow: plan, review charters, run, detailed results, run again", async () => {
  apiCalls.length = 0;
  const site = context.pages().find((page) => page.url().startsWith(origin))!;
  const panel = await panelFor(site);

  await panel.getByRole("button", { name: "Settings" }).click();
  await panel.getByLabel(/QA tester/).check();
  await panel.getByRole("button", { name: "Test", exact: true }).click();
  // QA users see "Plan a session" first.
  const headings = await panel.locator("section.card h2").allInnerTexts();
  assert.deepEqual(headings, ["Plan a session", "Find bugs on this page"]);

  await panel.getByRole("button", { name: "Plan a session" }).click();
  await panel.getByLabel("Template").selectOption("ecommerce");
  assert.match(await panel.locator("#description").inputValue(), /online shop/);
  await panel.locator("#sessions").fill("2");
  await panel.screenshot({ path: path.join(shots, "8-full-setup.png"), fullPage: true });
  await panel.getByRole("button", { name: "Map the site and plan" }).click();

  await panel.getByRole("heading", { name: "Review the plan" }).waitFor({ timeout: 60_000 });
  await panel.screenshot({ path: path.join(shots, "9-plan-review.png"), fullPage: true });
  await panel.getByLabel("Include C02").uncheck();
  await panel.getByLabel("C01 title").fill("Quantity field (edited)");
  await panel.getByRole("button", { name: /^Run 1 session · about/ }).click();

  await panel.getByRole("heading", { name: "Done" }).waitFor({ timeout: 60_000 });
  const text = await panel.locator("main").innerText();
  assert.match(text, /Enter -3 in Quantity/, "QA users land on the detailed view");
  assert.match(text, /S01 · Quantity field \(edited\)/);

  const [download] = await Promise.all([panel.waitForEvent("download"), panel.getByRole("button", { name: "Export config for the CLI" }).click()]);
  const yaml = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString());
  assert.match(yaml, /^# Exported client config/);
  assert.match(yaml, /blockMutations: true/);

  await panel.getByRole("button", { name: "History" }).click();
  await panel.getByText(/1 sessions · done/).waitFor();
  apiCalls.length = 0;
  await panel.getByRole("button", { name: "Run again" }).first().click();
  await panel.getByRole("heading", { name: "Done" }).waitFor({ timeout: 60_000 });
  assert.equal(apiCalls.filter((call) => call.startsWith("planner")).length, 0, "run again reuses the plan");
  assert.ok(apiCalls.includes("explorer:0"));
});
