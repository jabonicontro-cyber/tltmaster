import { expect, test } from "@playwright/test";

// Uptime check (LR4): open to monitors without a sign-in or the early-access password, answers whether the app and its
// database respond, and returns no data.
test("the health check answers without signing in and reveals nothing", async ({ request }) => {
  const r = await request.get("/api/health", { maxRedirects: 0 });
  expect(r.status()).toBe(200);
  expect(r.headers()["cache-control"]).toContain("no-store");
  const body = await r.json();
  expect(body).toMatchObject({ ok: true, app: "ok", sign_in: "ok", database: "ok" });
  expect(Object.keys(body).sort()).toEqual(["app", "checked_at", "database", "ok", "sign_in"]);
});
