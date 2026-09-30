// Records a ~40 second, 1280x720 demo video of a Quick check on the demo shop into
// store/assets/demo.webm, for YouTube (the Chrome Web Store takes the video as a YouTube link).
// Frames are captured while the real extension runs against the scripted API in demo.ts, then
// encoded with the ffmpeg Playwright installs. Run with `npm run store:video -w @exploratory-agent/extension`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { agentTab, BACKGROUND, BRIEFING, dataUrl, frameHtml, HOST, iconUrl, launchDemo, layout, onboard, type Shot } from "./demo.js";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "demo.webm");
const VIDEO = layout(1280, 720, 108, 30, 17);
const FPS = 25;

// Playwright keeps its ffmpeg (VP8/WebM only) next to its browsers.
async function findFfmpeg(): Promise<string> {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === "darwin" ? path.join(os.homedir(), "Library/Caches/ms-playwright") : path.join(os.homedir(), ".cache/ms-playwright"));
  const names = { darwin: "ffmpeg-mac", linux: "ffmpeg-linux", win32: "ffmpeg-win64.exe" } as Record<string, string>;
  for (const dir of existsSync(cache) ? (await readdir(cache)).filter((name) => name.startsWith("ffmpeg")).sort().reverse() : []) {
    const binary = path.join(cache, dir, names[process.platform] ?? "ffmpeg");
    if (existsSync(binary)) return binary;
  }
  throw new Error("Playwright's ffmpeg is missing. Run `npx playwright install ffmpeg`.");
}

await mkdir(path.dirname(out), { recursive: true });
const ffmpeg = spawn(await findFfmpeg(), ["-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", "pipe:0", "-an", "-c:v", "vp8", "-b:v", "3M", "-crf", "6", "-qmin", "0", "-qmax", "40", "-deadline", "good", "-cpu-used", "2", "-y", out], {
  stdio: ["pipe", "inherit", "inherit"],
});
const encoded = new Promise<void>((resolve, reject) => ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)))));
let seconds = 0;

// Shows one frame for `ms`.
async function hold(frame: Buffer, ms: number): Promise<void> {
  const count = Math.max(1, Math.round((ms / 1000) * FPS));
  seconds += count / FPS;
  for (let i = 0; i < count; i++) {
    if (!ffmpeg.stdin.write(frame)) await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve));
  }
}

const demo = await launchDemo(VIDEO, { apiDelay: 1000 });
const { site, panel, framer } = demo;
await framer.setViewportSize({ width: VIDEO.width, height: VIDEO.height });

async function render(html: string): Promise<Buffer> {
  await framer.setContent(html);
  return framer.screenshot({ type: "jpeg", quality: 92 });
}

type Scene = Pick<Shot, "title" | "subtitle" | "url">;
let sitePage: Page = site;

let lastSite: Buffer | undefined;

// The agent's tab closes when its session ends, so keep showing its last capture until the scene changes.
async function capture(scene: Scene, pointer?: Shot["pointer"]): Promise<Buffer> {
  lastSite = await sitePage.screenshot().catch((err) => {
    if (!lastSite || !sitePage.isClosed()) throw err;
    return lastSite;
  });
  return render(frameHtml({ ...scene, site: lastSite, panel: await panel.screenshot(), pointer }, VIDEO));
}

// Where to draw the click marker for an element in the panel.
async function pointAt(locator: ReturnType<Page["locator"]>): Promise<Shot["pointer"]> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Nothing to point at");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Blends one frame into the next over `ms`.
async function fade(from: Buffer, to: Buffer, ms = 400): Promise<void> {
  const steps = Math.round((ms / 1000) * FPS);
  for (let i = 1; i <= steps; i++) {
    await hold(
      await render(`<body style="margin:0"><img src="${dataUrl(from, "jpeg")}" style="position:absolute;inset:0"><img src="${dataUrl(to, "jpeg")}" style="position:absolute;inset:0;opacity:${i / steps}">`),
      1000 / FPS,
    );
  }
}

// Captures continuously until `done` settles, showing each frame for as long as it took to take.
async function live(scene: Scene, done: Promise<unknown>): Promise<Buffer> {
  let finished = false;
  const outcome = done.then(
    () => ((finished = true), undefined),
    (err: unknown) => ((finished = true), err),
  );
  let frame = await capture(scene);
  let taken = Date.now();
  while (!finished) {
    const next = await capture(scene);
    await hold(frame, Date.now() - taken);
    frame = next;
    taken = Date.now();
  }
  const err = await outcome;
  if (err) throw err;
  return frame;
}

