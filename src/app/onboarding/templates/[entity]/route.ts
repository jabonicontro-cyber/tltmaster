import { NextResponse, type NextRequest } from "next/server";
import { IMPORT_ENTITIES, templateCsv, type ImportEntity } from "@/lib/platform/imports";
import { getAccess } from "@/server/auth";
import { isPlatformAdmin } from "@/server/platform";

/**
 * Import templates for the Onboarding kit: the CSV header the importer recognizes (src/lib/platform/imports.ts).
 * For people who manage their company's settings, and Taviron. No company data is included.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ entity: string }> }) {
  const { entity } = await params;
  if (!(IMPORT_ENTITIES as readonly string[]).includes(entity)) return new NextResponse("Not found.", { status: 404 });
  const access = await getAccess();
  const allowed = (access?.permissions.includes("settings.manage") && access.companyId) || (await isPlatformAdmin());
  if (!allowed) return new NextResponse("Not permitted.", { status: 403 });
  return new NextResponse(templateCsv(entity as ImportEntity), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="taviron-${entity}-template.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
