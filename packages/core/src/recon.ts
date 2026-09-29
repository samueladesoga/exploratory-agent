import type { ClientConfig } from "./config.js";
import type { RunContext } from "./context.js";
import type { Signal } from "./types.js";
import { errMsg, firstLines } from "./util.js";

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

export async function reconnoitre(cfg: ClientConfig, ctx: Pick<RunContext, "createDriver" | "log">): Promise<ReconResult> {
  const browser = ctx.createDriver("recon");
  const queue = [cfg.baseUrl, ...cfg.seedPaths.map((seedPath) => new URL(seedPath, cfg.baseUrl).toString())];
  const visited = new Set<string>();
  const discovered = new Set<string>();
  const sections: string[] = [];

  await browser.start();
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
      ctx.log(`recon: ${landedUrl}`);

      const info = await browser.pageInfo().catch(() => null);
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
