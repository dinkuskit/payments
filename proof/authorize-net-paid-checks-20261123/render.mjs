// Draws the Payments page from this branch's renderSetupScreen with EmDash's own BlockRenderer and admin
// stylesheet, then captures it with Playwright's Chromium. Run from the repository root:
//   node proof/authorize-net-paid-checks-20261123/render.mjs
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
// The Playwright installed with the machine's Chromium, resolved the CommonJS way.
const { chromium } = createRequire(import.meta.url)("playwright");
const here = new URL(".", import.meta.url).pathname;
const bundle = await build({ entryPoints: [here + "page.tsx"], bundle: true, write: false, format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
const css = readFileSync("node_modules/@emdash-cms/admin/dist/styles.css", "utf8");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-kumo-base"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
writeFileSync("/tmp/paid-twice-page.html", html);
const browser = await chromium.launch();
for (const width of [1440, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  await page.goto("file:///tmp/paid-twice-page.html");
  await page.waitForFunction(() => document.querySelector("#root")?.textContent?.includes("paid twice"));
  await page.screenshot({ path: `${here}paid-twice-${width}.png`, fullPage: true });
  if (width === 1440) writeFileSync(here + "paid-twice.blocks.json", JSON.stringify(await page.evaluate(() => window.blocks), null, 2) + "\n");
  await page.close();
}
await browser.close();
