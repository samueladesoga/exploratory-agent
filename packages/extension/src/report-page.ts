// Full-page report viewer: report.html?run=<id>. Shows the same HTML report the CLI writes, with
// screenshots inlined so the downloaded file is self-contained.
import { clientConfigToYaml } from "@exploratory-agent/core";
import { getFile, getRun, listFiles } from "./db.js";
import { download, h } from "./ui.js";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function selfContainedHtml(runId: string): Promise<string> {
  let html = String((await getFile(runId, "report.html")) ?? "");
  for (const path of (await listFiles(runId)).filter((file) => file.startsWith("screens/"))) {
    const data = await getFile(runId, path);
    if (!(data instanceof Uint8Array)) continue;
    html = html.split(`"${path}"`).join(`"data:image/jpeg;base64,${toBase64(data)}"`);
  }
  return html;
}

async function main(): Promise<void> {
  const runId = new URLSearchParams(location.search).get("run") ?? "";
  const run = await getRun(runId);
  const app = document.getElementById("app")!;
  if (!run) {
    app.replaceChildren(h("p", {}, "This report no longer exists. It may have been deleted from History."));
    return;
  }
  document.title = `Report · ${run.name}`;
  const html = await selfContainedHtml(runId);
  const frame = h("iframe", { title: `Exploratory testing report for ${run.name}`, srcdoc: html });
  const fileButton = (label: string, path: string, type: string, filename: string) =>
    h("button", { onclick: async () => download(filename, String((await getFile(runId, path)) ?? ""), type) }, label);
  const base = run.name.replace(/[^\w.-]+/g, "-");

  app.replaceChildren(
    h(
      "header",
      { class: "toolbar" },
      h("strong", {}, run.name),
      h("span", { class: "spacer" }),
      h("button", { class: "accent", onclick: () => frame.contentWindow?.print() }, "Print / Save as PDF"),
      h("button", { onclick: () => download(`${base}-report.html`, html, "text/html") }, "HTML"),
      fileButton("Markdown", "report.md", "text/markdown", `${base}-report.md`),
      fileButton("CSV", "issues.csv", "text/csv", `${base}-issues.csv`),
      fileButton("JSON", "report.json", "application/json", `${base}-report.json`),
      h("button", { onclick: () => download(`${base}.yaml`, clientConfigToYaml(run.config), "text/yaml") }, "Config (YAML)"),
    ),
    frame,
  );
}

main().catch((err) => {
  document.getElementById("app")!.textContent = `Could not open the report: ${err instanceof Error ? err.message : String(err)}`;
});
