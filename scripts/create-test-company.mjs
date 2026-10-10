#!/usr/bin/env node
// Creates (or completes) a TEST company with one account per role — owner,
// office, dispatcher, mechanic, driver — for multi-company testing on a LOCAL
// database. Refuses any non-local URL. Idempotent: running it again reuses the
// company and accounts.
//
//   TEST_USER_PASSWORD='choose-10+-chars' node --env-file=.env.local scripts/create-test-company.mjs "Ridgeway Aggregates (test)" ridgeway [America/Denver]
//
// Accounts: owner@<key>.test, office@<key>.test, dispatcher@<key>.test,
// mechanic@<key>.test, driver@<key>.test (the .test domain never receives
// mail). The password is read from TEST_USER_PASSWORD and never printed.
// Uses the existing role permissions — nothing broader.
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const [name, key, timezone] = process.argv.slice(2);
if (!name || !key || !/^[a-z0-9-]{2,30}$/.test(key)) {
  console.error('Usage: TEST_USER_PASSWORD=... node --env-file=.env.local scripts/create-test-company.mjs "Company Name (test)" short-key');
  process.exit(1);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const password = process.env.TEST_USER_PASSWORD ?? "";
const local = (u) => /^(postgres(ql)?|https?):\/\/([^@/]*@)?(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u);
if (!local(url) || !local(dbUrl)) {
  console.error("Refusing: NEXT_PUBLIC_SUPABASE_URL and TEST_DATABASE_URL must point to localhost. Use the onboarding flow (access code + invitations) on staging.");
  process.exit(1);
}
if (!serviceKey || password.length < 10) {
  console.error("Set SUPABASE_SERVICE_ROLE_KEY and TEST_USER_PASSWORD (at least 10 characters).");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const slug = `test-${key}`;
try {
  let companyId = (await db.query("select id from public.companies where slug = $1", [slug])).rows[0]?.id;
  if (!companyId) {
    companyId = (await db.query("select private.create_company($1, $2) as id", [name, slug])).rows[0].id;
    // A new company's own time zone (optional third argument), as onboarding asks for it.
    if (timezone) await db.query("update public.company_settings set timezone = private.valid_timezone($1) where company_id = $2", [timezone, companyId]);
  }

  const roles = ["owner", "office", "dispatcher", "mechanic", "driver"];
  const people = { owner: "Olivia Owner", office: "Owen Office", dispatcher: "Dee Dispatch", mechanic: "Mack Mechanic", driver: "Drew Driver" };
  for (const role of roles) {
    const email = `${role}@${key}.test`;
    let userId = (await db.query("select id from public.profiles where lower(email) = $1", [email])).rows[0]?.id;
    if (!userId) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `${people[role]} (${key})` } });
      if (error) throw new Error(`${email}: ${error.message}`);
      userId = data.user.id;
    } else {
      await admin.auth.admin.updateUserById(userId, { password });
    }
    await db.query(
      `insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, $3, true)
       on conflict (company_id, user_id) do update set role = excluded.role, active = true`,
      [companyId, userId, role],
    );
    await db.query("update public.profiles set active_company_id = $2 where id = $1 and active_company_id is null", [userId, companyId]);
    if (role === "driver") {
      // A driver record linked to the account, with verified CDL and medical card.
      const existing = (await db.query("select id from public.drivers where company_id = $1 and user_id = $2", [companyId, userId])).rows[0]?.id;
      if (!existing) {
        const d = (await db.query("insert into public.drivers (company_id, user_id) values ($1, $2) returning id", [companyId, userId])).rows[0].id;
        const exp = new Date(Date.now() + 600 * 86400000).toISOString().slice(0, 10);
        await db.query(
          "insert into public.driver_qualifications (company_id, driver_id, kind, cdl_class, expires_on, verified_at) values ($1, $2, 'cdl', 'A', $3, now()), ($1, $2, 'medical_card', null, $3, now())",
          [companyId, d, exp],
        );
      }
    }
    console.log(`${role.padEnd(10)} ${email}`);
  }
  console.log(`\nCompany "${name}" (${slug}) is ready. Sign in at http://localhost:3000/login with the password from TEST_USER_PASSWORD.`);
} finally {
  await db.end();
}
