"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { parsePoint } from "@/lib/routing/route";
import { uuid } from "@/lib/schemas/common";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { routingStatus } from "@/server/routing/service";
import { createClient } from "@/server/supabase/server";

// Route planner actions (docs/ROUTING.md). Locations are ordinary record fields: a site's needs customers.edit and the
// yard needs settings.manage, both checked here and again by row-level security. Geocoding sends only the address
// text to the routing provider, never names or ids.

const MISSING_COLUMN = new Set(["42703", "PGRST204"]);

async function writeSite(siteId: string, lat: number, lng: number, source: "manual" | "here") {
  const supabase = await createClient();
  const full = await supabase.from("customer_sites").update({ latitude: lat, longitude: lng, location_source: source, located_at: new Date().toISOString() }).eq("id", siteId).select("id");
  // Before migration 20261112000500 the source columns do not exist: coordinates alone still save.
  if (full.error && MISSING_COLUMN.has(full.error.code ?? "")) {
    const basic = await supabase.from("customer_sites").update({ latitude: lat, longitude: lng }).eq("id", siteId).select("id");
    return basic;
  }
  return full;
}

const siteInput = z.object({ siteId: uuid, location: z.string().trim().max(60) });

/** A person types the site's coordinates ("41.0, -87.1"), e.g. copied from a map. Empty clears them. */
export async function setSiteLocation(input: z.input<typeof siteInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("customers.edit");
    const p = siteInput.safeParse(input);
    if (!p.success) return fail("Invalid site.");
    if (!p.data.location) {
      const supabase = await createClient();
      const r = await supabase.from("customer_sites").update({ latitude: null, longitude: null }).eq("id", p.data.siteId).select("id");
      if (r.error) return fail(dbErrorMessage(r.error));
      revalidatePath("/route-planner");
      return ok(undefined, "Location cleared.");
    }
    const point = parsePoint(p.data.location);
    if (!point) return fail("Enter latitude and longitude, for example 40.9367, -87.1509.");
    const r = await writeSite(p.data.siteId, point.lat, point.lng, "manual");
    if (r.error) return fail(dbErrorMessage(r.error));
    if (!r.data?.length) return fail("Site not found.");
    revalidatePath("/route-planner");
    return ok(undefined, "Location saved.");
  });
}

/** Looks the site's address up with the routing provider's geocoder (an estimate of the address, labelled as such). */
export async function locateSite(input: { siteId: string }): Promise<ActionResult> {
  return guard(async () => {
    const access = await assertPermission("customers.edit");
    const id = uuid.safeParse(input.siteId);
    if (!id.success) return fail("Invalid site.");
    const status = routingStatus(access);
    if (status.state !== "ready") return fail(status.reason);
    const supabase = await createClient();
    const { data: site, error } = await supabase.from("customer_sites").select("line1, line2, city, state, postal_code").eq("id", id.data).maybeSingle();
    if (error || !site) return fail("Site not found.");
    const s = site as { line1: string; line2: string | null; city: string | null; state: string | null; postal_code: string | null };
    const address = [s.line1, s.line2, s.city, s.state, s.postal_code].filter(Boolean).join(", ");
    let found;
    try {
      found = await status.provider.geocode(address);
    } catch (e) {
      return fail(e instanceof Error ? e.message : "The routing provider failed.");
    }
    if (!found) return fail("The address could not be found. Enter the coordinates instead.");
    const r = await writeSite(id.data, found.point.lat, found.point.lng, "here");
    if (r.error) return fail(dbErrorMessage(r.error));
    revalidatePath("/route-planner");
    return ok(undefined, "Location found from the address (an estimate: check it on a map if the site is large or new).");
  });
}

/** The yard: typed coordinates, or the company address looked up by the provider. Empty clears it. */
export async function setYardLocation(input: { location: string; fromAddress?: boolean }): Promise<ActionResult> {
  return guard(async () => {
    const access = await assertPermission("settings.manage");
    let point: { lat: number; lng: number } | null = null;
    const supabase = await createClient();
    if (input.fromAddress) {
      const status = routingStatus(access);
      if (status.state !== "ready") return fail(status.reason);
      const { data } = await supabase.from("company_settings").select("address_line1, address_line2, city, state, postal_code").maybeSingle();
      const s = (data ?? {}) as Record<string, string | null>;
      const address = [s.address_line1, s.address_line2, s.city, s.state, s.postal_code].filter(Boolean).join(", ");
      if (!address) return fail("The company has no address in Settings → Company.");
      try {
        point = (await status.provider.geocode(address))?.point ?? null;
      } catch (e) {
        return fail(e instanceof Error ? e.message : "The routing provider failed.");
      }
      if (!point) return fail("The company address could not be found. Enter the coordinates instead.");
    } else if (String(input.location ?? "").trim()) {
      point = parsePoint(String(input.location));
      if (!point) return fail("Enter latitude and longitude, for example 40.9367, -87.1509.");
    }
    const r = await supabase.from("company_settings").update({ yard_latitude: point?.lat ?? null, yard_longitude: point?.lng ?? null }).not("company_id", "is", null).select("company_id");
    if (r.error) return fail(MISSING_COLUMN.has(r.error.code ?? "") ? "The yard location needs a database update that has not been installed yet." : dbErrorMessage(r.error));
    revalidatePath("/route-planner");
    revalidatePath("/settings");
    return ok(undefined, point ? "Yard location saved." : "Yard location cleared.");
  });
}
