import { NextResponse, type NextRequest } from "next/server";
import { checkPhoto } from "@/lib/files/images";
import { uuid } from "@/lib/schemas/common";
import { getAccess } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * One photo for a work order (UX9). Either `work_order` (the shop: maintenance.manage, open work orders) or `inspection`
 * (the driver who just reported the defect, that day). The database, with the person's own session, checks who may add
 * it, type, size and the limit of 8, and reserves the path; only then does the service-role client store the file at
 * exactly that path in the private maintenance-photos bucket.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return reply(403, { error: "Not permitted." });
  const access = await getAccess();
  if (!access?.active || !access.companyId) return reply(401, { error: "Sign in again." });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: "The upload was incomplete. Try again." });
  }
  const file = form.get("file");
  const workOrder = String(form.get("work_order") ?? "");
  const inspection = String(form.get("inspection") ?? "");
  const byWorkOrder = uuid.safeParse(workOrder).success;
  if (!(file instanceof File) || (!byWorkOrder && !uuid.safeParse(inspection).success)) return reply(400, { error: "Invalid upload." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkPhoto(bytes, file.type);
  if (!check.ok) return reply(check.status, { error: check.error });

  const db = await createClient();
  const begin = byWorkOrder
    ? await db.rpc("work_order_photo_begin", { p_wo: workOrder, p_mime: check.type, p_size: bytes.length })
    : await db.rpc("inspection_photo_begin", { p_inspection: inspection, p_mime: check.type, p_size: bytes.length });
  if (begin.error) return reply(begin.error.code === "42501" ? 403 : 400, { error: dbErrorMessage(begin.error) });
  if (!adminAvailable()) return reply(503, { error: "Photos cannot be stored right now. The work order was saved without them." });
  const up = await createAdminClient().storage.from("maintenance-photos").upload(begin.data as string, bytes, { contentType: check.type, upsert: false, cacheControl: "private, max-age=0" });
  if (up.error) {
    console.error("Maintenance photo upload failed", { error: up.error.message });
    return reply(502, { error: "The photo could not be stored. The work order was saved without it." });
  }
  return reply(200, { ok: true });
}
