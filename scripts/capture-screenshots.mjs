// Captures the product screenshots used on the public website (docs/SCREENSHOTS.md, docs/MARKETING.md).
// The shot list is src/lib/site/screenshots.json (the feature catalog's screenshots). Run against a production build
// or the deployed site, signed in as a platform-team member inside the live demo company (fictional data):
//
//   CAPTURE_BASE_URL=http://localhost:3001 CAPTURE_EMAIL=... CAPTURE_PASSWORD=... \
//   PW_CHROMIUM_PATH=/path/to/chromium node scripts/capture-screenshots.mjs [public/site] [--only id,id]
//
// Credentials come from the environment only; never commit them. Each shot passes a quality gate before it is
// written (page ready, nothing loading, fonts and images loaded, no sideways overflow, no demo badge or dev overlay,
// no console errors); a shot that fails is not written and the script exits non-zero. public/site/manifest.json
// records what was captured, when, from where and which checks passed.
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";

/** RFC 6238 code (30 s, 6 digits, SHA-1) from a base32 secret. */
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) { const v = alphabet.indexOf(ch); if (v >= 0) bits += v.toString(2).padStart(5, "0"); }
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, "0");
}

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith("--")) ?? "public/site";
const onlyArg = args.find((a) => a.startsWith("--only"));
const only = onlyArg ? (onlyArg.includes("=") ? onlyArg.split("=")[1] : args[args.indexOf(onlyArg) + 1]).split(",") : null;
const base = process.env.CAPTURE_BASE_URL ?? "http://localhost:3001";
const { CAPTURE_EMAIL: email, CAPTURE_PASSWORD: password } = process.env;
if (!email || !password) throw new Error("Set CAPTURE_EMAIL and CAPTURE_PASSWORD.");

const { shots } = JSON.parse(readFileSync(new URL("../src/lib/site/screenshots.json", import.meta.url), "utf8"));
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const selected = shots.filter((s) => !only || only.includes(s.id));

mkdirSync(outDir, { recursive: true });
const manifestPath = join(outDir, "manifest.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { shots: {} };

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));

await page.goto(`${base}/login`);
await page.getByLabel("Email or username").fill(email);
await page.getByLabel("Password").fill(password);
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"));
// Two-step sign-in (platform accounts): the code is computed from CAPTURE_TOTP_SECRET, set in the environment only.
// The two-step page follows a redirect: give it a moment to arrive before deciding the account has none.
await page.waitForURL((u) => u.pathname === "/mfa", { timeout: 8_000 }).catch(() => {});
if (new URL(page.url()).pathname === "/mfa") {
  if (!process.env.CAPTURE_TOTP_SECRET) throw new Error("This account uses two-step sign-in: set CAPTURE_TOTP_SECRET.");
  await page.getByLabel("6-digit code").fill(totp(process.env.CAPTURE_TOTP_SECRET));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((u) => u.pathname !== "/mfa");
}
await page.goto(`${base}/command-center`, { waitUntil: "networkidle" });

// Keep the mouse off the navigation rail: it expands on hover and would cover what is clicked or captured.
await page.mouse.move(1100, 600);
// Inside the demo company only; then presentation mode (no badge, no welcome) for the whole session.
const welcome = page.getByRole("button", { name: "Explore the demo" });
if (await welcome.isVisible().catch(() => false)) await welcome.click();
const account = page.getByRole("button", { name: /^Account menu/ });
const label = (await account.getAttribute("aria-label")) ?? "";
if (!label.includes("(demo company)")) {
  // Already presenting is fine; anything else is not a demo company.
  await account.click();
  const presenting = page.getByRole("menuitemcheckbox", { name: "Presentation mode" });
  if (!(await presenting.count())) throw new Error("Not inside the demo company: open it from /admin/demo first.");
  await page.keyboard.press("Escape");
} else {
  await account.click();
  await page.getByRole("menuitemcheckbox", { name: "Presentation mode" }).click();
  // The switch is saved by a server action; wait until the page shows it (no demo badge) before capturing anything.
  await page.waitForFunction(() => !/\(demo company\)/.test(document.querySelector("[aria-label^='Account menu']")?.getAttribute("aria-label") ?? "(demo company)"), null, { timeout: 20_000 })
    .catch(() => { throw new Error("Presentation mode did not turn on."); });
}

/** The quality gate (docs/MARKETING.md §Screenshots). Returns the failed checks. */
async function gate(shot) {
  const failed = [];
  // The page's own content, not the navigation (which repeats page names).
  await page.locator("main").getByText(shot.ready, { exact: false }).first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => failed.push(`ready text "${shot.ready}" not shown`));
  await page.waitForFunction(() => !document.querySelector(".animate-spin") && ![...document.querySelectorAll("[role=status]")].some((e) => /loading|planning/i.test(e.textContent ?? "")), null, { timeout: 30_000 }).catch(() => failed.push("still loading"));
  await page.evaluate(() => document.fonts.ready);
  const facts = await page.evaluate(() => ({
    brokenImages: [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).length,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    demoBadge: /\(demo company\)/.test(document.querySelector("[aria-label^='Account menu']")?.getAttribute("aria-label") ?? ""),
    devOverlay: Boolean(document.querySelector("nextjs-portal")),
    errorPage: /This page could not be loaded|Application error/.test(document.body.innerText),
  }));
  if (facts.brokenImages) failed.push(`${facts.brokenImages} image(s) not loaded`);
  if (facts.overflow > 0) failed.push(`sideways overflow ${facts.overflow}px`);
  if (facts.demoBadge) failed.push("demo badge visible (presentation mode off)");
  if (facts.devOverlay) failed.push("development overlay present (use a production build)");
  if (facts.errorPage) failed.push("error page");
  if (consoleErrors.length) failed.push(`console errors: ${consoleErrors.join(" | ")}`);
  return failed;
}

let failures = 0;
for (const s of selected) {
  consoleErrors.length = 0;
  await page.setViewportSize(VIEWPORTS[s.viewport]);
  await page.goto(`${base}${s.path}`, { waitUntil: "networkidle" });
  if (s.open) {
    await page.getByRole("link", { name: new RegExp(s.open) }).first().click();
    await page.waitForLoadState("networkidle");
  }
  if (s.tab) {
    await page.locator("main").getByRole("tab", { name: new RegExp(`^${s.tab}`) }).or(page.locator("main").getByRole("link", { name: new RegExp(`^${s.tab}`) })).first().click();
    await page.waitForLoadState("networkidle");
  }
  if (s.scroll) {
    await page.locator("main").getByText(s.scroll, { exact: true }).first().evaluate((el) => {
      const top = el.getBoundingClientRect().top + window.scrollY - 72; // below the sticky header
      window.scrollTo(0, top);
    });
  }
  await page.mouse.move(VIEWPORTS[s.viewport].width - 40, VIEWPORTS[s.viewport].height - 40); // no hover on the rail
  const failed = await gate(s);
  if (failed.length) {
    failures++;
    console.error(`REJECTED ${s.file}: ${failed.join("; ")}`);
    continue;
  }
  await page.screenshot({ path: join(outDir, s.file) });
  manifest.shots[s.id] = { file: s.file, feature: s.feature, path: s.path, viewport: s.viewport, capturedAt: new Date().toISOString(), source: new URL(base).host, checks: "passed" };
  console.log("captured", s.file);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await browser.close();
if (failures) process.exit(1);
