import { BrowserHarness } from "./browser.js";
import type { ClientConfig } from "./config.js";
import type { Signal } from "./types.js";
import { errMsg, firstLines, type Logger } from "./util.js";

interface PageInfo {
  title: string;
  headings: string[];
  links: string[];
  nav: string[];
  forms: string[][];
  looseInputs: string[];
  buttons: string[];
}

const PAGE_INFO_SCRIPT = `(() => {
  const textOf = (element) => ((element && element.textContent) || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const labelFor = (element) => {
    const label = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]') : element.closest("label");
    return textOf(label) || element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("name") || element.getAttribute("type") || element.tagName.toLowerCase();
  };
  const fieldSelector = 'input:not([type=hidden]),select,textarea';
  return {
    title: document.title,
    headings: Array.from(document.querySelectorAll("h1,h2,h3")).map(textOf).filter(Boolean).slice(0, 12),
    links: Array.from(document.querySelectorAll("a[href]")).map((anchor) => anchor.href),
    nav: Array.from(document.querySelectorAll("nav a, header a, [role=navigation] a")).map(textOf).filter(Boolean).slice(0, 25),
    forms: Array.from(document.querySelectorAll("form")).slice(0, 5).map((form) => Array.from(form.querySelectorAll(fieldSelector)).map(labelFor).slice(0, 15)),
    looseInputs: Array.from(document.querySelectorAll(fieldSelector)).filter((element) => !element.closest("form")).map(labelFor).slice(0, 15),
    buttons: Array.from(document.querySelectorAll("button,[role=button],input[type=submit]")).map((button) => textOf(button) || button.value || button.getAttribute("aria-label") || "").filter(Boolean).slice(0, 20),
  };
})()`;

const SKIP_PATTERNS = [/log-?out|sign-?out/i, /\.(pdf|zip|csv|xlsx?|docx?|png|jpe?g|gif|svg|mp4|webp)(\?|$)/i, /^mailto:|^tel:/i];

function pageKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const hashRoute = parsed.hash.startsWith("#/") || parsed.hash.startsWith("#!/") ? parsed.hash : "";
    return `${parsed.origin}${parsed.pathname}${hashRoute}`;
  } catch {
    return undefined;
  }
}

export interface ReconResult {
  siteMap: string;
  pagesVisited: number;
  signals: Signal[];
}

export async function reconnoitre(
  cfg: ClientConfig,
  opts: { storageState?: string; screensDir: string; headless: boolean; log: Logger },
): Promise<ReconResult> {
  const browser = new BrowserHarness(cfg, { screensDir: opts.screensDir, label: "recon", headless: opts.headless });
  const queue = [cfg.baseUrl, ...cfg.seedPaths.map((seedPath) => new URL(seedPath, cfg.baseUrl).toString())];
  const visited = new Set<string>();
  const discovered = new Set<string>();
  const sections: string[] = [];

  await browser.start(opts.storageState);
  try {
    while (queue.length && visited.size < cfg.run.reconMaxPages) {
      const url = queue.shift()!;
      const key = pageKey(url);
      if (!key || visited.has(key)) continue;
      visited.add(key);

      try {
        await browser.navigate(url);
      } catch (err) {
        sections.push(`### ${url}\n(failed to load: ${firstLines(errMsg(err), 1)})`);
        continue;
      }
      const landedUrl = browser.currentUrl();
      const landedKey = pageKey(landedUrl);
      if (landedKey) visited.add(landedKey);
      opts.log(`recon: ${landedUrl}`);

      const info = (await browser.page.evaluate(PAGE_INFO_SCRIPT).catch(() => null)) as PageInfo | null;
      if (!info) {
        sections.push(`### ${landedUrl}\n(could not read page structure)`);
        continue;
      }
      const lines = [`### ${info.title || "(untitled)"} — ${landedUrl}${landedUrl !== url ? ` (requested ${url})` : ""}`];
      if (info.headings.length) lines.push(`Headings: ${info.headings.join(" | ")}`);
      if (info.nav.length) lines.push(`Navigation: ${info.nav.join(" | ")}`);
      info.forms.forEach((form, index) => lines.push(`Form ${index + 1} fields: ${form.join(", ") || "(none)"}`));
      if (info.looseInputs.length) lines.push(`Inputs outside forms: ${info.looseInputs.join(", ")}`);
      if (info.buttons.length) lines.push(`Buttons: ${info.buttons.join(" | ")}`);
      sections.push(lines.join("\n"));

      for (const link of info.links) {
        const linkKey = pageKey(link);
        if (!linkKey || !browser.isAppUrl(link) || SKIP_PATTERNS.some((pattern) => pattern.test(link))) continue;
        discovered.add(linkKey);
        if (!visited.has(linkKey)) queue.push(link);
      }
    }
  } finally {
    await browser.close();
  }

  const unvisited = [...discovered].filter((key) => !visited.has(key)).slice(0, 50);
  const signals = browser.signals.filter((signal) => signal.kind !== "blocked-request").map((signal) => ({ ...signal, sessionId: "recon" }));
  const siteMap = [
    `Pages visited: ${visited.size}`,
    ...sections,
    unvisited.length ? `### Linked but not visited\n${unvisited.join("\n")}` : "",
    signals.length
      ? `### Runtime errors already seen during recon\n${[...new Set(signals.map((signal) => `[${signal.kind}] ${signal.message}`))].slice(0, 20).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { siteMap, pagesVisited: visited.size, signals };
}
