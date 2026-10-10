import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { OTHER_COMPANY, PASSWORD, USERS } from "./users";

/**
 * Ensure the e2e users exist with known passwords, roles and companies
 * (idempotent). Local / disposable databases only.
 */
export default async function globalSetup() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!url || !key || !dbUrl) {
    throw new Error("E2E tests need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and TEST_DATABASE_URL (local stack only).");
  }
  if ((!/127\.0\.0\.1|localhost/.test(url) || !/127\.0\.0\.1|localhost/.test(dbUrl)) && process.env.E2E_ALLOW_REMOTE !== "1") {
    throw new Error(`Refusing to run e2e setup against ${url}. Use a local stack, or set E2E_ALLOW_REMOTE=1 for a disposable test project.`);
  }

  // The second company is created the way an operator would (not exposed to app users).
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  try {
    await db.query(
      "select private.create_company($1, $2) where not exists (select 1 from public.companies where slug = $2)",
      [OTHER_COMPANY.name, OTHER_COMPANY.slug],
    );
  } finally {
    await db.end();
  }

  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  for (const u of Object.values(USERS)) {
    const { data: existing } = await admin.from("profiles").select("id").eq("email", u.email).maybeSingle();
    let id = existing?.id as string | undefined;
    if (!id) {
      const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: u.name } });
      if (error) throw new Error(`createUser ${u.email}: ${error.message}`);
      id = data.user.id;
    } else {
      await admin.auth.admin.updateUserById(id, { password: PASSWORD });
    }
    await admin.from("profiles").update({ full_name: u.name }).eq("id", id);
    const { data: company, error: cErr } = await admin.from("companies").select("id").eq("slug", u.company).single();
    if (cErr) throw new Error(`company ${u.company}: ${cErr.message}`);
    const { error } = await admin
      .from("company_memberships")
      .upsert({ company_id: company.id, user_id: id, role: u.role, active: true }, { onConflict: "company_id,user_id" });
    if (error) throw new Error(`membership ${u.email}: ${error.message}`);
  }
}
