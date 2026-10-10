#!/usr/bin/env node
// Creates (or promotes) the first Owner account.
//
//   node --env-file=.env.local scripts/create-owner.mjs owner@example.com "Full Name"
//
// Prompts for a password (or reads OWNER_PASSWORD). Requires
// NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Run from a trusted
// machine only — the service-role key bypasses all security policies.
import { createClient } from "@supabase/supabase-js";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const [email, fullName = ""] = process.argv.slice(2);
if (!email || !email.includes("@")) {
  console.error('Usage: node --env-file=.env.local scripts/create-owner.mjs <email> "<full name>"');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

let password = process.env.OWNER_PASSWORD;
if (!password) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  password = await rl.question("Password for the owner account (min 10 characters): ");
  rl.close();
}
if (!password || password.length < 10) {
  console.error("Password must be at least 10 characters.");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

let userId;
const created = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: fullName },
});
if (created.error) {
  if (!/already/i.test(created.error.message)) {
    console.error("Could not create user:", created.error.message);
    process.exit(1);
  }
  // Existing user: find it and promote.
  const { data, error } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  if (error || !data) {
    console.error("User exists in Auth but has no profile row:", error?.message ?? "not found");
    process.exit(1);
  }
  userId = data.id;
  console.log("User already exists; promoting to owner (password unchanged).");
} else {
  userId = created.data.user.id;
}

const { error: roleError } = await admin
  .from("profiles")
  .update({ role: "owner", active: true, ...(fullName ? { full_name: fullName } : {}) })
  .eq("id", userId);
if (roleError) {
  console.error("Could not set the owner role:", roleError.message);
  process.exit(1);
}
console.log(`Owner account ready: ${email}`);
