// The demo the store images and video are made from: a local shop with planted bugs, a scripted
// stand-in for the Anthropic API, and the frame that shows the site and side panel as a browser
// window. Shared by make-assets.ts and make-video.ts.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page, type Route } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");

// The shop is served on a readable hostname so the panel and URL bar don't show 127.0.0.1:port.
export const HOST = "fernhill.example";
export const SHOP = `http://${HOST}`;

export const SHOP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fernhill Supply Co. · Cart</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, sans-serif; color: #1f2a24; background: #f6f4ef; }
  header { display: flex; align-items: center; gap: 28px; padding: 14px 32px; background: #24463a; color: #fff; }
  header strong { font-size: 18px; letter-spacing: .3px; margin-right: auto; }
  header a { color: #d9e7df; text-decoration: none; }
  main { display: grid; grid-template-columns: 1fr 300px; gap: 24px; padding: 24px 32px; }
  h1 { font-size: 22px; margin: 0 0 14px; }
  .items { display: grid; gap: 12px; }
  .item { display: flex; gap: 14px; align-items: center; background: #fff; border-radius: 10px; padding: 12px; }
  .thumb { width: 64px; height: 64px; border-radius: 8px; flex: none; }
  .item p { margin: 0; color: #5d6b63; font-size: 13px; }
  .item b { display: block; }
  .item .price { margin-left: auto; font-weight: 600; }
  label { font-size: 13px; color: #5d6b63; display: block; margin: 10px 0 4px; }
  input { font: inherit; padding: 7px 9px; border: 1px solid #c9cfc9; border-radius: 6px; width: 100%; background: #fff; }
  .row { display: flex; gap: 8px; }
  .row input { flex: 1; }
  button { font: inherit; padding: 7px 12px; border-radius: 6px; border: 1px solid #24463a; background: #fff; color: #24463a; cursor: pointer; }
  aside { background: #fff; border-radius: 10px; padding: 18px; align-self: start; }
  aside h2 { font-size: 16px; margin: 0 0 6px; }
  .line { display: flex; justify-content: space-between; margin: 6px 0; }
  .total { font-weight: 700; font-size: 17px; border-top: 1px solid #e4e4de; padding-top: 10px; margin-top: 10px; }
  .checkout { width: 100%; margin-top: 14px; padding: 10px; background: #24463a; color: #fff; font-weight: 600; }
  #promo-msg { font-size: 13px; color: #24463a; min-height: 20px; margin-top: 4px; }
</style></head><body>
<header><strong>Fernhill Supply Co.</strong><a href="/">Shop</a><a href="/">Cart (1)</a><a href="/help">Help</a></header>
<main>
  <section>
    <h1>Your cart</h1>
    <div class="items">
      <div class="item"><div class="thumb" style="background:linear-gradient(135deg,#8fb39c,#3f6b57)"></div>
        <div><b>Trail flask, 750 ml</b><p>Insulated steel · Moss</p>
          <label for="qty">Quantity</label><div class="row"><input id="qty" type="number" min="1" value="2" style="width:80px;flex:none"><button id="update">Update cart</button></div></div>
        <span class="price">£24.00</span></div>
    </div>
    <h1 style="margin-top:22px">You might also like</h1>
    <div class="items" style="grid-template-columns:1fr 1fr">
      <div class="item"><div class="thumb" style="background:linear-gradient(135deg,#e2b86b,#a66a2c)"></div><div><b>Canvas tote</b><p>£32.00</p></div></div>
      <div class="item"><div class="thumb" style="background:linear-gradient(135deg,#9db4d6,#3d5a85)"></div><div><b>Wool beanie</b><p>£18.00</p></div></div>
    </div>
  </section>
  <aside>
    <h2>Order summary</h2>
    <div class="line"><span>Subtotal</span><span id="subtotal">£48.00</span></div>
    <div class="line"><span>Discount</span><span id="discount">£0.00</span></div>
    <div class="line"><span>Shipping</span><span>£4.95</span></div>
    <div class="line total"><span>Total</span><span id="total">£52.95</span></div>
    <label for="promo">Promo code</label>
    <div class="row"><input id="promo" placeholder="e.g. SAVE10"><button id="apply">Apply</button></div>
    <div id="promo-msg" role="status"></div>
    <button class="checkout" id="checkout">Checkout</button>
  </aside>
</main>
<script>
  // Planted bugs: negative quantities are accepted, SAVE10 stacks on every click, and Checkout throws.
  let qty = 2, discountRate = 0;
  const money = (n) => (n < 0 ? "-£" : "£") + Math.abs(n).toFixed(2);
  function render() {
    const subtotal = qty * 24, discount = subtotal * discountRate;
    document.getElementById("subtotal").textContent = money(subtotal);
    document.getElementById("discount").textContent = money(-discount);
    document.getElementById("total").textContent = money(subtotal - discount + 4.95);
  }
  document.getElementById("update").onclick = () => { qty = Number(document.getElementById("qty").value); render(); };
  document.getElementById("apply").onclick = () => {
    if (document.getElementById("promo").value.trim().toUpperCase() !== "SAVE10") return;
    discountRate += 0.1;
    document.getElementById("promo-msg").textContent = "SAVE10 applied: " + Math.round(discountRate * 100) + "% off";
    render();
  };
  document.getElementById("checkout").onclick = () => { const order = {}; console.log(order.shipping.address); };
</script></body></html>`;

export const HELP_HTML = `<!doctype html><title>Fernhill Supply Co. · Help</title><h1>Help</h1><p>Orders ship in 2 working days. Returns within 30 days.</p><a href="/">Back to cart</a>`;

// --- Scripted stand-in for the Anthropic API -------------------------------------------------

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

// The last [ref=eN] the page snapshots gave for an element, e.g. ref(body, "button", "Apply").
function ref(body: Body, role: string, name: string): string {
  const pattern = new RegExp(`${role} \\\\"${name}\\\\"(?: \\[[a-z=]+\\])* \\[ref=(e\\d+)\\]`, "g");
  const matches = [...JSON.stringify(body.messages).matchAll(pattern)];
  if (!matches.length) throw new Error(`No ref for ${role} "${name}" in the snapshots`);
  return matches[matches.length - 1][1];
}

// Lets a script hold the explorer at a given turn, e.g. to screenshot the live run.
let pause: { turn: number; reached: () => void; release: Promise<void> } | undefined;

// Resolves when the explorer reaches `turn` and waits there until release() is called.
export function holdAt(turn: number): { reached: Promise<void>; release: () => void } {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  pause = { turn, reached, release: new Promise<void>((resolve) => (release = resolve)) };
  return { reached: reachedPromise, release };
}

// How long each fake API call takes, so a recording can show the run at a watchable pace.
let apiDelay = 300;

async function fakeModel(body: Body): Promise<unknown> {
  const tools = new Set((body.tools ?? []).map((tool) => tool.name));
  const turn = body.messages.filter((message) => message.role === "assistant").length;
  if (tools.has("submit_plan")) {
    if (turn > 0) return reply([{ type: "text", text: "Planned." }], "end_turn");
    const charter = (title: string, mission: string, risks: string[], techniques: string[], priority: string) => ({ title, mission, area: title, start_path: "/", risks, techniques, priority });
    return reply([
      toolUse("submit_plan", {
        overview: "The cart page carries the money logic, so the sessions focus on quantities, discounts and the hand-off to checkout.",
        charters: [
          charter("Cart quantities and totals", "Explore the quantity field and cart totals to discover calculation and validation defects", ["Negative or zero quantities", "Rounding in totals"], ["Boundary values", "Invalid input"], "high"),
          charter("Promo codes and discounts", "Explore promo codes to discover discounts that apply wrongly or more than once", ["Code stacking", "Case sensitivity"], ["Repeated actions", "Equivalence classes"], "high"),
          charter("Checkout hand-off", "Explore the Checkout button to discover errors between the cart and payment", ["JavaScript errors", "Lost cart state"], ["Error guessing", "Back and reload"], "medium"),
        ],
      }),
    ]);
  }
  if (tools.has("submit_triage")) {
    if (turn > 0) return reply([{ type: "text", text: "Done." }], "end_turn");
    return reply([
      toolUse("submit_triage", {
        executive_summary: ["Checkout is broken: the button throws an error and goes nowhere.", "The cart accepts negative quantities, so totals can go below zero.", "SAVE10 can be applied again and again."],
        groups: [
          { title: "Checkout button throws and goes nowhere", severity: "critical", category: "error-handling", finding_ids: ["S01-F03"], needs_verification: false },
          { title: "Negative quantity makes the total negative", severity: "high", category: "validation", finding_ids: ["S01-F01"], needs_verification: false },
          { title: "SAVE10 stacks on every click", severity: "medium", category: "functional", finding_ids: ["S01-F02"], needs_verification: false },
        ],
      }),
    ]);
  }
  if (pause?.turn === turn) {
    pause.reached();
    await pause.release;
  }
  switch (turn) {
    case 0:
      return reply([{ type: "text", text: "I'll start with the cart: quantity, promo code, then checkout." }, toolUse("fill", { target: ref(body, "spinbutton", "Quantity"), value: "-3" })]);
    case 1:
      return reply([toolUse("click", { target: ref(body, "button", "Update cart") })]);
    case 2:
      return reply([
        toolUse("record_finding", {
          title: "Quantity accepts -3 and the order total goes negative",
          severity: "high",
          category: "validation",
          steps: [`Open ${SHOP}/`, "Enter -3 in Quantity", "Click Update cart"],
          expected: "Quantities below 1 are rejected.",
          actual: "The subtotal shows -£72.00 and the total -£67.05.",
          confidence: "high",
          reproduced: true,
          attach_screenshot: true,
        }),
      ]);
    case 3:
      return reply([toolUse("fill", { target: ref(body, "textbox", "Promo code"), value: "SAVE10" })]);
    case 4:
    case 5:
      return reply([toolUse("click", { target: ref(body, "button", "Apply") })]);
    case 6:
      return reply([
        toolUse("record_finding", {
          title: "SAVE10 can be applied repeatedly, adding 10% off each time",
          severity: "medium",
          category: "functional",
          steps: [`Open ${SHOP}/`, "Enter SAVE10 in Promo code", "Click Apply twice"],
          expected: "The code applies once, for 10% off.",
          actual: "The second click raises the discount to 20%.",
          confidence: "high",
          reproduced: true,
          attach_screenshot: true,
        }),
      ]);
    case 7:
      return reply([toolUse("click", { target: ref(body, "button", "Checkout") })]);
    case 8:
      return reply([
        toolUse("record_finding", {
          title: "Checkout throws a TypeError and nothing happens",
          severity: "critical",
          category: "error-handling",
          steps: [`Open ${SHOP}/`, "Click Checkout"],
          expected: "The checkout page opens.",
          actual: "The page stays on the cart and the console shows a TypeError.",
          confidence: "high",
          reproduced: true,
        }),
      ]);
    case 9:
      return reply([toolUse("end_session", { summary: "Tested the cart's quantity, promo code and checkout. The money logic has two validation gaps and checkout is broken.", areas_covered: ["Quantity", "Promo code", "Checkout button"], areas_not_covered: ["Payment, which checkout never reached"] })]);
    default:
      return reply([{ type: "text", text: "Signing off." }], "end_turn");
  }
}

async function fakeApi(route: Route): Promise<void> {
  if (new URL(route.request().url()).pathname === "/v1/models") {
    return route.fulfill({ json: { data: [{ id: "claude-sonnet-5", type: "model" }], has_more: false, first_id: null, last_id: null } });
  }
  await new Promise((resolve) => setTimeout(resolve, apiDelay));
  return route.fulfill({ json: await fakeModel(route.request().postDataJSON() as Body) });
}


// --- Framing -------------------------------------------------------------------------------

export const dataUrl = (image: Buffer, type = "png") => `data:image/${type};base64,${image.toString("base64")}`;
export const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
export const iconUrl = dataUrl(await readFile(path.join(here, "../static/icons/icon-128.png")));
export const BACKGROUND = "radial-gradient(circle at 85% -10%, #8d76ff 0, transparent 55%), linear-gradient(135deg, #4a2fc4, #5b3fd6 55%, #6a4fe3)";

// A frame: a headline over a browser window whose content area is the site on the left and the
// side panel on the right. The window runs off the bottom edge.
export interface Layout {
  width: number;
  height: number;
  windowTop: number;
  titleSize: number;
  subtitleSize: number;
  site: { width: number; height: number };
  panel: { width: number; height: number };
}

const BAR = 40;
const PANEL_HEADER = 36;

// `contentHeight` is the site's height; the panel is shorter by Chrome's panel header.
export function layout(width: number, height: number, windowTop: number, titleSize: number, subtitleSize: number): Layout {
  const contentHeight = height - windowTop - BAR;
  return { width, height, windowTop, titleSize, subtitleSize, site: { width: 800, height: contentHeight }, panel: { width: 400, height: contentHeight - PANEL_HEADER } };
}

export interface Shot {
  title: string;
  subtitle: string;
  url: string;
  site: Buffer;
  panel: Buffer;
  // A click marker, in panel coordinates.
  pointer?: { x: number; y: number };
}

export function frameHtml(shot: Shot, l: Layout): string {
  const windowWidth = l.site.width + l.panel.width;
  const pointer = shot.pointer
    ? `<div class="pointer" style="left:${l.site.width + shot.pointer.x}px;top:${BAR + PANEL_HEADER + shot.pointer.y}px"></div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; width: ${l.width}px; height: ${l.height}px; overflow: hidden; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: ${BACKGROUND}; color: #fff; }
    .copy { position: absolute; left: ${(l.width - windowWidth) / 2}px; top: ${Math.round((l.windowTop - l.titleSize * 1.25 - l.subtitleSize * 1.5 - 6) / 2)}px; right: 40px; }
    h1 { margin: 0; font-size: ${l.titleSize}px; line-height: 1.25; font-weight: 700; letter-spacing: -0.5px; }
    p { margin: 6px 0 0; font-size: ${l.subtitleSize}px; line-height: 1.5; color: #e4defc; }
    .window { position: absolute; left: ${(l.width - windowWidth) / 2}px; top: ${l.windowTop}px; width: ${windowWidth}px; height: ${l.height - l.windowTop + 20}px; background: #fff; border-radius: 12px 12px 0 0; overflow: hidden;
      box-shadow: 0 24px 60px rgba(20, 8, 70, .45); }
    .bar { height: ${BAR}px; background: #e9e9ed; display: flex; align-items: center; gap: 8px; padding: 0 14px; border-bottom: 1px solid #d6d6db; }
    .dot { width: 12px; height: 12px; border-radius: 50%; }
    .url { margin-left: 14px; flex: 1; max-width: 620px; height: 26px; border-radius: 13px; background: #fff; color: #3c3c43; font-size: 13px; display: flex; align-items: center; padding: 0 14px; }
    .ext { margin-left: auto; width: 20px; height: 20px; }
    .content { display: flex; }
    .site { width: ${l.site.width}px; height: ${l.site.height}px; display: block; }
    .side { width: ${l.panel.width}px; border-left: 1px solid #d6d6db; background: #f7f7f5; }
    .side header { height: ${PANEL_HEADER}px; display: flex; align-items: center; gap: 8px; padding: 0 12px; font-size: 13px; font-weight: 600; color: #1d1d1f; background: #fff; border-bottom: 1px solid #e3e3e0; }
    .side header img { width: 16px; height: 16px; }
    .side > img { display: block; width: ${l.panel.width}px; height: ${l.panel.height}px; }
    .pointer { position: absolute; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 3px solid #ffb020; background: rgba(255, 176, 32, .25); }
  </style></head><body>
    <div class="copy"><h1>${escape(shot.title)}</h1><p>${escape(shot.subtitle)}</p></div>
    <div class="window">
      <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
        <span class="url">${escape(shot.url)}</span><img class="ext" src="${iconUrl}"></div>
      <div class="content"><img class="site" src="${dataUrl(shot.site)}">
        <div class="side"><header><img src="${iconUrl}">Exploratory Agent</header><img src="${dataUrl(shot.panel)}"></div></div>
      ${pointer}
    </div>
  </body></html>`;
}

// --- Launch -------------------------------------------------------------------------------

export interface Demo {
  context: BrowserContext;
  extensionId: string;
  // The user's tab on the shop, and the side panel pointed at it.
  site: Page;
  panel: Page;
  // A spare page for rendering frames.
  framer: Page;
  close(): Promise<void>;
}

export async function launchDemo(l: Layout, options: { apiDelay?: number } = {}): Promise<Demo> {
  apiDelay = options.apiDelay ?? 300;
  pause = undefined;
  const server = createServer((request, response) => {
    const body = { "/": SHOP_HTML, "/help": HELP_HTML }[new URL(request.url ?? "/", "http://x").pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html" }).end(body ?? "Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const profile = await mkdtemp(path.join(os.tmpdir(), "ea-store-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: l.site,
    colorScheme: "light",
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--host-resolver-rules=MAP ${HOST}:80 127.0.0.1:${port}`, "--disable-features=HttpsUpgrades"],
  });
  const close = async () => {
    await context.close();
    server.close();
    await rm(profile, { recursive: true, force: true });
  };
  try {
    context.on("page", (page) => page.on("dialog", () => {}));
    await context.route("https://api.anthropic.com/**", fakeApi);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;

    const framer = await context.newPage();
    const site = await context.newPage();
    await site.goto(`${SHOP}/`);
    const helper = await context.newPage();
    await helper.goto(`chrome-extension://${extensionId}/report.html`);
    const siteTab = await helper.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/*` }))[0]?.id, SHOP);
    await helper.close();
    const panel = await context.newPage();
    await panel.setViewportSize(l.panel);
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${siteTab}`);
    return { context, extensionId, site, panel, framer, close };
  } catch (err) {
    await close();
    throw err;
  }
}

// Saves a key and picks the developer role, landing on the Quick check home view.
export async function onboard(panel: Page): Promise<void> {
  await panel.getByLabel("API key").fill("sk-ant-store-demo");
  await panel.getByRole("button", { name: "Save key" }).click();
  await panel.getByRole("button", { name: /developer or founder/ }).click();
  await panel.getByText(SHOP, { exact: true }).waitFor();
}

// The tab the extension opened for the run.
export function agentTab(demo: Demo): Page {
  const tab = demo.context.pages().filter((page) => page !== demo.site && page.url().startsWith(SHOP)).pop();
  if (!tab) throw new Error("Couldn't find the agent's test tab");
  return tab;
}

export const BRIEFING = "Shopping cart. Quantities must be 1 or more. SAVE10 gives 10% off, once per order.";
