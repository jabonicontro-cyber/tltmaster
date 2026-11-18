import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32, inflateRawSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { closeDemoWelcomeIfShown, unique } from "./helpers";
import { totp } from "./mfa";
import { PREVIEW_COOKIE } from "@/lib/platform/preview";

// Download all your data (owner 2026-11-17, master plan §12 EX1), end to end in a throwaway demo company (fictional
// records): the owner without two-step sees what to do first and the download is refused; once verified, the page shows
// the counts, and the spreadsheets and files zips download, read back, hold only this company's records with formulas
// neutralised, and each download is in the audit log. Another role's preview never sees the section or the download.

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

/** The files of a zip, read through its central directory (checksums checked). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(crc32(data) >>> 0, name).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen;
  }
  return out;
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function demoWithRecords() {
  const tag = unique();
  const company = (await sql<{ id: string }>("select private.create_company($1, $2) as id", [`Export Demo ${tag}`, `prospect-export${tag}`]))[0].id;
  await sql("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [company]);
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const email = `e2e-export-${tag}@demotest.example`;
  const password = `Pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Export Owner" } });
  if (error) throw error;
  await sql("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'owner', true)", [company, data.user.id]);
  await sql("update public.profiles set active_company_id = $1 where id = $2", [company, data.user.id]);
  // Fictional records: a customer whose name a spreadsheet would run as a formula, an order, and a stored document.
  const customer = (await sql<{ id: string }>("insert into public.customers (company_id, name) values ($1, '=HYPERLINK(\"https://example.com\")') returning id", [company]))[0].id;
  await sql("insert into public.customers (company_id, name) values ($1, 'Maple Row Gardens (demo)')", [company]);
  const order = (await sql<{ id: string }>("insert into public.orders (company_id, customer_id, order_number, order_date) values ($1, $2, $3, current_date) returning id", [company, customer, `EXP-${tag}`]))[0].id;
  const doc = randomUUID();
  const path = `${company}/orders/${doc}.pdf`;
  const up = await admin.storage.from("order-documents").upload(path, PDF, { contentType: "application/pdf" });
  if (up.error) throw up.error;
  await sql("insert into public.order_documents (id, company_id, order_id, kind, object_path, file_name, mime_type, size_bytes) values ($1, $2, $3, 'bill_of_lading', $4, 'bol-signed.pdf', 'application/pdf', $5)", [doc, company, order, path, PDF.length]);
  return { company, email, password, userId: data.user.id };
}

/** Set up an authenticator for the account the way the app's own setup does (code and saved recovery codes). */
async function enrollAuthenticator(email: string, password: string): Promise<string> {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password });
  if (sErr) throw sErr;
  const { data: f, error: fErr } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "e2e" });
  if (fErr || !f) throw new Error(`enroll: ${fErr?.message}`);
  const { error: vErr } = await client.auth.mfa.challengeAndVerify({ factorId: f.id, code: totp(f.totp.secret) });
  if (vErr) throw vErr;
  await client.rpc("mfa_recovery_generate");
  await client.rpc("mfa_recovery_confirm");
  return f.totp.secret;
}

async function signInDemo(page: Page, email: string, password: string, secret?: string) {
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  if (secret) {
    await page.waitForURL((u) => u.pathname === "/mfa");
    await page.getByLabel("6-digit code").fill(totp(secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await page.waitForURL((u) => u.pathname !== "/mfa");
  }
  await closeDemoWelcomeIfShown(page);
}

test("a demo company's owner downloads all its data after two-step verification; nobody else can", async ({ browser }) => {
  test.setTimeout(240_000);
  const demo = await demoWithRecords();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  try {
    // Without two-step: the section says what to do first, and the download itself is refused.
    await signInDemo(page, demo.email, demo.password);
    await page.goto("/settings?tab=export");
    await expect(page.getByRole("heading", { name: "Download all your data" })).toBeVisible();
    await expect(page.getByText("Confirm two-step verification first")).toBeVisible();
    await expect(page.getByRole("link", { name: /Download spreadsheets/ })).toHaveCount(0);
    expect((await page.request.get("/settings/export?part=spreadsheets", { maxRedirects: 0 })).status()).toBe(403);

    // With two-step.
    const secret = await enrollAuthenticator(demo.email, demo.password);
    await ctx.clearCookies();
    await signInDemo(page, demo.email, demo.password, secret);
    await page.goto("/settings?tab=export");
    await expect(page.getByText("This is a demo company: the download holds its fictional sample records.")).toBeVisible();
    await expect(page.getByText(/^1 file, in one download\./)).toBeVisible();

    const [sheets] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download spreadsheets (.zip)" }).click()]);
    expect(sheets.suggestedFilename()).toMatch(/^export-demo-[a-z0-9]+-data-\d{4}-\d{2}-\d{2}\.zip$/);
    const zip = unzip(readFileSync((await sheets.path())!));
    const names = [...zip.keys()].map((n) => n.split("/").slice(1).join("/"));
    expect(names).toContain("README.txt");
    expect(names).toContain("customers.csv");
    expect(names).toContain("orders.csv");
    expect(names).toContain("people.csv");
    expect(names).not.toContain("NOT-COMPLETE.txt");
    const customers = [...zip.entries()].find(([n]) => n.endsWith("/customers.csv"))![1].toString("utf8");
    expect(customers.split("\r\n")[0]).toMatch(/^id,customer_number,name,/);
    expect(customers).toContain("\"'=HYPERLINK(\"\"https://example.com\"\")\"");
    expect(customers).toContain("Maple Row Gardens (demo)");
    expect(customers).not.toContain("Prairie View Landscaping"); // Top Line's sample customer: another company
    const rows = customers.trim().split("\r\n").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.includes(demo.company))).toBe(true);

    const [files] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download photos and documents (.zip)" }).click()]);
    const fz = unzip(readFileSync((await files.path())!));
    const pdf = [...fz.entries()].find(([n]) => /\/order-documents\/bol-signed-[0-9a-f]{8}\.pdf$/.test(n));
    expect(pdf?.[1].equals(PDF)).toBe(true);
    const index = [...fz.entries()].find(([n]) => n.endsWith("/files.csv"))![1].toString("utf8");
    expect(index).toContain("Order document (bill of lading)");
    expect(index).toContain("Included");

    // Recorded: who and which part, never contents.
    const audit = await sql<{ actor_id: string; details: { part: string } }>("select actor_id, details from public.audit_events where company_id = $1 and action = 'data_exported' order by occurred_at", [demo.company]);
    expect(audit).toEqual([{ actor_id: demo.userId, details: { part: "spreadsheets" } }, { actor_id: demo.userId, details: { part: "files-1" } }]);

    // A role preview (Dispatcher): no section in the menu, and the download is refused.
    await ctx.addCookies([{ name: PREVIEW_COOKIE, value: "dispatcher", url: new URL("/", page.url()).href }]);
    await page.goto("/settings?tab=export");
    await expect(page.getByRole("heading", { name: "Download all your data" })).toHaveCount(0);
    expect((await page.request.get("/settings/export?part=spreadsheets", { maxRedirects: 0 })).status()).toBe(403);
  } finally {
    await ctx.close();
    await sql("update public.companies set active = false where id = $1", [demo.company]);
  }
});
