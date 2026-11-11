import { build } from "esbuild";
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, "src/extension.ts")],
  outfile: join(here, "dist/extension.js"),
  bundle: true, platform: "node", format: "cjs", target: "node18",
  external: ["vscode"], sourcemap: true,
});
await build({
  entryPoints: [join(here, "src/webview/main.ts")],
  outfile: join(here, "dist/webview.js"),
  bundle: true, platform: "browser", format: "iife", target: "es2022", sourcemap: true,
});
cpSync(join(here, "src/webview/style.css"), join(here, "dist/webview.css"));

// ship the Python analyzer inside the extension
const target = join(here, "python/code_diagrammer");
rmSync(join(here, "python"), { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(here, "../analyzer/code_diagrammer"), target, {
  recursive: true, filter: (src) => !src.includes("__pycache__"),
});
console.log("built dist/ and python/");
