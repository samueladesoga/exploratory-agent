// Bundles the extension into dist/, ready for chrome://extensions → "Load unpacked".
// platform: "browser" makes the build fail if core ever imports a Node built-in.
import * as esbuild from "esbuild";
import { cp, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await cp("static", outdir, { recursive: true });

const options = {
  entryPoints: { background: "src/background.ts", sidepanel: "src/sidepanel.ts" },
  outdir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
