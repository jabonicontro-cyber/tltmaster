#!/usr/bin/env node
// Early-access codes (operator only). Codes are shown once and stored only as
// SHA-256 hashes. Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// (server-side secret: run from a trusted machine, never commit it).
//
// Two purposes (a code of one is never accepted for the other):
//   company — create one company at /signup (default; consumed per sign-up)
//   site    — admit a device past the Early Access page to sign-in; grants
//             nothing else (no account, company or permission). --uses = devices.
//
//   node --env-file=.env.local scripts/early-access.mjs create --label "Ridgeway Aggregates" [--uses 1] [--days 14]
//   node --env-file=.env.local scripts/early-access.mjs create --purpose site --label "Pilot testers" --uses 25 --days 30
//   node --env-file=.env.local scripts/early-access.mjs list
//   node --env-file=.env.local scripts/early-access.mjs revoke <code-id> --reason "Sent to the wrong person"
//   node --env-file=.env.local scripts/early-access.mjs revoke-devices <code-id> --reason "Shared too widely"
//
// Rotating a site code: create a new one, send it, then revoke the old one
// (its devices lose access within minutes).
//
// The shared Early Access password (EARLY_ACCESS_PASSWORD in the server
// environment, docs/DEPLOYMENT.md §3b) appears in `list` as "shared". Its
// devices can be signed out with revoke-devices; revoke stops that password
// until it is changed. It cannot be created here: it is set in the environment.
import { createHash, randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// Must match src/lib/early-access.ts (tests/unit/early-access.test.ts checks it).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const normalize = (input) => {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  const body = s.startsWith("TLT") ? s.slice(3) : s;
  return "TLT" + body.replace(/O/g, "0").replace(/[IL]/g, "1");
};
export const hashCode = (s) => createHash("sha256").update(normalize(s)).digest("hex");
const generate = () => {
  const raw = Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `TLT-${raw.match(/.{1,5}/g).join("-")}`;
};

const [cmd, ...rest] = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) opts[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? true : rest[++i];
  else positional.push(rest[i]);
}

if (cmd === "hash") {
  // For tests and support: the hash of a code (the code itself is not stored).
  console.log(hashCode(positional[0] ?? ""));
  process.exit(0);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

if (cmd === "create") {
  const label = typeof opts.label === "string" ? opts.label : "";
  const uses = Number.parseInt(opts.uses ?? "1", 10);
  const days = Number.parseInt(opts.days ?? "14", 10);
  const purpose = opts.purpose === "site" ? "site_access" : opts.purpose === undefined || opts.purpose === "company" ? "company_signup" : null;
  if (!label || !purpose || !(uses >= 1 && uses <= 1000) || !(days >= 1 && days <= 365)) {
    console.error('Usage: create --label "Who it is for" [--purpose company|site] [--uses 1..1000] [--days 1..365]');
    process.exit(1);
  }
  const code = generate();
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  const { data, error } = await admin.rpc("early_access_create_code", { p_code_hash: hashCode(code), p_label: label, p_max_uses: uses, p_expires_at: expires, p_purpose: purpose });
  if (error) {
    console.error(`Could not create the code: ${error.message}`);
    process.exit(1);
  }
  const what = purpose === "site_access" ? `early access, up to ${uses} device${uses === 1 ? "" : "s"}` : `company sign-up, ${uses} use${uses === 1 ? "" : "s"}`;
  console.log(`Code for "${label}" (${what}, expires ${expires.slice(0, 10)}), id ${data}:`);
  console.log(`\n  ${code}\n`);
  console.log(purpose === "site_access"
    ? "This is the only time the code is shown. Send it privately; it is entered at <APP_BASE_URL>/early-access."
    : "This is the only time the code is shown. Send it privately; sign-up is at <APP_BASE_URL>/signup.");
} else if (cmd === "list") {
  const { data, error } = await admin.rpc("early_access_list_codes");
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  for (const c of data) {
    const state = c.revoked_at ? `revoked (${c.revoke_reason})` : new Date(c.expires_at) < new Date() ? "expired" : c.used >= c.max_uses ? "used up" : "active";
    const kind = c.purpose === "site_access" || c.purpose === "site_shared"
      ? `${c.purpose === "site_shared" ? "shared" : "site  "}  ${String(c.active_grants).padStart(3)} active device(s)`
      : "company";
    console.log(`${c.id}  ${state.padEnd(10)}  ${kind.padEnd(30)}  ${c.used}/${c.max_uses} used  expires ${c.expires_at.slice(0, 10)}  ${c.label}`);
  }
  if (!data.length) console.log("No codes.");
} else if (cmd === "revoke") {
  const id = positional[0];
  const reason = typeof opts.reason === "string" ? opts.reason : "";
  if (!id || !reason) {
    console.error('Usage: revoke <code-id> --reason "Why"');
    process.exit(1);
  }
  const { error } = await admin.rpc("early_access_revoke_code", { p_code_id: id, p_reason: reason });
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log("Revoked. Devices admitted with it lose early access within minutes; companies already created keep working; pending sign-ups with it cannot finish.");
} else if (cmd === "revoke-devices") {
  const id = positional[0];
  const reason = typeof opts.reason === "string" ? opts.reason : "";
  if (!id || !reason) {
    console.error('Usage: revoke-devices <code-id> --reason "Why"');
    process.exit(1);
  }
  const { data, error } = await admin.rpc("site_access_revoke_grants", { p_code_id: id, p_reason: reason });
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log(`${data} device(s) lose early access within minutes. The code itself stays active (revoke it too to stop new devices).`);
} else {
  console.error("Commands: create | list | revoke | revoke-devices | hash");
  process.exit(1);
}
