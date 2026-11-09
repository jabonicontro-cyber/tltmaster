import "server-only";
import { driverNoticeText } from "@/lib/dispatch/notify";
import { createClient } from "@/server/supabase/server";

/**
 * How the drivers of new assignments are told, in plain words (src/lib/dispatch/notify.ts): on My Day with a sign-in,
 * otherwise the dispatcher calls them. Empty when the drivers could not be read (the assignment itself stands).
 */
export async function driverNotice(driverIds: string[]): Promise<string> {
  if (!driverIds.length) return "";
  const supabase = await createClient();
  const { data, error } = await supabase.from("driver_list").select("id, display_name, user_id, account_active").in("id", [...new Set(driverIds)]);
  if (error || !data) return "";
  const byId = new Map((data as Array<{ id: string; display_name: string; user_id: string | null; account_active: boolean | null }>).map((d) => [d.id, d]));
  const drivers = driverIds.flatMap((id) => { const d = byId.get(id); return d ? [{ name: d.display_name, hasSignIn: Boolean(d.user_id) && d.account_active !== false }] : []; });
  return drivers.length ? driverNoticeText(drivers) : "";
}
