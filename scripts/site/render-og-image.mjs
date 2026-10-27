// Renders the website's link-preview image (public/og/taviron.png, 1200×630) from the brand colours and the real
// Command Center screenshot of the demo company (public/site/command-center.png, fictional data). Run again after the
// screenshot or the headline changes: node scripts/site/render-og-image.mjs
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const shot = readFileSync("public/site/command-center.png").toString("base64");
const html = `<!doctype html><html><head><style>
  @font-face { font-family: Inter; src: local("Inter"), local("Inter Variable"); }
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; overflow: hidden; font-family: Inter, "Helvetica Neue", Arial, sans-serif;
    background: radial-gradient(60% 80% at 90% 0%, rgba(22,139,255,.35), transparent 70%), linear-gradient(160deg, #10233a, #0a1626); color: #f7f9fc; }
  .wrap { position: absolute; left: 72px; top: 76px; width: 560px; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 700; letter-spacing: -.01em; }
  h1 { margin-top: 56px; font-size: 62px; line-height: 1.04; letter-spacing: -.03em; font-weight: 700; }
  p { margin-top: 26px; font-size: 25px; line-height: 1.4; color: #c7d1de; }
  .shot { position: absolute; left: 680px; top: 92px; width: 900px; border-radius: 22px; overflow: hidden;
    box-shadow: 0 40px 90px -20px rgba(0,0,0,.6); border: 1px solid rgba(199,209,222,.25); background: #fff; }
  .shot img { display: block; width: 100%; }
</style></head><body>
  <div class="wrap">
    <div class="brand"><svg width="44" height="44" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#f7f9fc"/><path d="M7 8h12.5v5H18.5v12h-5V13H7z" fill="#10233a"/><path d="M20.5 8H25v5h-4.5z" fill="#168bff"/></svg>Taviron</div>
    <h1>Your entire trucking operation. Connected.</h1>
    <p>Dispatch, tickets, billing and the shop, for hauling and aggregate companies.</p>
  </div>
  <div class="shot"><img src="data:image/png;base64,${shot}" alt=""></div>
</body></html>`;

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: "load" });
await page.screenshot({ path: "public/og/taviron.png" });
await browser.close();
console.log("wrote public/og/taviron.png");