const card = (title: string, lines: string[]) =>
  render(`<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; width: 1280px; height: 720px; overflow: hidden; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; background: ${BACKGROUND};
      display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
    img { width: 120px; height: 120px; border-radius: 28px; box-shadow: 0 12px 32px rgba(20, 8, 70, .4); }
    h1 { margin: 28px 0 12px; font-size: 56px; letter-spacing: -1px; }
    p { margin: 4px 0; font-size: 26px; color: #e4defc; }
  </style></head><body><img src="${iconUrl}"><h1>${title}</h1>${lines.map((line) => `<p>${line}</p>`).join("")}</body></html>`);

try {
  await onboard(panel);

  // Title.
  const title = await card("Exploratory Agent", ["An AI tester for the site you're on"]);
  await hold(title, 2600);

  // Set up a Quick check.
  const start: Scene = { title: "Find bugs on the page you're on", subtitle: "Open the side panel and say what the page should do.", url: `${HOST}/` };
  const home = await capture(start);
  await fade(title, home);
  await hold(home, 1200);
  const permission = panel.getByLabel(/I own .* or have permission/);
  await hold(await capture(start, await pointAt(permission)), 600);
  await permission.check();
  await hold(await capture(start, await pointAt(permission)), 600);
  const briefing = panel.getByLabel(/What should this page do/);
  await briefing.click();
  for (let typed = 0; typed < BRIEFING.length; typed += 5) {
    await briefing.fill(BRIEFING.slice(0, typed + 5));
    await hold(await capture(start), 90);
  }
  await hold(await capture(start), 900);
  const findBugs = panel.getByRole("button", { name: "Find bugs" });
  await hold(await capture(start, await pointAt(findBugs)), 800);

  // The run, live.
  const running: Scene = { title: "It tests in its own tab while you watch", subtitle: "Edge-case inputs, repeated clicks and console errors, with live progress and cost.", url: `${HOST}/` };
  await findBugs.click();
  await panel.getByText(/^Testing /).waitFor();
  // The agent's tab appears once the run has opened it.
  for (let waited = 0; !demo.context.pages().some((page) => page !== site && page.url().startsWith(`http://${HOST}`)); waited += 100) {
    if (waited > 10_000) throw new Error("The run never opened its test tab");
    await panel.waitForTimeout(100);
  }
  sitePage = agentTab(demo);
  let frame = await live(running, panel.getByRole("heading", { name: "Done" }).waitFor({ timeout: 90_000 }));

  // Results.
  sitePage = site;
  const results: Scene = { title: "Issues ranked and ready to file", subtitle: "A plain summary, severity for each issue, and one-click Copy as issue.", url: `${HOST}/` };
  const done = await capture(results);
  await fade(frame, done, 300);
  await hold(done, 2600);
  for (let i = 0; i < 10; i++) {
    await panel.mouse.wheel(0, 40);
    await hold(await capture(results), 80);
  }
  const openReport = panel.getByRole("button", { name: "Open full report" });
  await hold(await capture(results, await pointAt(openReport)), 1400);

  // The report.
  const reportPromise = demo.context.waitForEvent("page", (page) => page.url().includes("/report.html?run="));
  await openReport.click();
  const report = await reportPromise;
  await report.setViewportSize(VIDEO.site);
  await report.frameLocator("iframe").getByText("Negative quantity makes the total negative").first().waitFor();
  await report.waitForTimeout(400);
  sitePage = report;
  const reportScene: Scene = { title: "A full report to share", subtitle: "Print it to PDF, or export CSV for Jira, Azure DevOps or Linear.", url: "Exploratory Agent report" };
  frame = await capture(reportScene);
  await hold(frame, 2200);
  const reportFrame = report.frames().find((candidate) => candidate !== report.mainFrame());
  for (let i = 0; i < 22 && reportFrame; i++) {
    await reportFrame.evaluate(() => window.scrollBy(0, 30));
    frame = await capture(reportScene);
    await hold(frame, 80);
  }
  await hold(frame, 1800);

  // Close.
  const outro = await card("Exploratory Agent", ["Bring your own Anthropic API key.", "No server: your runs stay in your browser."]);
  await fade(frame, outro, 500);
  await hold(outro, 3500);
} finally {
  ffmpeg.stdin.end();
  await demo.close();
}
await encoded;
console.log(`Wrote store/assets/demo.webm (${seconds.toFixed(1)} s)`);
