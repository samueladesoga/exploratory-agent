export const slug = (value: string, max = 40): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "item";

export const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}… [truncated ${value.length - max} chars]` : value;

const ANSI_ESCAPE = /\[[0-9;]*m/g;

export const firstLines = (value: string, lines = 3, max = 600): string =>
  truncate(
    value
      .replace(ANSI_ESCAPE, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && line !== "Call log:")
      .slice(0, lines)
      .join(" | "),
    max,
  );

export const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

export const stripQuery = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
};

export const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function pool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export type Logger = (line: string) => void;

export const makeLogger = (): Logger => (line) => {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`[${time}] ${line}`);
};
