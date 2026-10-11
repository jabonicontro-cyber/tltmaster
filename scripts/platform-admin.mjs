#!/usr/bin/env node
// Platform owner (the Taviron team) — operator only. This is the ONLY way to
// grant or revoke the platform role: there is no page or public route for it.
// The person must already have a Taviron login (e.g. created with
// scripts/create-owner.mjs, or an invitation). Requires NEXT_PUBLIC_SUPABASE_URL
// and SUPABASE_SERVICE_ROLE_KEY (server-side secret: run from a trusted machine,
// never commit it). Every grant and revoke is recorded in the platform audit log.
//
//   node --env-file=.env.staging scripts/platform-admin.mjs grant you@example.com --note "Founder"
//   node --env-file=.env.staging scripts/platform-admin.mjs revoke someone@example.com --note "Left the team"
//   node --env-file=.env.staging scripts/platform-admin.mjs list
import { createClient } from "@supabase/supabase-js";

const [cmd, ...rest] = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) opts[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? true : rest[++i];
  else positional.push(rest[i]);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (e.g. node --env-file=.env.staging ...).");
  process.exit(1);
}
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

if (cmd === "grant" || cmd === "revoke") {
  const email = positional[0];
  if (!email || !email.includes("@")) {
    console.error(`Usage: platform-admin.mjs ${cmd} <email> --note "why"`);
    process.exit(1);
  }
  const { data, error } = await db.rpc(cmd === "grant" ? "platform_admin_grant" : "platform_admin_revoke", { p_email: email, p_note: typeof opts.note === "string" ? opts.note : "" });
  if (error) {
    console.error(`Failed: ${error.message}`);
    process.exit(1);
  }
  if (!data.ok) {
    console.error(data.reason === "no_account" ? `No Taviron login exists for ${email}. Create it first (scripts/create-owner.mjs or an invitation).` : `${email} is not a platform admin.`);
    process.exit(1);
  }
  console.log(cmd === "grant" ? `${email} is now a platform admin. They sign in normally and open /admin.` : `${email} is no longer a platform admin.`);
} else if (cmd === "list") {
  const { data, error } = await db.rpc("platform_admin_list");
  if (error) {
    console.error(`Failed: ${error.message}`);
    process.exit(1);
  }
  if (!data.length) console.log("No platform admins.");
  for (const a of data) console.log(`${a.revoked_at ? "revoked" : "active "}  ${a.email}  ${a.full_name ?? ""}  granted ${a.granted_at.slice(0, 10)}${a.note ? `  (${a.note})` : ""}`);
} else {
  console.error("Commands: grant <email> --note, revoke <email> --note, list");
  process.exit(1);
}
