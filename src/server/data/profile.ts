import "server-only";
import { cache } from "react";
import { createClient } from "@/server/supabase/server";

export interface MyProfile {
  userId: string;
  email: string;
  fullName: string;
  displayName: string;
  phone: string;
  photoUpdatedAt: string | null;
}

/**
 * The signed-in person's own editable profile, once per request. null when
 * signed out, or when the database does not have the self-service functions
 * yet (migration 20261030000100 not applied): the app then simply shows names
 * and initials as before.
 */
export const getMyProfile = cache(async (): Promise<MyProfile | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_profile");
  if (error || !data) return null;
  const p = data as { user_id: string; email: string; full_name: string; display_name: string; phone: string; photo_updated_at: string | null };
  return { userId: p.user_id, email: p.email, fullName: p.full_name, displayName: p.display_name, phone: p.phone, photoUpdatedAt: p.photo_updated_at };
});

/** Where a person's photo is served; the version busts the browser cache after a change. */
export const photoUrl = (userId: string, version: string | null) => (version ? `/people/photo/${userId}?v=${encodeURIComponent(version)}` : "");
