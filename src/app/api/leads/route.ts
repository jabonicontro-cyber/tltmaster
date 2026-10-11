import { fieldErrors, leadSchema, looksAutomated } from "@/lib/site/lead";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { rateKey } from "@/server/early-access";

// The public demo-request and contact form. The only public endpoint that
// accepts data: it validates, drops automated submissions silently, and hands
// the lead to the database (service role), which validates again, rate limits
// per address and merges repeats. It never reveals whether a lead existed.
// Works with fetch (JSON) and with a plain HTML form post (no JavaScript).

const MAX_BYTES = 32_000;
const SAVED = "Thank you. Your message reached the Taviron team.";

type Result = { ok: true; message: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Older browsers and same-origin form posts may omit it.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function clientIp(request: Request): string {
  return (request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "local").trim();
}

async function readBody(request: Request): Promise<{ json: boolean; data: Record<string, unknown> } | null> {
  const type = request.headers.get("content-type") ?? "";
  const raw = await request.text();
  if (raw.length > MAX_BYTES) return null;
  if (type.includes("application/json")) {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? { json: true, data: v } : null;
    } catch {
      return null;
    }
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    return { json: false, data: Object.fromEntries(new URLSearchParams(raw)) };
  }
  return null;
}

function respond(json: boolean, result: Result, status: number, back: string): Response {
  if (json) return Response.json(result, { status, headers: { "cache-control": "no-store" } });
  // Without JavaScript: back to the form page with the outcome.
  const q = result.ok ? "sent=1" : `error=${encodeURIComponent(result.error)}`;
  return new Response(null, { status: 303, headers: { location: `${back}?${q}`, "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ ok: false, error: "Not allowed." }, { status: 403 });
  const body = await readBody(request);
  if (!body) return Response.json({ ok: false, error: "The form could not be read." }, { status: 400 });
  const back = body.data.kind === "demo" ? "/demo" : "/contact";

  // The page measures how long the form took to fill (JSON posts must say);
  // a plain form post without JavaScript is checked by the hidden field only.
  const elapsed = body.json ? Number(body.data.elapsed_ms ?? 0) : undefined;
  if (looksAutomated({ website: body.data.website, elapsed_ms: elapsed, message: body.data.message })) {
    return respond(body.json, { ok: true, message: SAVED }, 200, back);
  }

  const parsed = leadSchema.safeParse({
    kind: body.data.kind,
    name: body.data.name ?? "",
    email: body.data.email ?? "",
    company_name: body.data.company_name ?? "",
    phone: body.data.phone ?? "",
    role_title: body.data.role_title ?? "",
    fleet_size: body.data.fleet_size ?? "",
    message: body.data.message ?? "",
    source_path: body.data.source_path ?? back,
  });
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error);
    return respond(body.json, { ok: false, error: Object.values(errors)[0] ?? "Check the form.", fieldErrors: errors }, 422, back);
  }

  if (!adminAvailable()) {
    return respond(body.json, { ok: false, error: "The form is not available right now. Please try again later." }, 503, back);
  }
  try {
    const { data, error } = await createAdminClient().rpc("lead_submit", { p_lead: parsed.data, p_ip_hash: rateKey(clientIp(request)) });
    if (error) throw error;
    const r = data as { ok: boolean; reason?: string };
    if (r.ok) return respond(body.json, { ok: true, message: SAVED }, 200, back);
    if (r.reason === "rate_limited") {
      return respond(body.json, { ok: false, error: "Too many messages from this network. Please wait 15 minutes and try again." }, 429, back);
    }
    return respond(body.json, { ok: false, error: "Check the form and try again." }, 422, back);
  } catch (e) {
    console.error("Lead could not be saved", e instanceof Error ? e.message : e);
    return respond(body.json, { ok: false, error: "Your message could not be saved. Please try again later." }, 500, back);
  }
}
