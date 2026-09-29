// Bundles the extension into dist/, ready for chrome://extensions → "Load unpacked".
// platform: "browser" makes the build fail if core ever imports a Node built-in.
// --test-harness adds harness.html, a page the end-to-end tests drive; release builds leave it out.
import * as esbuild from "esbuild";
import { cp, rm, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const testHarness = process.argv.includes("--test-harness");
const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await cp("static", outdir, { recursive: true });

const entryPoints = { background: "src/background.ts", sidepanel: "src/sidepanel.ts", report: "src/report-page.ts" };
if (testHarness) {
  entryPoints.harness = "src/harness.ts";
  await writeFile(`${outdir}/harness.html`, '<!doctype html><meta charset="utf-8"><title>harness</title><script type="module" src="harness.js"></script>');
}

const options = {
  entryPoints,
  outdir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
