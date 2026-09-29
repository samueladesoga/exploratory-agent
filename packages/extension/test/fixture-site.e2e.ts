// Drives a local fixture site through the CDP driver to cover what saucedemo can't: read-only
// blocking of form POSTs, dialogs, uncaught exceptions, console errors, popups, blocked link clicks,
// date inputs and contenteditable. Runs offline.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");

const PAGES: Record<string, string> = {
  "/": `<!doctype html><title>Fixture home</title>
    <h1>Fixture</h1>
    <form method="post" action="/save"><label>Name <input name="name"></label><button>Save</button></form>
    <button id="confirm" onclick="document.getElementById('out').textContent = confirm('Delete everything?') ? 'deleted' : 'kept'">Delete all</button>
    <button id="crash" onclick="undefinedFunction()">Crash</button>
    <button id="log" onclick="console.error('Checkout total is NaN')">Log error</button>
    <a href="/admin/danger">Danger zone</a>
    <a href="/popup" target="_blank">Open help</a>
    <label>Birthday <input type="date" id="birthday"></label>
    <div contenteditable="true" aria-label="Notes" role="textbox">old notes</div>
    <p id="out">idle</p>`,
  "/popup": `<!doctype html><title>Help</title><h1>Help page</h1>`,
  "/save": "saved",
};

let server: Server;
let origin: string;
let context: BrowserContext;
let harness: Page;
let profile: string;

before(async () => {
  server = createServer((request, response) => {
    const body = PAGES[new URL(request.url ?? "/", "http://x").pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html" }).end(body ?? "missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  profile = await mkdtemp(path.join(os.tmpdir(), "ea-e2e-"));
  context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
  // Playwright auto-dismisses dialogs in pages nobody listens on, racing the driver's own handling.
  context.on("page", (page) => page.on("dialog", () => {}));
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  harness = await context.newPage();
  await harness.goto(`chrome-extension://${new URL(worker.url()).host}/harness.html`);
  await harness.waitForFunction(() => document.title === "harness ready");
});

after(async () => {
  await context?.close();
  server?.close();
  await rm(profile, { recursive: true, force: true });
});

test("guardrails, dialogs, signals, popups and tricky inputs", async () => {
  const result = await harness.evaluate(async (baseUrl) => {
    const { core, CdpDriver, storage } = (globalThis as any).harness;
    const cfg = core.parseClientConfig(
      { name: "Fixture", baseUrl, description: "Fixture", safety: { blockMutations: true, blockedRequests: [{ urlPattern: "/admin/" }] } },
      "e2e",
    );
    const driver = new CdpDriver(cfg, { storage, label: "S01" });
    const ref = (snapshot: string, pattern: RegExp) => {
      const match = snapshot.split("\n").find((line: string) => pattern.test(line))?.match(/\[ref=(e\d+)\]/);
      if (!match) throw new Error(`no ref for ${pattern} in:\n${snapshot}`);
      return match[1];
    };
    const out: Record<string, unknown> = {};
    await driver.start();
    try {
      await driver.navigate("/");
      let snap = await driver.snapshot(20000);
      out.home = snap;

      await driver.fill(ref(snap, /textbox "Name"/), "Zoë 🚀");
      await driver.click(ref(snap, /button "Save"/));
      out.afterSaveUrl = driver.currentUrl();

      await driver.click(ref(snap, /button "Delete all"/));
      out.dialogOutcome = /text: "kept"/.test(await driver.snapshot(20000));

      await driver.click(ref(snap, /button "Crash"/));
      await driver.click(ref(snap, /button "Log error"/));

      await driver.click(ref(snap, /link "Danger zone"/));
      out.afterBlockedLink = driver.currentUrl();

      snap = await driver.snapshot(20000);
      await driver.fill(ref(snap, /Date "Birthday"/), "2024-02-29");
      await driver.fill(ref(snap, /textbox "Notes"/), "new notes");
      snap = await driver.snapshot(20000);
      out.birthday = snap.split("\n").find((line: string) => /Date "Birthday"/.test(line));
      out.notes = /new notes/.test(snap) && !/old notes/.test(snap);

      await driver.click(ref(snap, /link "Open help"/));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      out.popupUrl = driver.currentUrl();

      out.drained = driver.drainNew();
      out.signals = driver.signals.map((signal: { kind: string; message: string }) => `${signal.kind}: ${signal.message}`);
    } finally {
      await driver.close();
    }
    return out;
  }, `${origin}/`);

  const signals = result.signals as string[];
  const drained = String(result.drained);
  assert.equal(result.afterSaveUrl, `${origin}/`, "the blocked POST must not navigate away");
  assert.ok(signals.some((signal) => signal === `blocked-request: POST ${origin}/save blocked: mutating request blocked by safety.blockMutations`), signals.join("\n"));
  assert.equal(result.dialogOutcome, true, "confirm() is dismissed");
  assert.ok(signals.some((signal) => /^page-error: ReferenceError: undefinedFunction is not defined/.test(signal)), signals.join("\n"));
  assert.ok(signals.includes("console-error: Checkout total is NaN"), signals.join("\n"));
  assert.equal(result.afterBlockedLink, `${origin}/`, "returns from the blocked page");
  assert.ok(signals.some((signal) => signal.startsWith(`blocked-request: GET ${origin}/admin/danger blocked`)), signals.join("\n"));
  assert.match(String(result.birthday), /2024-02-29/);
  assert.equal(result.notes, true);
  assert.equal(result.popupUrl, `${origin}/popup`);
  assert.match(drained, /A new tab\/window opened/);
});
