import "server-only";
import { avatarUrl, employeePhotoSrc } from "@/lib/people/avatars";
import { photoVersions } from "@/server/data/employees";
import { createClient } from "@/server/supabase/server";

// Faces next to names (redesign, master plan B90): on Schedule, Dispatch and elsewhere a small picture helps people
// in larger companies put a face to a name. The picture is the person's own profile photo, else the illustrated avatar
// on their employee record, else initials (the Avatar component). Read as the viewer: a role that cannot see the
// people directory gets no pictures (initials only), never more than it may read.

export interface Face {
  src: string;
  fallbackSrc: string;
}

type Row = { id: string; driver_id: string | null; user_id: string | null; avatar_key: string | null };

async function load(column: "id" | "driver_id" | "user_id", ids: Array<string | null | undefined>): Promise<Record<string, Face>> {
  const wanted = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (!wanted.length) return {};
  const supabase = await createClient();
  const { data, error } = await supabase.from("employees").select("id, driver_id, user_id, avatar_key").in(column, wanted);
  if (error) return {};
  const rows = (data ?? []) as Row[];
  const versions = await photoVersions(rows.map((r) => r.user_id));
  const out: Record<string, Face> = {};
  for (const r of rows) {
    const key = column === "id" ? r.id : column === "driver_id" ? r.driver_id : r.user_id;
    if (key) out[key] = { src: employeePhotoSrc(r.user_id, versions), fallbackSrc: avatarUrl(r.avatar_key) };
  }
  return out;
}

/** Faces by employee id. */
export const facesForEmployees = (employeeIds: Array<string | null | undefined>) => load("id", employeeIds);

/** Faces by driver id (the employee record linked to each driver). */
export const facesForDrivers = (driverIds: Array<string | null | undefined>) => load("driver_id", driverIds);

/** Faces by login (user id): their profile photo, else their employee record's illustrated avatar. */
export async function facesForUsers(userIds: Array<string | null | undefined>): Promise<Record<string, Face>> {
  const out = await load("user_id", userIds);
  // A login without an employee record can still have its own profile photo.
  const missing = [...new Set(userIds.filter((v): v is string => Boolean(v) && !out[v!]))];
  if (missing.length) {
    const versions = await photoVersions(missing);
    for (const id of missing) out[id] = { src: employeePhotoSrc(id, versions), fallbackSrc: "" };
  }
  return out;
}
