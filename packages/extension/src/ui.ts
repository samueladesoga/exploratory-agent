// Tiny DOM helpers for the extension pages (no framework).

type Child = Node | string | number | false | null | undefined | Child[];
type Attrs = Record<string, string | number | boolean | ((event: Event) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") el.addEventListener(key.replace(/^on/, "").toLowerCase(), value);
    else if (key === "class") el.className = String(value);
    // DOM properties (value, checked, disabled…) are set as properties so form state is live.
    else if (key in el) (el as any)[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : String(child));
  }
}

export const usd = (value: number): string => (value < 0.01 && value > 0 ? "<$0.01" : `$${value.toFixed(2)}`);

export function download(filename: string, data: string | Uint8Array | Blob, type = "text/plain"): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  h("a", { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function copy(text: string, button?: HTMLElement): Promise<void> {
  await navigator.clipboard.writeText(text);
  if (!button) return;
  const label = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = label), 1500);
}

export const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

// "key: value" lines → record, for test data.
export function pairs(text: string): Record<string, string> {
  return Object.fromEntries(
    lines(text).map((line) => {
      const index = line.indexOf(":");
      return index === -1 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
  );
}

export const timeAgo = (iso: string): string => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
};
