// Guided onboarding (20261120001000): a checklist generated from the company's own situation; the company side
// (settings.manage) starts, submits and completes unreviewed tasks; only Taviron (platform admin, aal2) approves,
// requests changes or sets not applicable; dependencies gate approval; internal notes stay internal; documents are
// confined to their company; onboarding never touches the lifecycle (go-live date, stage, fees).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Task = { id: string; key: string; status: string; side: string; review_required: boolean; depends_on: string[]; unmet: string[]; instructions: string;
  events: Array<{ kind: string; body: string; internal: boolean }>; documents: Array<{ id: string }> };
type State = { tasks: Task[]; summary: { required: number; required_done: number; review: number; blocked: number; ready: boolean } };

async function platformAdmin(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  return id;
}

/** A fresh customer company with an owner and a dispatcher, plus one tractor (so the trailers task applies). */
async function customerCompany(s: Session) {
  const company = await s.createCompany(`Onboarding Test ${randomUUID().slice(0, 6)}`);
  const owner = await s.createUser("owner", { companyId: company });
  const dispatcher = await s.createUser("dispatcher", { companyId: company });
  await s.asAdmin();
  await s.query("insert into public.trucks (company_id, unit_number, truck_type) values ($1, 'T-1', 'tractor')", [company]);
  return { company, owner, dispatcher };
}

async function staffState(s: Session, admin: string, company: string) {
  await s.as(admin);
  return (await s.query<{ r: State }>("select public.platform_onboarding($1) r", [company])).rows[0].r;
}
const task = (st: State, key: string) => st.tasks.find((t) => t.key === key)!;

