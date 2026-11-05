// Server error reporting to Sentry without the SDK (LR4, owner 2026-11-05: Sentry free tier). Off unless SENTRY_DSN is
// set (server-only; never NEXT_PUBLIC_). Pure helpers: parse the DSN and build one event envelope with nothing private
// in it: no headers, cookies, query strings, user ids or emails; email addresses and long numbers in messages are masked.

export interface SentryDsn { host: string; projectId: string; publicKey: string; protocol: "https" | "http" }

/** "https://<key>@o123.ingest.sentry.io/456" → its parts, or null when it isn't a DSN. */
export function parseDsn(dsn: string | undefined | null): SentryDsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn.trim());
    const projectId = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!u.username || !/^\d+$/.test(projectId) || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
    return { host: u.host, projectId, publicKey: u.username, protocol: u.protocol === "https:" ? "https" : "http" };
  } catch {
    return null;
  }
}

export const envelopeUrl = (d: SentryDsn) => `${d.protocol}://${d.host}/api/${d.projectId}/envelope/`;
export const authHeader = (d: SentryDsn) => `Sentry sentry_version=7, sentry_key=${d.publicKey}, sentry_client=taviron/1.0`;

/** Email addresses, phone-like and other long digit runs, and bearer tokens never leave the server. */
export function scrub(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(bearer|token|key|secret|password)([=:\s]+)\S+/gi, "$1$2[redacted]")
    .replace(/\d{7,}/g, "[number]")
    .slice(0, 2000);
}

export interface ReportInput {
  error: unknown;
  path: string;
  method: string;
  route?: string;
  routeType?: string;
  environment?: string;
  release?: string;
  now?: Date;
  eventId?: string;
}

/** One Sentry envelope (header, item header, event) for a server error. */
export function buildEnvelope(d: SentryDsn, input: ReportInput): string {
  const err = input.error;
  const type = err instanceof Error ? err.name || "Error" : "Error";
  const message = scrub(err instanceof Error ? err.message : String(err));
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : undefined;
  const stack = err instanceof Error && err.stack ? scrub(err.stack).slice(0, 2000) : undefined;
  const now = input.now ?? new Date();
  const eventId = input.eventId ?? crypto.randomUUID().replace(/-/g, "");
  const path = input.path.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
  const event = {
    event_id: eventId,
    timestamp: now.getTime() / 1000,
    platform: "node",
    level: "error",
    environment: input.environment ?? "development",
    ...(input.release ? { release: input.release } : {}),
    exception: { values: [{ type, value: message }] },
    tags: { route: input.route ?? path, route_type: input.routeType ?? "", method: input.method, ...(digest ? { digest } : {}) },
    request: { url: path, method: input.method },
    ...(stack ? { extra: { stack } } : {}),
  };
  return [JSON.stringify({ event_id: eventId, sent_at: now.toISOString() }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
}

/** Sends one report; never throws (monitoring must not break a request). Returns whether Sentry accepted it. */
export async function reportServerError(input: ReportInput, dsn = process.env.SENTRY_DSN): Promise<boolean> {
  const d = parseDsn(dsn);
  if (!d) return false;
  try {
    const r = await fetch(envelopeUrl(d), {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": authHeader(d) },
      body: buildEnvelope(d, { environment: process.env.VERCEL_ENV, release: process.env.VERCEL_GIT_COMMIT_SHA, ...input }),
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
