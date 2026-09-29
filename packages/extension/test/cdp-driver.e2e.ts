// Loads the built extension (npm run build:test) into Chromium and drives saucedemo.com through the
// CDP driver from the test-only harness page. Needs network access; no API key or model calls.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
let context: BrowserContext;
let harness: Page;
let profile: string;

before(async () => {
  profile = await mkdtemp(path.join(os.tmpdir(), "ea-e2e-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  harness = await context.newPage();
  await harness.goto(`chrome-extension://${extensionId}/harness.html`);
  await harness.waitForFunction(() => document.title === "harness ready");
});

after(async () => {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
});

test("drives saucedemo: refs, typing, clicks, selects, guardrails and signals", async () => {
  const result = await harness.evaluate(async () => {
    const { core, CdpDriver, storage, files } = (globalThis as any).harness;
    const cfg = core.parseClientConfig({ name: "Sauce", baseUrl: "https://www.saucedemo.com/", description: "Demo shop" }, "e2e");
    const driver = new CdpDriver(cfg, { storage, label: "S01" });
    const refFor = (snapshot: string, pattern: RegExp) => {
      const line = snapshot.split("\n").find((candidate: string) => pattern.test(candidate));
      const match = line && /\[ref=(e\d+)\]/.exec(line);
      if (!match) throw new Error(`no ref for ${pattern} in:\n${snapshot.slice(0, 3000)}`);
      return match[1];
    };
    const out: Record<string, unknown> = {};
    await driver.start();
    try {
      await driver.navigate("/");
      let snap = await driver.snapshot(20000);
      out.loginSnapshot = snap.slice(0, 1500);
      await driver.fill(refFor(snap, /textbox "Username"/), "standard_user");
      await driver.fill(refFor(snap, /textbox "Password"/), "secret_sauce");
      await driver.click(refFor(snap, /button "Login"/));
      out.afterLoginUrl = driver.currentUrl();

      snap = await driver.snapshot(20000);
      out.hasProducts = /Products/.test(snap);
      await driver.click(refFor(snap, /button "Add to cart"/));
      snap = await driver.snapshot(20000);
      out.cartSnapshot = snap;
      out.cartBadge = /button "Remove"/.test(snap) && /"Cart, 1 items?"|link "1"|text: "1"/.test(snap);

      await driver.selectOption(refFor(snap, /combobox/), "Price (low to high)");
      snap = await driver.snapshot(20000);
      out.sorted = /combobox[^\n]*"Price \(low to high\)"|: "Price \(low to high\)"/.test(snap);

      await driver.press("Tab");
      await driver.setViewport(390, 844);
      out.phoneViewport = (await driver.snapshot(500)).includes("Viewport: 390x844");

      try {
        await driver.navigate("https://example.com/");
      } catch (err) {
        out.offOrigin = String(err);
      }
      try {
        await driver.navigate("/logout");
      } catch (err) {
        out.logout = String(err);
      }
      await driver.navigate("/definitely-missing-page.html");
      await driver.goBack();
      out.backUrl = driver.currentUrl();

      try {
        await driver.click("e999999999");
      } catch (err) {
        out.staleRef = String(err);
      }
      try {
        await driver.click('role=button[name="Save"]');
      } catch (err) {
        out.badTarget = String(err);
      }

      const shot = await driver.screenshot("inventory");
      out.screenshot = [shot.file, (files.get(shot.file) as Uint8Array).length > 1000, shot.base64.length > 1000];
      out.pageInfo = (await driver.pageInfo())?.title;
      out.drained = driver.drainNew();
      out.signals = driver.signals.map((signal: { kind: string; message: string }) => `${signal.kind}: ${signal.message}`);
    } finally {
      await driver.close();
    }
    return out;
  });

  assert.equal(result.afterLoginUrl, "https://www.saucedemo.com/inventory.html", String(result.loginSnapshot));
  assert.equal(result.hasProducts, true);
  assert.equal(result.cartBadge, true, String(result.cartSnapshot).slice(0, 2500));
  assert.equal(result.sorted, true);
  assert.equal(result.phoneViewport, true);
  assert.match(String(result.offOrigin), /outside the allowed origins/);
  assert.match(String(result.logout), /logout blocked: matches safety\.blockedRequests/);
  assert.equal(result.backUrl, "https://www.saucedemo.com/inventory.html");
  assert.match(String(result.staleRef), /no longer on the page/);
  assert.match(String(result.badTarget), /not an element ref/);
  assert.deepEqual(result.screenshot, ["screens/S01-001-inventory.jpg", true, true]);
  assert.equal(result.pageInfo, "Swag Labs");
  const signals = result.signals as string[];
  assert.ok(signals.some((signal) => /^blocked-request: GET https:\/\/www\.saucedemo\.com\/logout blocked/.test(signal)), signals.join("\n"));
  assert.ok(signals.some((signal) => /^http-error: GET https:\/\/www\.saucedemo\.com\/definitely-missing-page\.html → HTTP 404/.test(signal)), signals.join("\n"));
});
