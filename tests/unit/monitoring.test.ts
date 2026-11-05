import { describe, expect, it } from "vitest";
import { authHeader, buildEnvelope, envelopeUrl, parseDsn, reportServerError, scrub } from "@/lib/monitoring/sentry";

const DSN = "https://abc123@o42.ingest.us.sentry.io/4507";

describe("Sentry reporting without the SDK (LR4)", () => {
  it("parses a DSN and refuses anything else", () => {
    const d = parseDsn(DSN)!;
    expect(d).toEqual({ host: "o42.ingest.us.sentry.io", projectId: "4507", publicKey: "abc123", protocol: "https" });
    expect(envelopeUrl(d)).toBe("https://o42.ingest.us.sentry.io/api/4507/envelope/");
    expect(authHeader(d)).toContain("sentry_key=abc123");
    for (const bad of [undefined, "", "not a url", "https://o42.ingest.sentry.io/4507", "https://k@host/abc", "ftp://k@host/1"]) expect(parseDsn(bad)).toBeNull();
  });
  it("masks emails, long numbers and secrets", () => {
    expect(scrub("user dana@example.com failed")).toBe("user [email] failed");
    expect(scrub("phone 2195551234 ticket 12345678")).toBe("phone [number] ticket [number]");
    expect(scrub("Bearer abc.def password=hunter2")).toBe("Bearer [redacted] password=[redacted]");
  });
  it("builds an envelope with no query string, ids, headers or cookies", () => {
    const err = Object.assign(new Error("Could not load order for owen@cobalt.example"), { digest: "999" });
    const env = buildEnvelope(parseDsn(DSN)!, { error: err, path: "/orders/0f2b070e-497e-4aff-95d0-334b30d22297?q=secret", method: "GET", route: "/orders/[id]", routeType: "render", now: new Date("2026-11-05T12:00:00Z"), eventId: "e".repeat(32) });
    const [head, item, body] = env.split("\n").map((l) => JSON.parse(l));
    expect(head).toEqual({ event_id: "e".repeat(32), sent_at: "2026-11-05T12:00:00.000Z" });
    expect(item).toEqual({ type: "event" });
    expect(body.exception.values[0]).toEqual({ type: "Error", value: "Could not load order for [email]" });
    expect(body.request).toEqual({ url: "/orders/:id", method: "GET" });
    expect(body.tags).toMatchObject({ route: "/orders/[id]", route_type: "render", digest: "999" });
    expect(env).not.toMatch(/secret|cookie|owen@/);
  });
  it("sends nothing without a DSN", async () => {
    expect(await reportServerError({ error: new Error("x"), path: "/", method: "GET" }, undefined)).toBe(false);
  });
});
