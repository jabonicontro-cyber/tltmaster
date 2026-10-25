import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { QBO_AUTHORIZE_URL, QBO_MINOR_VERSION, QBO_REVOKE_URL, QBO_SCOPE, QBO_TOKEN_URL, qboApiBase, qboLiteral } from "@/lib/accounting/qbo";
import { env } from "@/server/env";
import { createAdminClient } from "@/server/supabase/admin";

// QuickBooks Online connection (master plan B82): OAuth, encrypted token storage, token refresh and API calls.
// Tokens are encrypted here (AES-256-GCM, a key derived from the app's client secret and the connection id) and stored in
// accounting_connection_secrets, which no app user can read; only this server code reads it, through the service role,
// after the caller's permission has been checked. Tokens and secrets never reach the browser, errors or logs.

export interface QboTokens { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in?: number }

/** True when the owner has set the QuickBooks app's keys (and the service role the token store needs). */
export function qboConfigured(): boolean {
  const e = env();
  return Boolean(e.QBO_CLIENT_ID && e.QBO_CLIENT_SECRET && e.SUPABASE_SERVICE_ROLE_KEY);
}

export function qboRedirectUri() {
  return `${env().APP_BASE_URL}/api/accounting/qbo/callback`;
}

// Replaceable in tests; production uses the platform fetch.
let fetcher: typeof fetch = (...a) => fetch(...a);
export function setQboFetchForTests(f: typeof fetch) {
  fetcher = f;
}

function key(connectionId: string) {
  return Buffer.from(hkdfSync("sha256", env().QBO_CLIENT_SECRET ?? "", connectionId, "taviron-qbo-tokens-v1", 32));
}

