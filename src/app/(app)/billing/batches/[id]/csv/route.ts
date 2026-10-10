import { NextResponse, type NextRequest } from "next/server";
import { handoffCsv } from "@/lib/billing/rules";
import { can } from "@/lib/permissions";
import { getAccess } from "@/server/auth";
import { getHandoffBatch } from "@/server/data/billing";
import { createClient } from "@/server/supabase/server";

export const runtime = "nodejs";

/**
 * The handoff file of a batch, built from the snapshots frozen at handoff, so
 * every download of the same batch has the same content (orders whose handoff
 * was undone are left out). Each download is counted and logged.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await getAccess();
  if (!access || !can(access, "billing.view")) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  }
  const { id } = await params;
  const loaded = await getHandoffBatch(id).catch(() => null);
  if (!loaded) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const csv = handoffCsv(
    loaded.batch,
    loaded.items.filter((i) => !i.reverted_at).map((i) => i.snapshot),
  );
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_billing_export", { p_handoff_id: loaded.batch.id });
  if (error) {
    console.error("Recording a billing export failed", { handoffId: id, error: error.message });
    return NextResponse.json({ error: "The download could not be recorded. Try again." }, { status: 500 });
  }
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="billing-handoff-${loaded.batch.batch_number}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
