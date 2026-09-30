// A real Quick run through the extension's stack (CDP driver + Messages API runner) on saucedemo as
// problem_user, which the site deliberately breaks. Spends real API credit, so it only runs when
// RUN_PAID_TESTS=1 and ANTHROPIC_API_KEY are set (the nightly workflow, or by hand).
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { saucedemoProfile } from "./profile.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");
const enabled = process.env.RUN_PAID_TESTS === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

test("finds saucedemo's known bugs with the real API", { skip: !enabled && "set RUN_PAID_TESTS=1 and ANTHROPIC_API_KEY", timeout: 15 * 60_000 }, async () => {
  const profile = await saucedemoProfile("ea-live-");
  const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const harness = await context.newPage();
    await harness.goto(`chrome-extension://${new URL(worker.url()).host}/harness.html`);
    await harness.waitForFunction(() => document.title === "harness ready");
    harness.on("console", (message) => console.log(`  ${message.text()}`));

    const report = await harness.evaluate(async (apiKey) => {
      const { core, CdpDriver, storage } = (globalThis as any).harness;
      const cfg = core.parseClientConfig(
        {
          name: "Sauce Demo",
          baseUrl: "https://www.saucedemo.com/",
          description:
            "Swag Labs, a demo online shop, logged in as problem_user. Customers browse products, sort them, add items to the cart and check out. Each product image must match its product. Sorting must reorder the list.",
          run: { sessions: 1, maxStepsPerSession: 20, maxBudgetUsdPerSession: 1, plannerModel: "sonnet", explorerModel: "sonnet" },
        },
        "live",
      );
      const login = new CdpDriver(cfg, { storage, label: "login" });
      await login.start();
      await login.navigate("/");
      const snap = await login.snapshot(20000);
      const ref = (pattern: RegExp) => snap.split("\n").find((line: string) => pattern.test(line))!.match(/\[ref=(e\d+)\]/)![1];
      await login.fill(ref(/textbox "Username"/), "problem_user");
      await login.fill(ref(/textbox "Password"/), "secret_sauce");
      await login.click(ref(/button "Login"/));
      await login.close();

      const ctx = {
        runner: core.messagesApiRunner({ apiKey, browser: true }),
        storage,
        createDriver: (label: string) => new CdpDriver(cfg, { storage, label }),
        log: (line: string) => console.log(line),
      };
      const plan = core.quickPlan(cfg, "https://www.saucedemo.com/inventory.html", "Products");
      return core.executePlan(cfg, plan, plan.charters, ctx);
    }, process.env.ANTHROPIC_API_KEY!);

    await writeFile(path.join(here, "../test-results/live-report.json"), JSON.stringify(report, null, 2)).catch(() => {});
    const session = report.sessions[0];
    console.log(`  ${session.stopReason}: ${session.stepsUsed} steps, ${report.issues.length} issues, $${report.totalCostUsd.toFixed(2)}`);
    assert.equal(session.error, undefined, session.error);
    assert.ok(session.stepsUsed >= 5, "the agent drove the browser");
    assert.ok(report.issues.length >= 1, `expected problem_user bugs, got: ${JSON.stringify(report.summary)}`);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
