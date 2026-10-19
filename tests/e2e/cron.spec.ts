import { expect, test } from "@playwright/test";

// The scheduled Communications cleanup (/api/cron/comm-housekeeping) runs only for a request carrying
// CRON_SECRET. Without the variable it refuses everything; with it, a missing or wrong secret is refused.
// Never 200 here: the test server does not get the real secret.
test("the scheduled cleanup refuses requests without the right secret", async ({ request }) => {
  const attempts: Array<Record<string, string>> = [{}, { authorization: "Bearer not-the-secret-value-123" }, { authorization: "Basic abc" }];
  for (const headers of attempts) {
    const r = await request.get("/api/cron/comm-housekeeping", { headers });
    expect([401, 503], JSON.stringify(headers)).toContain(r.status());
    const body = await r.text();
    expect(body).not.toMatch(/"companies"|expired_messages|filesRemoved/); // no work done, nothing reported
  }
});

// Scheduled go-live (/api/cron/lifecycle-activation, 20261118000300): the same CRON_SECRET rule.
test("scheduled go-live refuses requests without the right secret", async ({ request }) => {
  for (const headers of [{}, { authorization: "Bearer not-the-secret-value-123" }] as Array<Record<string, string>>) {
    const r = await request.get("/api/cron/lifecycle-activation", { headers });
    expect([401, 503], JSON.stringify(headers)).toContain(r.status());
    expect(await r.text()).not.toMatch(/activated/);
  }
});
