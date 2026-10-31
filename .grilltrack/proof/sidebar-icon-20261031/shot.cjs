// Captures the Plugins section of the EmDash admin sidebar on a local playground (https://127.0.0.1).
// Usage: node shot.cjs <out-prefix>  (Playground on https://127.0.0.1 must be running)
const { chromium } = require("playwright");
(async () => {
  const out = process.argv[2];
  const browser = await chromium.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1500 }, colorScheme: "dark" });
  await page.goto("https://127.0.0.1/", { waitUntil: "networkidle" });
  await page.goto("https://127.0.0.1/_emdash/admin", { waitUntil: "networkidle" });
  const start = page.getByRole("button", { name: "Get Started" });
  if (await start.isVisible({ timeout: 10000 }).catch(() => false)) await start.click();
  const folder = page.getByText("Dinkus Payments", { exact: true }).first();
  await folder.waitFor({ timeout: 60000 });
  await folder.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  const clip = async () => {
    const boxes = [];
    for (const name of ["Plugins", "Dinkus Commerce", "Dinkus Payments", "Dinkus Ship", "Payment settings"]) {
      const els = page.getByText(name, { exact: true });
      for (let i = 0; i < await els.count(); i++) {
        const b = await els.nth(i).boundingBox();
        if (b && b.x < 260 && await els.nth(i).isVisible()) { boxes.push(b); break; }
      }
    }
    const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 16), bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 20;
    return { x: 0, y: top, width: 260, height: bottom - top };
  };
  await page.screenshot({ path: `${out}-sidebar.png`, clip: await clip() });
  await folder.click();
  await page.getByText("Payment settings", { exact: true }).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}-sidebar-open.png`, clip: await clip() });
  console.log("saved", out);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
