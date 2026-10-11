#!/usr/bin/env node
// Checks a deployed Taviron URL from the outside, the way a stranger would see
// it: HTTPS, the public website open, the early-access gate in front of every
// app page, API and file route, no indexing (unless SITE_INDEXING=on), and no
// secrets in the pages or their JavaScript. Needs no credentials and changes
// nothing (the form endpoint is only sent an unreadable submission).
//
//   node scripts/check-deployment.mjs https://your-app.vercel.app
import { randomUUID } from "node:crypto";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("Usage: node scripts/check-deployment.mjs https://your-app.example.com");
  process.exit(1);
}
let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const get = (path, init = {}) => fetch(base + path, { redirect: "manual", ...init });

check(base.startsWith("https://") || /localhost|127\.0\.0\.1/.test(base), "served over HTTPS", base);

// The public website: open with PUBLIC_SITE=on, otherwise behind the gate. Both are valid;
// the page must be either fully open (200) or sent to the gate — never anything in between.
const home = await get("/pricing", { headers: { accept: "text/html" } });
const siteOpen = home.status === 200;
console.log(`INFO  public website is ${siteOpen ? "open (PUBLIC_SITE=on)" : "behind the Early Access gate (PUBLIC_SITE not on)"}`);
for (const path of ["/", "/pricing", "/demo"]) {
  const r = await get(path, { headers: { accept: "text/html" } });
  if (siteOpen) check(r.status === 200, `public page ${path} is open`, String(r.status));
  else check(r.status >= 300 && r.status < 400 && (r.headers.get("location") ?? "").includes("/early-access"), `public page ${path} is behind the gate`, `${r.status} ${r.headers.get("location") ?? ""}`);
}
{
  const r = await get("/api/leads", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "not json" });
  if (siteOpen) check(r.status === 400, "the demo/contact form endpoint answers (an unreadable submission is rejected, nothing saved)", String(r.status));
  else check(r.status === 401, "the demo/contact form endpoint is behind the gate", String(r.status));
}

for (const path of ["/login", "/signup", "/command-center", "/orders", "/settings", "/driver", "/admin"]) {
  const r = await get(path, { headers: { accept: "text/html" } });
  const loc = r.headers.get("location") ?? "";
  check(r.status >= 300 && r.status < 400 && loc.includes("/early-access"), `page ${path} sends visitors to the Early Access page`, `${r.status} ${loc}`);
}
// Files and APIs: refused (401 from the app, or 403 from the host's edge), and nothing is served.
for (const [method, path, headers] of [
  ["GET", `/tickets/photos/${randomUUID()}`, { accept: "image/*,*/*" }],
  ["GET", `/quotes/${randomUUID()}/versions/${randomUUID()}/pdf`, { accept: "application/pdf,*/*" }],
  ["POST", `/tickets/${randomUUID()}/scans`, { accept: "*/*" }],
  ["POST", "/login", { accept: "text/x-component", "next-action": "check" }],
  ["POST", "/", { accept: "text/x-component", "next-action": "check" }],
]) {
  const r = await get(path, { method, headers });
  const type = r.headers.get("content-type") ?? "";
  const served = /^(image|application\/pdf)/.test(type);
  check((r.status === 401 || r.status === 403) && !served, `${method} ${path} is refused without early access`, `${r.status} ${type}`);
}

const page = await get("/early-access");
const html = await page.text();
check(page.status === 200 && html.includes("Early Access"), "Early Access page renders", String(page.status));
check((page.headers.get("x-robots-tag") ?? "").includes("noindex"), "not indexed by search engines");
if (base.startsWith("https://")) check(Boolean(page.headers.get("strict-transport-security")), "HSTS header present (set by the host)", page.headers.get("strict-transport-security") ?? "missing");

const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
let leaks = [];
for (const s of [null, ...scripts]) {
  const body = s ? await (await get(s)).text() : html;
  for (const needle of ["service_role", "SITE_ACCESS_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "sk_live", "BEGIN PRIVATE KEY"]) {
    if (body.includes(needle)) leaks.push(`${s ?? "page"}: ${needle}`);
  }
}
check(leaks.length === 0, `no secrets in the page or its ${scripts.length} scripts`, leaks.join(", "));

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
