import "server-only";
import type { UserRow } from "@/components/settings/settings-client";
import { displayLogin } from "@/lib/usernames";
import { photoUrl } from "@/server/data/profile";
import { createClient } from "@/server/supabase/server";

/** The company's sign-ins with role and state (readable with users.manage; empty otherwise, by RLS). */
export async function listSignIns(companyId: string): Promise<UserRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("company_memberships")
    .select("user_id, role, active, created_at, profiles(email, full_name)")
    .eq("company_id", companyId)
    .order("created_at");
  const users: UserRow[] = ((data ?? []) as unknown as Array<{ user_id: string; role: UserRow["role"]; active: boolean; created_at: string; profiles: { email: string; full_name: string } | null }>).map((m) => ({
    id: m.user_id,
    email: displayLogin(m.profiles?.email ?? ""),
    full_name: m.profiles?.full_name ?? "",
    role: m.role,
    active: m.active,
    created_at: m.created_at,
    photo: "",
    phone: "",
  }));
  // Photos and phone numbers people set themselves (migration 20261030000100). Read
  // separately so the list still works on a database without those columns.
  if (users.length) {
    const { data: extras } = await supabase.from("profiles").select("id, phone, photo_updated_at").in("id", users.map((u) => u.id));
    for (const e of (extras ?? []) as Array<{ id: string; phone: string; photo_updated_at: string | null }>) {
      const u = users.find((x) => x.id === e.id);
      if (u) {
        u.photo = photoUrl(e.id, e.photo_updated_at);
        u.phone = e.phone;
      }
    }
  }
  return users;
}
