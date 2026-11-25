// Runs tests/runtime/public-route-site-check.test.ts through the real Worker entry (workerd, via
// @cloudflare/vitest-plugin) on this branch and on a main checkout, keeps each request's PROOF row, and
// draws both traces side by side with Playwright's Chromium. Run from the repository root:
//   node proof/public-route-site-check-20261125/render.mjs <path-to-a-main-checkout>
// The main checkout needs this branch's test file copied into tests/runtime/ and node_modules linked.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const here = new URL(".", import.meta.url).pathname;
const mainTree = process.argv[2];
if (!mainTree) throw new Error("usage: render.mjs <main checkout>");

function trace(cwd) {
  const run = spawnSync("npx", ["vitest", "run", "tests/runtime/public-route-site-check.test.ts", "--reporter=verbose"], { cwd, encoding: "utf8" });
  const text = run.stdout + run.stderr;
  const rows = text.split("\n").filter(line => line.startsWith("PROOF ")).map(line => JSON.parse(line.slice(6)));
  const summary = (text.match(/Tests\s+[^\n]+/) ?? [""])[0].replace(/\u001b\[[0-9;]*m/g, "").trim();
  return { rows, summary };
}

const main = trace(mainTree);
const branch = trace(".");
const key = row => `${row.route}|${row.case}`;
const before = new Map(main.rows.map(row => [key(row), row]));
const cell = row => row ? `${row.status} · ${row.doLookups} · ${row.providerCalls}` : "—";
const lines = branch.rows.map(row => {
  const old = before.get(key(row));
  const changed = !old || old.status !== row.status || old.doLookups !== row.doLookups || old.providerCalls !== row.providerCalls;
  return { route: row.route, case: row.case, main: cell(old), branch: cell(row), changed };
});
writeFileSync(`${here}trace-main.txt`, main.rows.map(row => JSON.stringify(row)).join("\n") + `\n${main.summary}\n`);
writeFileSync(`${here}trace-branch.txt`, branch.rows.map(row => JSON.stringify(row)).join("\n") + `\n${branch.summary}\n`);

const escape = value => String(value).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1b1b1f;background:#fff}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 16px;color:#555}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e3e3e8;padding:7px 10px;text-align:left;vertical-align:top}
th{background:#f5f5f7;font-weight:600}td.num{font-family:ui-monospace,monospace;white-space:nowrap}
tr.changed td{background:#eef7ee}tr.changed td.main{color:#a3261b}
.foot{margin-top:14px;font-family:ui-monospace,monospace;font-size:12px;color:#555}
</style></head><body>
<h1>Public Authorize.net routes and store passes, through the Payments Worker</h1>
<p>Each cell: HTTP status · Durable Object lookups · Authorize.net calls for that one request. Green rows changed.</p>
<table><tr><th>Route</th><th>Request</th><th>main (bd97232)</th><th>this branch</th></tr>
${lines.map(l => `<tr class="${l.changed ? "changed" : ""}"><td>${escape(l.route)}</td><td>${escape(l.case)}</td><td class="num main">${escape(l.main)}</td><td class="num">${escape(l.branch)}</td></tr>`).join("\n")}
</table>
<div class="foot">main: ${escape(main.summary)}<br>this branch: ${escape(branch.summary)}</div>
</body></html>`;
writeFileSync("/tmp/public-route-site-check.html", html);
const browser = await chromium.launch();
for (const width of [1440, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  await page.goto("file:///tmp/public-route-site-check.html");
  await page.screenshot({ path: `${here}site-check-${width}.png`, fullPage: true });
  await page.close();
}
await browser.close();
console.log(JSON.stringify({ main: main.summary, branch: branch.summary, rows: lines.length, changed: lines.filter(l => l.changed).length }));
