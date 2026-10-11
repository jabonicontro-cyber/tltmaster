// Captures the product screenshots used on the public website (docs/SCREENSHOTS.md).
// Run against a production build or the deployed site, signed in as a platform-team
// member inside the live demo company (fictional data). Nothing is stored except the PNGs.
//
//   CAPTURE_BASE_URL=http://localhost:3001 CAPTURE_EMAIL=... CAPTURE_PASSWORD=... \
//   PW_CHROMIUM_PATH=/path/to/chromium node scripts/capture-screenshots.mjs public/site
//
// Credentials come from the environment only; never commit them.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const base = process.env.CAPTURE_BASE_URL ?? "http://localhost:3001";
const outDir = process.argv[2] ?? "public/site";
const { CAPTURE_EMAIL: email, CAPTURE_PASSWORD: password } = process.env;
if (!email || !password) throw new Error("Set CAPTURE_EMAIL and CAPTURE_PASSWORD.");

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SHOTS = [
  { file: "command-center.png", path: "/command-center", viewport: DESKTOP },
  { file: "dispatch.png", path: "/dispatch", viewport: DESKTOP },
  { file: "tickets.png", path: "/tickets", viewport: DESKTOP },
  { file: "order.png", path: "/orders", open: /^O-\d{4}-0002$/, viewport: DESKTOP },
  { file: "driver.png", path: "/driver", viewport: PHONE },
];

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(`${base}/login`);
await page.getByLabel("Email").fill(email);
await page.getByLabel("Password").fill(password);
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"));

await page.goto(`${base}/command-center`, { waitUntil: "networkidle" });
const bar = page.getByRole("region", { name: "Demo company" });
if (!(await bar.count()) && !(await page.getByText("(Demo)").count())) throw new Error("Not inside the demo company: open it from /admin/demo first.");
if (await bar.count()) {
  await bar.getByRole("button", { name: "Presentation mode" }).click();
  await bar.waitFor({ state: "detached" });
}

for (const s of SHOTS) {
  await page.setViewportSize(s.viewport);
  await page.goto(`${base}${s.path}`, { waitUntil: "networkidle" });
  if (s.open) {
    await page.getByRole("link", { name: s.open }).first().click();
    await page.waitForLoadState("networkidle");
  }
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, s.file) });
  console.log("captured", s.file);
}
await browser.close();
