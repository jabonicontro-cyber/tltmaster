#!/usr/bin/env node
// Checks a deployed Taviron URL from the outside, the way a stranger would see
// it: HTTPS, the early-access gate in front of every page, API and file route,
// no indexing, and no secrets in the page or its JavaScript. Needs no
// credentials and changes nothing.
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

for (const path of ["/", "/login", "/signup", "/command-center", "/orders", "/settings", "/driver"]) {
  const r = await get(path, { headers: { accept: "text/html" } });
  const loc = r.headers.get("location") ?? "";
  check(r.status >= 300 && r.status < 400 && loc.includes("/early-access"), `page ${path} sends visitors to the Early Access page`, `${r.status} ${loc}`);
}
for (const [method, path] of [["GET", `/tickets/photos/${randomUUID()}`], ["GET", `/quotes/${randomUUID()}/versions/${randomUUID()}/pdf`], ["POST", `/tickets/${randomUUID()}/scans`], ["POST", "/login"]]) {
  const r = await get(path, { method, headers: { accept: "*/*", "next-action": "check" } });
  check(r.status === 401, `${method} ${path} is refused without early access`, String(r.status));
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
