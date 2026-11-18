import { NextResponse, type NextRequest } from "next/server";
import { exportFolder, parsePart } from "@/lib/data-export";
import { getAccess } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { exportSummary, filesZip, spreadsheetsZip } from "@/server/data-export";
import { toStream } from "@/server/data-export/zip";
import { mfaBlock, mfaState } from "@/server/mfa";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";
// A big company's spreadsheets or a part of 200 photos can take a few minutes to stream.
export const maxDuration = 300;

const refuse = (status: number, message: string) =>
  new NextResponse(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/**
 * Download all your data (owner 2026-11-17; master plan §12 EX1): ?part=spreadsheets or ?part=files-N. Only the
 * company's owner (not settings.manage, not a support visit, not a role preview other than Owner), in a two-step
 * verified session. The database checks the same again (data_export_*, 20261120024500) and records each download in
 * the company's audit log before anything is sent.
 */
export async function GET(req: NextRequest) {
  const part = parsePart(req.nextUrl.searchParams.get("part"));
  if (!part) return refuse(400, "Choose what to download.");
  const access = await getAccess();
  if (!access?.companyId || !access.active) return refuse(401, "Sign in again.");
  if (access.role !== "owner" || access.support) return refuse(403, "Only the company's owner can download all its data.");
  const mfa = await mfaState();
  if (mfa.aal !== "aal2" || (await mfaBlock())) return refuse(403, "Confirm your two-step verification code first, then download your data.");

  const db = await createClient();
  const recorded = await db.rpc("data_export_record", { p_part: part.kind === "spreadsheets" ? "spreadsheets" : `files-${part.n}` });
  if (recorded.error) {
    if (recorded.error.code === "PGRST202" || recorded.error.code === "42883") return refuse(404, "Downloading your data needs a database update that has not been installed yet.");
    return refuse(403, recorded.error.code === "42501" ? recorded.error.message : "Your data cannot be downloaded right now. Try again in a minute.");
  }
  const { today } = await businessToday();
  const company = access.companyName ?? "company";
  const folder = exportFolder(company, today);
  const headers = (name: string) => ({
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${name}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (part.kind === "spreadsheets") {
    const summary = await exportSummary(db);
    return new Response(toStream(spreadsheetsZip(db, company, today, summary.ok ? summary.data.counts : null)), { headers: headers(`${folder}.zip`) });
  }
  const admin = adminAvailable() ? createAdminClient() : null;
  return new Response(toStream(filesZip(db, admin, access.companyId, company, today, part.n)), { headers: headers(`${folder}-files-${part.n}.zip`) });
}
