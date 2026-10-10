import { createClient } from "@supabase/supabase-js";
import { PASSWORD, USERS } from "./users";

/** Ensure the e2e users exist with known passwords and roles (idempotent). */
export default async function globalSetup() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("E2E tests need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (local stack only).");
  if (!/127\.0\.0\.1|localhost/.test(url) && process.env.E2E_ALLOW_REMOTE !== "1") {
    throw new Error(`Refusing to run e2e setup against ${url}. Use a local stack, or set E2E_ALLOW_REMOTE=1 for a disposable test project.`);
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
    const { error } = await admin.from("profiles").update({ role: u.role, active: true, full_name: u.name }).eq("id", id);
    if (error) throw new Error(`set role ${u.email}: ${error.message}`);
  }
}
