#!/usr/bin/env node
// Early-access codes (operator only). Codes are shown once and stored only as
// SHA-256 hashes. Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// (server-side secret: run from a trusted machine, never commit it).
//
//   node --env-file=.env.local scripts/early-access.mjs create --label "Ridgeway Aggregates" [--uses 1] [--days 14]
//   node --env-file=.env.local scripts/early-access.mjs list
//   node --env-file=.env.local scripts/early-access.mjs revoke <code-id> --reason "Sent to the wrong person"
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
  if (!label || !(uses >= 1 && uses <= 1000) || !(days >= 1 && days <= 365)) {
    console.error('Usage: create --label "Who it is for" [--uses 1..1000] [--days 1..365]');
    process.exit(1);
  }
  const code = generate();
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  const { data, error } = await admin.rpc("early_access_create_code", { p_code_hash: hashCode(code), p_label: label, p_max_uses: uses, p_expires_at: expires });
  if (error) {
    console.error(`Could not create the code: ${error.message}`);
    process.exit(1);
  }
  console.log(`Code for "${label}" (${uses} use${uses === 1 ? "" : "s"}, expires ${expires.slice(0, 10)}), id ${data}:`);
  console.log(`\n  ${code}\n`);
  console.log("This is the only time the code is shown. Send it privately; sign-up is at <APP_BASE_URL>/signup.");
} else if (cmd === "list") {
  const { data, error } = await admin.rpc("early_access_list_codes");
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  for (const c of data) {
    const state = c.revoked_at ? `revoked (${c.revoke_reason})` : new Date(c.expires_at) < new Date() ? "expired" : c.used >= c.max_uses ? "used up" : "active";
    console.log(`${c.id}  ${state.padEnd(10)}  ${c.used}/${c.max_uses} used  expires ${c.expires_at.slice(0, 10)}  ${c.label}`);
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
  console.log("Revoked. Companies already created keep working; pending sign-ups with this code cannot finish.");
} else {
  console.error("Commands: create | list | revoke | hash");
  process.exit(1);
}
