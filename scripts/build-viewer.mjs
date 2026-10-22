#!/usr/bin/env node
/**
 * Regenerate `src/viewer.html` from a published omp release.
 *
 * Mirrors `packages/coding-agent/scripts/generate-share-viewer.ts` (same
 * template, same replacements), but reads the release tarball instead of a
 * repo checkout so it needs no monorepo install or native addon.
 *
 *   node scripts/build-viewer.mjs [omp-version]
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Pinned omp release whose viewer this repo ships. */
const DEFAULT_VERSION = "18.12.6";
const PACKAGE = "@oh-my-pi/pi-coding-agent";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(root, "src", "viewer.html");
const requested = process.argv[2];
if (requested !== undefined && requested !== DEFAULT_VERSION) {
  throw new Error(
    `refusing to build ${requested}: bump DEFAULT_VERSION in this script to ${requested} so the pin matches the committed viewer`,
  );
}
const version = DEFAULT_VERSION;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-viewer-"));
try {
  const tarball = execFileSync("npm", ["pack", `${PACKAGE}@${version}`, "--silent"], {
    cwd: workDir,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop();
  if (!tarball) throw new Error("npm pack produced no tarball");

  const packageDir = path.join(workDir, "package");
  execFileSync("tar", ["xzf", path.join(workDir, tarball), "-C", workDir]);

  const htmlDir = path.join(packageDir, "src", "export", "html");
  const read = (file) => fs.readFileSync(path.join(htmlDir, file), "utf8");

  // Same composition as getTemplate() in src/export/html/index.ts.
  const minifiedCss = read("template.css")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,])\s*/g, "$1")
    .trim();
  const template = read("template.html")
    .replace("<template-css/>", () => `<style>${minifiedCss}</style>`)
    .replace("<template-marked/>", () => `<script>${read("vendor/marked.min.js")}</script>`)
    .replace("<template-highlight/>", () => `<script>${read("vendor/highlight.min.js")}</script>`)
    .replace("<template-tool-views/>", () => `<script>${read("tool-views.generated.js")}</script>`)
    .replace("<template-js/>", () => `<script>${read("template.js")}</script>`);

  const { webExportThemeVars } = await import(
    pathToFileURL(path.join(htmlDir, "web-palette.ts")).href
  );
  const themeStyles = [
    `:root, :root[data-theme="dark"] { color-scheme: dark; ${webExportThemeVars("dark")} }`,
    `:root[data-theme="light"] { color-scheme: light; ${webExportThemeVars("light")} }`,
    `@media (prefers-color-scheme: light) { :root:not([data-theme]) { color-scheme: light; ${webExportThemeVars("light")} } }`,
  ].join("\n");

  const html = template
    .replace("<theme-vars/>", () => `<style>${themeStyles}</style>`)
    .replace("<title>Session Export</title>", () => "<title>omp session</title>")
    .replace("{{SESSION_DATA}}</script>", () => `</script>\n  <script>${read("share-loader.js")}</script>`);

  if (html.includes("{{SESSION_DATA}}")) throw new Error("session-data placeholder survived substitution");
  if (!html.includes("__OMP_SESSION_DATA__")) throw new Error("share loader not injected");

  fs.writeFileSync(outPath, html);
  console.log(`Generated ${outPath} from ${PACKAGE}@${version} (${(html.length / 1024).toFixed(0)} KB)`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
