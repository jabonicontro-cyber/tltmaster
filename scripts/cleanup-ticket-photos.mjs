#!/usr/bin/env node
// Removes abandoned ticket-photo uploads: photos never attached to a ticket
// within --hours (default 24), and objects in the bucket without a record.
// Objects are removed through the Storage API (service role); the database
// then marks the records discarded only if the objects are really gone.
//
//   node scripts/cleanup-ticket-photos.mjs [--hours=24] [--dry-run]
//
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
// environment (never commit the key). Run daily from a trusted machine or job.
import { createClient } from "@supabase/supabase-js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const hours = Math.max(1, Number.parseInt(args.hours ?? "24", 10) || 24);
const dryRun = "dry-run" in args;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: rows, error } = await admin.rpc("abandoned_ticket_photos", { p_hours: hours });
if (error) {
  console.error(`Could not list abandoned photos: ${error.message}`);
  process.exit(1);
}
console.log(`${rows.length} abandoned object(s) older than ${hours} h${dryRun ? " (dry run)" : ""}.`);
if (dryRun || rows.length === 0) process.exit(0);

const paths = rows.map((r) => r.object_path);
for (let i = 0; i < paths.length; i += 100) {
  const { error: rmError } = await admin.storage.from("ticket-photos").remove(paths.slice(i, i + 100));
  if (rmError) {
    console.error(`Removing objects failed: ${rmError.message}. Nothing was marked discarded; run again.`);
    process.exit(1);
  }
}
const ids = rows.map((r) => r.attachment_id).filter(Boolean);
const { data: marked, error: markError } = await admin.rpc("mark_ticket_photos_discarded", { p_attachment_ids: ids });
if (markError) {
  console.error(`Objects removed, but marking records failed: ${markError.message}. Run again.`);
  process.exit(1);
}
console.log(`Removed ${paths.length} object(s); marked ${marked} record(s) discarded.`);