describe("guided onboarding", () => {
  it("generates a checklist from the company's situation, only for Taviron, and generating again adds nothing", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      const { company, owner } = await customerCompany(s);
      // Not the company itself, and not a platform admin without a verified second factor.
      await s.as(owner);
      expect((await pgError(s.query("select public.platform_onboarding_generate($1, '{}')", [company]))).code).toBe("42501");
      await s.as(admin);
      await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin, role: "authenticated", aal: "aal1" })]);
      expect((await pgError(s.query("select public.platform_onboarding_generate($1, '{}')", [company]))).code).toBe("42501");

      await s.as(admin);
      const added = (await s.query<{ n: number }>("select public.platform_onboarding_generate($1, '{\"routing\": true}') n", [company])).rows[0].n;
      expect(added).toBeGreaterThan(8);
      const st = await staffState(s, admin, company);
      const keys = st.tasks.map((t) => t.key);
      expect(keys).toEqual(expect.arrayContaining(["agreement", "company_profile", "people", "customers", "materials", "trucks", "trailers", "drivers", "import_review", "go_live_review", "yard_location"]));
      expect(keys).not.toContain("portal"); // not entitled
      expect(keys).not.toContain("ai_review"); // not configured
      expect(task(st, "trucks").instructions).toContain("No plan is recorded");
      expect(task(st, "go_live_review").depends_on).toEqual(expect.arrayContaining(["agreement", "drivers", "import_review"]));
      expect((await s.query<{ n: number }>("select public.platform_onboarding_generate($1, '{\"routing\": true}') n", [company])).rows[0].n).toBe(0);
      await s.asAdmin();
      expect((await s.query("select 1 from private.platform_audit where action = 'onboarding.generate' and target_id = $1", [company])).rowCount).toBe(2);
    });
  });

  it("separates customer submission from Taviron approval, enforces dependencies and reasons, and notifies in-app only", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      const { company, owner, dispatcher } = await customerCompany(s);
      await s.as(admin);
      await s.query("select public.platform_onboarding_generate($1, '{}')", [company]);
      const ids = Object.fromEntries((await staffState(s, admin, company)).tasks.map((t) => [t.key, t.id]));

      // Only settings.manage on the company side.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.onboarding_state()"))).code).toBe("42501");
      expect((await s.query("select 1 from public.onboarding_tasks")).rowCount).toBe(0);

      await s.as(owner);
      const set = (key: string, status: string, note = "") => s.query("select public.onboarding_set_status($1, $2, $3)", [ids[key], status, note]);
      await set("customers", "in_progress");
      await set("customers", "submitted");
      // The customer never approves a reviewed task, sets not applicable, or acts on Taviron's tasks.
      expect((await pgError(set("customers", "approved"))).code).toBe("42501");
      expect((await pgError(set("materials", "approved"))).code).toBe("42501");
      expect((await pgError(set("trailers", "not_applicable", "no trailers"))).code).toBe("42501");
      expect((await pgError(set("agreement", "in_progress"))).code).toBe("42501");
      // A task without review is completed by the customer; one with review cannot be "completed" that way.
      await set("company_profile", "approved");
      expect((await pgError(set("company_profile", "in_progress"))).code).toBe("42501"); // finished: Taviron reopens
      expect((await pgError(set("people", "submitted"))).code).toBe("22023");
      // Dependencies: training waits on trucks and drivers.
      expect((await pgError(set("training_dispatch", "submitted"))).message).toMatch(/Waiting on/);
      // Blocked needs a reason.
      expect((await pgError(set("drivers", "blocked"))).code).toBe("22023");
      await set("drivers", "blocked", "Two medical cards missing");

      // Taviron: changes requested needs a reason; approval notifies the owner in-app.
      await s.as(admin);
      const staff = (key: string, status: string, note = "") => s.query("select public.platform_onboarding_set_status($1, $2, $3)", [ids[key], status, note]);
      expect((await pgError(staff("trucks", "changes_requested"))).code).toBe("22023");
      await staff("trucks", "changes_requested", "Add capacities");
      await staff("customers", "approved");
      expect((await pgError(staff("import_review", "approved"))).message).toMatch(/Waiting on/);
      await s.asAdmin();
      const notes = await s.query<{ title: string; user_id: string }>("select title, user_id from public.comm_notifications where company_id = $1 and category = 'onboarding' order by created_at", [company]);
      expect(notes.rows.map((n) => n.title)).toEqual(["Changes requested: Confirm your trucks and their capacity", "Approved: Send your customer list"]);
      expect(new Set(notes.rows.map((n) => n.user_id))).toEqual(new Set([owner]));

      // History records every change with its side.
      const st = await staffState(s, admin, company);
      expect(task(st, "customers").events.filter((e) => e.kind === "status").length).toBe(3);
      expect(st.summary.blocked).toBe(1);
    });
  });

  it("keeps Taviron's internal notes from the company, and never changes the lifecycle when everything is approved", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      const { company, owner } = await customerCompany(s);
      await s.asAdmin();
      await s.query("insert into private.company_lifecycle (company_id, stage, go_live_on) values ($1, 'onboarding', '2027-03-01')", [company]);
      await s.as(admin);
      await s.query("select public.platform_onboarding_generate($1, '{}')", [company]);
      const st0 = await staffState(s, admin, company);
      const customersId = task(st0, "customers").id;
      await s.query("select public.platform_onboarding_comment($1, 'Internal: file looks thin', true)", [customersId]);
      await s.query("select public.platform_onboarding_comment($1, 'Please include billing emails', false)", [customersId]);

      await s.as(owner);
      const mine = (await s.query<{ r: State }>("select public.onboarding_state() r")).rows[0].r;
      const bodies = task(mine, "customers").events.map((e) => e.body);
      expect(bodies).toContain("Please include billing emails");
      expect(bodies).not.toContain("Internal: file looks thin");
      expect((await s.query("select 1 from public.onboarding_events where internal")).rowCount).toBe(0);
      await s.query("select public.onboarding_comment($1, 'Will do')", [customersId]);

      // Approve everything in dependency order as Taviron.
      await s.as(admin);
      for (let i = 0; i < 4; i++) {
        for (const t of (await staffState(s, admin, company)).tasks) {
          if (t.status !== "approved" && t.unmet.length === 0) await s.query("select public.platform_onboarding_set_status($1, 'approved', '')", [t.id]);
        }
      }
      const done = await staffState(s, admin, company);
      expect(done.summary.ready).toBe(true);
      expect(done.summary.required_done).toBe(done.summary.required);
      await s.asAdmin();
      const lc = (await s.query<{ stage: string; go_live_on: string; live_at: string | null }>("select stage, go_live_on::text, live_at from private.company_lifecycle where company_id = $1", [company])).rows[0];
      expect(lc).toEqual({ stage: "onboarding", go_live_on: "2027-03-01", live_at: null });
    });
  });

  it("confines tasks and documents to their company", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      const { company, owner } = await customerCompany(s);
      const otherOwner = await s.createUser("owner"); // Top Line
      await s.as(admin);
      await s.query("select public.platform_onboarding_generate($1, '{}')", [company]);
      const customersId = task(await staffState(s, admin, company), "customers").id;

      // Another company's owner can neither see nor act on the task.
      await s.as(otherOwner);
      expect((await s.query("select 1 from public.onboarding_tasks where company_id = $1", [company])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.onboarding_set_status($1, 'in_progress', '')", [customersId]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.onboarding_comment($1, 'hi')", [customersId]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.onboarding_begin_document($1, gen_random_uuid(), 'a.csv', 'text/csv', 10, repeat('a', 64))", [customersId]))).code).toBe("P0002");

      // The owner may not assign someone from another company.
      await s.as(owner);
      expect((await pgError(s.query("select public.onboarding_assign($1, $2, null)", [customersId, otherOwner]))).code).toBe("22023");
      // Only the allowed file types; a document's path is chosen by the database inside the company's folder.
      expect((await pgError(s.query("select public.onboarding_begin_document($1, gen_random_uuid(), 'a.exe', 'application/x-msdownload', 10, repeat('a', 64))", [customersId]))).code).toBe("22023");
      const doc = (await s.query<{ r: { document_id: string; object_path: string } }>(
        "select public.onboarding_begin_document($1, gen_random_uuid(), 'customers.csv', 'text/csv', 120, repeat('b', 64)) r", [customersId])).rows[0].r;
      expect(doc.object_path.startsWith(`${company}/onboarding/`)).toBe(true);
      expect((await s.query<{ ok: boolean }>("select private.can_upload_onboarding_document($1) ok", [doc.object_path])).rows[0].ok).toBe(true);
      // Not confirmed until the stored object exists and matches.
      expect((await pgError(s.query("select public.onboarding_confirm_document($1)", [doc.document_id]))).code).toBe("P0001");
      await s.asAdmin();
      if ((await s.query("select to_regclass('storage.objects') r")).rows[0].r) {
        await s.query("insert into storage.objects (bucket_id, name, metadata) values ('onboarding-documents', $1, $2)", [doc.object_path, { size: 120, mimetype: "text/csv" }]);
        await s.as(owner);
        expect((await s.query<{ r: { status: string } }>("select public.onboarding_confirm_document($1) r", [doc.document_id])).rows[0].r.status).toBe("uploaded");
        expect((await s.query<{ ok: boolean }>("select private.can_read_onboarding_document($1) ok", [doc.object_path])).rows[0].ok).toBe(true);
        expect((await s.query("select 1 from public.onboarding_documents")).rowCount).toBe(1);
        await s.as(otherOwner);
        expect((await s.query<{ ok: boolean }>("select private.can_read_onboarding_document($1) ok", [doc.object_path])).rows[0].ok).toBe(false);
        expect((await pgError(s.query("select public.onboarding_document_path($1)", [doc.document_id]))).code).toBe("P0002");
        await s.as(admin);
        expect((await s.query<{ r: { object_path: string } }>("select public.onboarding_document_path($1) r", [doc.document_id])).rows[0].r.object_path).toBe(doc.object_path);
      }
    });
  });

  it("reminds in-app at most once a day, and demo samples are for demo companies only and idempotent", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      const { company } = await customerCompany(s);
      await s.as(admin);
      await s.query("select public.platform_onboarding_generate($1, '{}')", [company]);
      const st = await staffState(s, admin, company);
      expect((await s.query<{ n: number }>("select public.platform_onboarding_remind($1) n", [task(st, "trucks").id])).rows[0].n).toBe(1);
      expect((await pgError(s.query("select public.platform_onboarding_remind($1)", [task(st, "trucks").id]))).code).toBe("54000");
      expect((await pgError(s.query("select public.platform_onboarding_remind($1)", [task(st, "agreement").id]))).code).toBe("22023");

      // A real company refuses sample data.
      const realOwner = await s.createUser("owner"); // Top Line is not a demo
      await s.as(realOwner);
      expect((await pgError(s.query("select public.onboarding_demo_samples()"))).code).toBe("42501");
      // A demo company gets a varied, fictional picture once.
      const demo = await s.createCompany(`Demo Onboarding ${randomUUID().slice(0, 6)}`);
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      const demoOwner = await s.createUser("owner", { companyId: demo });
      await s.as(demoOwner);
      expect((await s.query<{ n: number }>("select public.onboarding_demo_samples() n")).rows[0].n).toBeGreaterThan(8);
      expect((await s.query<{ n: number }>("select public.onboarding_demo_samples() n")).rows[0].n).toBe(0);
      const mine = (await s.query<{ r: State }>("select public.onboarding_state() r")).rows[0].r;
      const statuses = new Set(mine.tasks.map((t) => t.status));
      for (const st2 of ["approved", "submitted", "changes_requested", "blocked", "awaiting_customer", "not_started"]) expect(statuses).toContain(st2);
      expect(mine.summary.review).toBe(1);
      await s.asAdmin();
      expect((await s.query("select 1 from public.onboarding_tasks where company_id = $1", [TOP_LINE])).rowCount).toBe(0);
    });
  });
});