export function encryptTokens(connectionId: string, tokens: QboTokens): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(connectionId), iv);
  const body = Buffer.concat([c.update(JSON.stringify(tokens), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decryptTokens(connectionId: string, sealed: string): QboTokens {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1") throw new Error("Unknown token format.");
  const d = createDecipheriv("aes-256-gcm", key(connectionId), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8")) as QboTokens;
}

export function authorizeUrl(state: string) {
  const u = new URL(QBO_AUTHORIZE_URL);
  u.searchParams.set("client_id", env().QBO_CLIENT_ID ?? "");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", QBO_SCOPE);
  u.searchParams.set("redirect_uri", qboRedirectUri());
  u.searchParams.set("state", state);
  return u.toString();
}

function basicAuth() {
  const e = env();
  return `Basic ${Buffer.from(`${e.QBO_CLIENT_ID}:${e.QBO_CLIENT_SECRET}`).toString("base64")}`;
}

/** A failure that needs the person to connect again (expired or revoked authorization). */
export class QboReconnectError extends Error {}

async function tokenRequest(body: Record<string, string>): Promise<QboTokens> {
  const res = await fetcher(QBO_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (res.status === 400 || res.status === 401) throw new QboReconnectError("QuickBooks no longer accepts this connection. Connect again.");
  if (!res.ok) throw new Error(`QuickBooks sign-in failed (${res.status}).`);
  return (await res.json()) as QboTokens;
}

export function exchangeCode(code: string) {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: qboRedirectUri() });
}

export async function saveTokens(connectionId: string, tokens: QboTokens) {
  const now = Date.now();
  const admin = createAdminClient();
  const { data: conn } = await admin.from("accounting_connections").select("company_id").eq("id", connectionId).maybeSingle();
  if (!conn) throw new Error("The QuickBooks connection could not be stored.");
  const { error } = await admin.from("accounting_connection_secrets").upsert({
    connection_id: connectionId,
    company_id: (conn as { company_id: string }).company_id,
    tokens_ciphertext: encryptTokens(connectionId, tokens),
    access_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
    refresh_expires_at: tokens.x_refresh_token_expires_in ? new Date(now + tokens.x_refresh_token_expires_in * 1000).toISOString() : null,
    updated_at: new Date(now).toISOString(),
  });
  if (error) throw new Error("The QuickBooks connection could not be stored.");
}

/** A valid access token for the connection, refreshed when it expires within two minutes. */
export async function accessToken(connectionId: string, force = false): Promise<string> {
  const { data } = await createAdminClient().from("accounting_connection_secrets").select("tokens_ciphertext, access_expires_at").eq("connection_id", connectionId).maybeSingle();
  const row = data as { tokens_ciphertext: string; access_expires_at: string } | null;
  if (!row) throw new QboReconnectError("QuickBooks is not connected.");
  const tokens = decryptTokens(connectionId, row.tokens_ciphertext);
  if (!force && Date.parse(row.access_expires_at) - Date.now() > 120_000) return tokens.access_token;
  const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  await saveTokens(connectionId, fresh);
  return fresh.access_token;
}

/** Revoke the authorization at Intuit (best effort) and forget the stored tokens. */
export async function revokeTokens(connectionId: string) {
  const admin = createAdminClient();
  const { data } = await admin.from("accounting_connection_secrets").select("tokens_ciphertext").eq("connection_id", connectionId).maybeSingle();
  if (data) {
    try {
      const t = decryptTokens(connectionId, (data as { tokens_ciphertext: string }).tokens_ciphertext);
      await fetcher(QBO_REVOKE_URL, { method: "POST", headers: { Authorization: basicAuth(), Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ token: t.refresh_token }) });
    } catch {
      // Revocation is best effort: the stored tokens are deleted either way.
    }
  }
  await admin.from("accounting_connection_secrets").delete().eq("connection_id", connectionId);
}

export interface QboContext { connectionId: string; realmId: string; environment: "sandbox" | "production" }

/** One QuickBooks API call; an expired access token is refreshed once. Errors carry QuickBooks' own message. */
export async function qboRequest<T>(ctx: QboContext, method: "GET" | "POST", path: string, body?: unknown, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${qboApiBase(ctx.environment)}/v3/company/${encodeURIComponent(ctx.realmId)}/${path}`);
  url.searchParams.set("minorversion", QBO_MINOR_VERSION);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(ctx.connectionId, attempt > 0);
    const res = await fetcher(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && attempt === 0) continue;
    const json = (await res.json().catch(() => ({}))) as { Fault?: { Error?: Array<{ Message?: string; Detail?: string }> } } & T;
    if (!res.ok || json.Fault) {
      const e = json.Fault?.Error?.[0];
      throw new Error(`QuickBooks: ${e?.Detail || e?.Message || `request failed (${res.status})`}`.slice(0, 900));
    }
    return json;
  }
  throw new QboReconnectError("QuickBooks no longer accepts this connection. Connect again.");
}

export async function qboQuery<T>(ctx: QboContext, query: string): Promise<T[]> {
  const r = await qboRequest<{ QueryResponse?: Record<string, T[]> }>(ctx, "GET", "query", undefined, { query });
  const first = Object.values(r.QueryResponse ?? {}).find(Array.isArray);
  return (first ?? []) as T[];
}

export async function companyName(ctx: QboContext): Promise<string> {
  const r = await qboRequest<{ CompanyInfo?: { CompanyName?: string } }>(ctx, "GET", `companyinfo/${encodeURIComponent(ctx.realmId)}`);
  return r.CompanyInfo?.CompanyName ?? "";
}

export async function listItems(ctx: QboContext) {
  return qboQuery<{ Id: string; Name: string; Type: string }>(ctx, "select Id, Name, Type from Item where Active = true and Type in ('Service', 'NonInventory') maxresults 200");
}

/** The QuickBooks customer with exactly this display name, or a new one. */
export async function findOrCreateCustomer(ctx: QboContext, displayName: string): Promise<{ id: string; name: string; created: boolean }> {
  const found = await qboQuery<{ Id: string; DisplayName: string }>(ctx, `select Id, DisplayName from Customer where DisplayName = ${qboLiteral(displayName)}`);
  if (found[0]) return { id: found[0].Id, name: found[0].DisplayName, created: false };
  const r = await qboRequest<{ Customer: { Id: string; DisplayName: string } }>(ctx, "POST", "customer", { DisplayName: displayName });
  return { id: r.Customer.Id, name: r.Customer.DisplayName, created: true };
}

export async function findInvoice(ctx: QboContext, docNumber: string, customerId: string) {
  const rows = await qboQuery<{ Id: string; DocNumber: string; TotalAmt: number; CustomerRef: { value: string } }>(ctx, `select Id, DocNumber, TotalAmt, CustomerRef from Invoice where DocNumber = ${qboLiteral(docNumber)}`);
  return rows.find((r) => r.CustomerRef?.value === customerId) ?? null;
}

/** Create the invoice. `requestId` makes a retried request return the same invoice instead of creating another. */
export async function createInvoice(ctx: QboContext, invoice: unknown, requestId: string) {
  const r = await qboRequest<{ Invoice: { Id: string; DocNumber: string; TotalAmt: number } }>(ctx, "POST", "invoice", invoice, { requestid: requestId });
  return r.Invoice;
}
