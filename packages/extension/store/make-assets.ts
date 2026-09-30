// Generates the Chrome Web Store / Edge Add-ons images into store/assets/: five 1280x800
// screenshots, the 440x280 small promo tile and the 1400x560 marquee tile. It drives the real
// extension against the demo shop in demo.ts, so it needs no key and costs nothing.
// Run with `npm run store:assets -w @exploratory-agent/extension`.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentTab, BACKGROUND, BRIEFING, dataUrl, frameHtml, holdAt, HOST, iconUrl, launchDemo, layout, onboard, type Shot } from "./demo.js";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
const SCREENSHOT = layout(1280, 800, 136, 38, 19);

const PROMO_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; width: 440px; height: 280px; overflow: hidden; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
    background: ${BACKGROUND}; display: flex; flex-direction: column; justify-content: center; padding: 0 36px; box-sizing: border-box; }
  img { width: 72px; height: 72px; border-radius: 16px; box-shadow: 0 8px 24px rgba(20, 8, 70, .35); }
  h1 { margin: 18px 0 6px; font-size: 32px; letter-spacing: -0.5px; }
  p { margin: 0; font-size: 17px; color: #e4defc; line-height: 1.35; }
</style></head><body><img src="${iconUrl}"><h1>Exploratory Agent</h1><p>An AI tester that explores the site<br>you're on and reports the bugs it finds.</p></body></html>`;

// The marquee: the pitch on the left, the results view on the right (the shop's order summary next
// to the side panel), running off the bottom edge.
const marqueeHtml = (site: Buffer, panel: Buffer) => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 1400px; height: 560px; overflow: hidden; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; background: ${BACKGROUND}; }
  .copy { position: absolute; left: 64px; top: 0; bottom: 0; width: 500px; display: flex; flex-direction: column; justify-content: center; }
  .copy > img { width: 88px; height: 88px; border-radius: 20px; box-shadow: 0 8px 24px rgba(20, 8, 70, .35); }
  h1 { margin: 22px 0 10px; font-size: 48px; letter-spacing: -1px; }
  p { margin: 0; font-size: 22px; line-height: 1.4; color: #e4defc; }
  ul { list-style: none; padding: 0; margin: 26px 0 0; display: flex; flex-wrap: wrap; gap: 10px; }
  li { font-size: 15px; font-weight: 600; padding: 7px 14px; border-radius: 999px; background: rgba(255, 255, 255, .16); }
  .window { position: absolute; left: 620px; top: 56px; width: 740px; height: 540px; background: #fff; border-radius: 12px 12px 0 0; overflow: hidden; box-shadow: 0 24px 60px rgba(20, 8, 70, .45); }
  .bar { height: 40px; background: #e9e9ed; display: flex; align-items: center; gap: 8px; padding: 0 14px; border-bottom: 1px solid #d6d6db; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .content { display: flex; }
  .site { width: 340px; height: 500px; object-fit: cover; object-position: right top; }
  .side { width: 400px; border-left: 1px solid #d6d6db; }
  .side img { display: block; width: 400px; }
</style></head><body>
  <div class="copy"><img src="${iconUrl}"><h1>Exploratory Agent</h1>
    <p>An AI tester that explores the site you're on and reports the bugs it finds.</p>
    <ul><li>Bring your own API key</li><li>No server</li><li>Reports for Jira and Linear</li></ul></div>
  <div class="window"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span></div>
    <div class="content"><img class="site" src="${dataUrl(site)}"><div class="side"><img src="${dataUrl(panel)}"></div></div></div>
</body></html>`;

await mkdir(out, { recursive: true });
const demo = await launchDemo(SCREENSHOT);
const { site, panel, framer } = demo;

async function render(name: string, html: string, width: number, height: number): Promise<void> {
  await framer.setViewportSize({ width, height });
  await framer.setContent(html);
  await framer.screenshot({ path: path.join(out, name) });
  console.log(`Wrote store/assets/${name}`);
}
const shoot = (name: string, shot: Shot) => render(name, frameHtml(shot, SCREENSHOT), SCREENSHOT.width, SCREENSHOT.height);

try {
  // 1. Home: the Quick check on the page you're on.
  await onboard(panel);
  await panel.getByLabel(/I own .* or have permission/).check();
  await panel.getByLabel(/What should this page do/).fill(BRIEFING);
  await shoot("screenshot-1-find-bugs.png", {
    title: "Find bugs on the page you're on",
    subtitle: "Open the side panel, say what the page should do, and click Find bugs.",
    url: `${HOST}/`,
    site: await site.screenshot(),
    panel: await panel.screenshot(),
  });

  // 2. A run in progress, held after the promo code has been applied twice.
  const hold = holdAt(6);
  await panel.getByRole("button", { name: "Find bugs" }).click();
  await hold.reached;
  await panel.getByText(/Findings so far \(1\)/).waitFor();
  await panel.waitForTimeout(500);
  await shoot("screenshot-2-live-run.png", {
    title: "It tests in its own tab while you watch",
    subtitle: "Edge-case inputs, repeated clicks and console errors, with live progress and cost.",
    url: `${HOST}/`,
    site: await agentTab(demo).screenshot(),
    panel: await panel.screenshot(),
  });
  hold.release();

  // 3. Results summary, which the marquee reuses.
  await panel.getByRole("heading", { name: "Done" }).waitFor({ timeout: 60_000 });
  const results = { site: await site.screenshot(), panel: await panel.screenshot() };
  await shoot("screenshot-3-results.png", {
    title: "Issues ranked and ready to file",
    subtitle: "A plain summary, severity for each issue, and one-click Copy as issue.",
    url: `${HOST}/`,
    ...results,
  });

  // 4. The full report, next to the detailed view.
  await panel.getByRole("button", { name: "Detailed" }).click();
  const reportPromise = demo.context.waitForEvent("page", (page) => page.url().includes("/report.html?run="));
  await panel.getByRole("button", { name: "Open full report" }).click();
  const report = await reportPromise;
  await report.setViewportSize(SCREENSHOT.site);
  await report.frameLocator("iframe").getByText("Negative quantity makes the total negative").first().waitFor();
  await report.waitForTimeout(500);
  await panel.evaluate(() => window.scrollTo(0, 0));
  await shoot("screenshot-4-report.png", {
    title: "A full report with steps and screenshots",
    subtitle: "Print it to PDF, or export CSV for Jira, Azure DevOps or Linear.",
    url: "Exploratory Agent report",
    site: await report.screenshot(),
    panel: await panel.screenshot(),
  });
  await report.close();

  // 5. QA flow: the plan review.
  await panel.getByRole("button", { name: "Settings" }).click();
  await panel.getByLabel(/QA tester/).check();
  await panel.getByRole("button", { name: "Test", exact: true }).click();
  await panel.getByRole("button", { name: "Plan a session" }).click();
  await panel.getByLabel("Template").selectOption("ecommerce");
  await panel.locator("#sessions").fill("3");
  await panel.getByRole("button", { name: "Map the site and plan" }).click();
  await panel.getByRole("heading", { name: "Review the plan" }).waitFor({ timeout: 60_000 });
  await panel.evaluate(() => window.scrollTo(0, 0));
  await shoot("screenshot-5-plan.png", {
    title: "Plan sessions like a QA team",
    subtitle: "It maps the site and writes charters. You review and edit them before anything runs.",
    url: `${HOST}/`,
    site: await site.screenshot(),
    panel: await panel.screenshot(),
  });

  await render("promo-small-440x280.png", PROMO_HTML, 440, 280);
  await render("marquee-1400x560.png", marqueeHtml(results.site, results.panel), 1400, 560);
} finally {
  await demo.close();
}
