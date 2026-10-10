import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResendProvider, type OutgoingEmail } from "@/server/email/provider";

const email: OutgoingEmail = {
  to: ["customer@example.com"],
  cc: [],
  subject: "Quote Q-1",
  text: "Hello",
  attachments: [{ filename: "Q-1.pdf", content: Buffer.from("%PDF-test"), contentType: "application/pdf" }],
};

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ResendProvider", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("sends the PDF as a base64 attachment with an idempotency key", async () => {
    const { fn, calls } = fakeFetch([json(200, { id: "msg_123" })]);
    const result = await new ResendProvider("key", "Top Line <q@example.com>", fn).send(email, { idempotencyKey: "k1" });
    expect(result).toEqual({ ok: true, providerMessageId: "msg_123" });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.attachments[0]).toMatchObject({ filename: "Q-1.pdf", content: Buffer.from("%PDF-test").toString("base64") });
    expect((calls[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBe("k1");
  });

  it("reports a rejected message as a failure without retrying", async () => {
    const { fn, calls } = fakeFetch([json(422, { message: "Invalid `to` field" })]);
    const result = await new ResendProvider("key", "from@example.com", fn).send(email, { idempotencyKey: "k2" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("Invalid `to` field");
    expect(calls).toHaveLength(1);
  });

  it("retries once on a server error, reusing the same idempotency key", async () => {
    const { fn, calls } = fakeFetch([json(503, { message: "busy" }), json(200, { id: "msg_2" })]);
    const result = await new ResendProvider("key", "from@example.com", fn).send(email, { idempotencyKey: "k3" });
    expect(result).toEqual({ ok: true, providerMessageId: "msg_2" });
    expect(calls).toHaveLength(2);
    const keys = calls.map((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys).toEqual(["k3", "k3"]);
  });

  it("fails cleanly when the service is unreachable twice", async () => {
    const { fn } = fakeFetch([new Error("ECONNRESET"), new Error("ECONNRESET")]);
    const result = await new ResendProvider("key", "from@example.com", fn).send(email, { idempotencyKey: "k4" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/unreachable/);
  });
});

describe("email mode", () => {
  const base = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_ANON_KEY: "x".repeat(40) };
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
  });

  async function modeWith(vars: Record<string, string>) {
    process.env = { ...saved, ...base, ...vars };
    vi.resetModules();
    const mod = await import("@/server/email/provider");
    return mod.getEmailMode();
  }

  it("defaults to preview mode — nothing is sent", async () => {
    expect((await modeWith({ EMAIL_PROVIDER: "" })).mode).toBe("preview");
  });
  it("stays in preview when resend is selected but not fully configured", async () => {
    const m = await modeWith({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "", EMAIL_FROM: "" });
    expect(m.mode).toBe("preview");
  });
  it("uses test mode when a test recipient is set", async () => {
    const m = await modeWith({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x", EMAIL_FROM: "a@example.com", EMAIL_TEST_RECIPIENT: "inbox@example.com" });
    expect(m).toMatchObject({ mode: "test", testRecipient: "inbox@example.com" });
  });
  it("is live only when fully configured", async () => {
    const m = await modeWith({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x", EMAIL_FROM: "a@example.com", EMAIL_TEST_RECIPIENT: "" });
    expect(m.mode).toBe("live");
  });
});
