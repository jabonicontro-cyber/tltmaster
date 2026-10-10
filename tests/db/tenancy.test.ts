// Cross-company isolation tests. Top Line Trucking (company #1, seed data)
// and a throwaway second company ("Brookside Aggregates", fictional) created
// inside each rolled-back test transaction.
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, saveQuote, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

/** Business tables that must carry a company_id (all except the global catalogs). */
const TENANT_TABLES = [
  "company_settings", "document_sequences", "role_permissions", "audit_events", "units_of_measure",
  "price_lists", "customers", "customer_contacts", "customer_sites", "materials", "charge_items",
  "price_list_entries", "quotes", "quote_versions", "quote_lines", "quote_status_events", "documents",
  "email_deliveries", "orders", "order_lines", "order_status_events", "company_memberships",
  "trucks", "trailers", "equipment_status_events", "drivers", "driver_qualifications",
  "order_loads", "dispatch_assignments", "delivery_tickets", "delivery_ticket_events",
  "billing_reviews", "billing_handoffs", "billing_handoff_orders", "exception_assignments",
  "field_reports", "ticket_attachments",
  "order_urgencies", "order_urgency_events", "user_preferences", "exception_dismissals",
];

/** Every SECURITY DEFINER function has been reviewed for company checks. Adding one fails this test until it is reviewed. */
const REVIEWED_DEFINER_FUNCTIONS = [
  "private.assign_customer_number", "private.audit_row_change", "private.business_timezone", "private.business_today",
  "private.create_company", "private.current_app_role", "private.current_company_id", "private.handle_new_auth_user",
  "private.has_permission", "private.is_company_member", "private.issue_current_version", "private.log_event",
  "private.next_document_number", "private.purge_sample_quote_orders", "private.recompute_quote_totals",
  "private.record_status_change", "private.require_company", "private.require_permission", "private.resolve_price",
  "private.stamp_updated_by", "private.apply_order_details", "private.customer_bill_to", "private.recompute_order_totals",
  "public.add_company_member", "public.convert_quote_to_order", "public.effective_prices", "public.issue_quote_version",
  "public.mark_quote_sent", "public.my_access", "public.record_quote_delivery", "public.remove_sample_data",
  "public.revise_quote", "public.sample_data_counts", "public.save_quote_draft", "public.set_quote_status",
  "public.set_role_permission", "public.set_user_access", "public.user_directory",
  "public.save_order_draft", "public.update_order_details", "public.update_order_schedule", "public.set_order_status",
  "private.qualification_check", "private.member_summary", "public.set_equipment_service_status", "public.check_assignment_eligibility",
  "private.assignment_eligibility", "private.local_time_label", "private.resource_conflict", "private.check_assignment",
  "private.assignment_label", "private.release_order_assignments",
  "public.save_order_load", "public.cancel_order_load", "public.assign_load", "public.cancel_assignment",
  "private.prepare_ticket", "public.submit_delivery_ticket", "public.correct_delivery_ticket", "public.review_delivery_ticket",
  "private.add_billing_sequence", "public.acknowledge_billing_exceptions", "public.hand_off_orders",
  "public.revert_billing_handoff", "public.record_billing_export",
  "private.operational_exceptions", "private.require_command_center", "public.command_center_summary",
  "public.command_center_exceptions", "public.exception_assignee_options", "public.assign_exception", "public.unassign_exception",
  "private.create_ticket", "private.portal_driver", "private.driver_assignments", "public.driver_portal_home",
  "public.driver_assignment_form", "public.driver_submit_ticket", "public.driver_submit_field_report", "public.review_field_report",
  "private.can_upload_ticket_photo", "private.can_read_ticket_photo", "public.driver_begin_ticket_photo", "public.driver_confirm_ticket_photo",
  "public.abandoned_ticket_photos", "public.mark_ticket_photos_discarded",
  "private.early_access_code_state", "private.access_rate_limited", "private.provision_company",
  "public.early_access_check", "public.early_access_reserve", "public.early_access_request", "public.early_access_create_code",
  "public.early_access_list_codes", "public.early_access_revoke_code", "public.my_onboarding",
  "public.complete_company_onboarding", "public.create_company_with_access_code", "public.my_companies",
  "public.switch_company", "public.add_existing_member",
  // N10: onboarding with a time zone (second overloads), urgent orders, personal Command Center state.
  "public.complete_company_onboarding", "public.create_company_with_access_code",
  "public.flag_order_urgent", "public.update_order_urgency", "private.urgency_event", "private.close_urgency_with_order",
  "public.save_my_preference", "public.hide_exception", "public.unhide_exception",
  // N11: office scans of paper tickets.
  "public.begin_ticket_scan", "public.attach_ticket_scan",
  // N12: early-access site gate (service role only).
  "public.site_access_revoke_grants", "public.site_access_redeem", "public.site_access_validate",
];

/**
 * Public functions that take a company id on purpose. switch_company only
 * accepts companies where the caller has an active membership (tested in
 * tests/db/onboarding.test.ts).
 */
const COMPANY_ID_ARGUMENT_REVIEWED = ["public.switch_company"];

interface World {
  ids: Awaited<ReturnType<typeof sampleIds>>;
  B: string;
  tlOwner: string;
  tlOffice: string;
  bOwner: string;
  bOffice: string;
  tlQuote: { quote_id: string; version_id: string; edit_seq: number };
  tlAcceptedQuote: string;
  tlContactId: string;
  tlSiteId: string;
  bCustomerId: string;
}

/** Top Line data from the seed + one accepted Top Line quote; a second company with its own owner, office user and customer. */
async function world(s: Session): Promise<World> {
  const ids = await sampleIds(s);
  const B = await s.createCompany("Brookside Aggregates (test)");
  const tlOwner = await s.createUser("owner");
  const tlOffice = await s.createUser("office");
  const bOwner = await s.createUser("owner", { companyId: B });
  const bOffice = await s.createUser("office", { companyId: B });

  await s.asAdmin();
  const tlContactId = (await s.query<{ id: string }>("select id from customer_contacts where customer_id = $1 limit 1", [ids.contractCustomerId])).rows[0].id;
  const tlSiteId = (await s.query<{ id: string }>("select id from customer_sites where customer_id = $1 limit 1", [ids.contractCustomerId])).rows[0].id;

  await s.as(tlOwner);
  const line = { kind: "material", calc_method: "per_unit", material_id: ids.gravelId, description: "Gravel", unit_code: "ton", quantity: "10", unit_rate_cents: 900 };
  const tlQuote = await saveQuote(s, { customer_id: ids.contractCustomerId, lines: [line] });
  const accepted = await saveQuote(s, { customer_id: ids.contractCustomerId, lines: [line] });
  await s.query("select public.mark_quote_sent($1, $2, 'Handed over')", [accepted.quote_id, accepted.edit_seq]);
  await s.query("select public.set_quote_status($1, 'accepted', '')", [accepted.quote_id]);

  await s.as(bOwner);
  const bCustomerId = (await s.query<{ id: string }>("insert into public.customers (name) values ('Riverbend Builders (test)') returning id")).rows[0].id;

  return { ids, B, tlOwner, tlOffice, bOwner, bOffice, tlQuote, tlAcceptedQuote: accepted.quote_id, tlContactId, tlSiteId, bCustomerId };
}

describe("schema guards", () => {
  it("every public table has RLS and every business table has a non-null company_id", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const noRls = await s.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity");
      expect(noRls.rows).toEqual([]);
      const tables = await s.query<{ relname: string }>(
        "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and relname not in ('companies', 'profiles', 'permissions', 'role_permission_defaults') order by 1",
      );
      expect(tables.rows.map((r) => r.relname).sort()).toEqual([...TENANT_TABLES].sort());
      const nullable = await s.query(
        "select table_name from information_schema.columns where table_schema = 'public' and column_name = 'company_id' and is_nullable = 'YES' and table_name in (select relname from pg_class where relkind = 'r')",
      );
      expect(nullable.rows.map((r) => r.table_name)).toEqual(["audit_events"]);
    });
  });

  it("every elevated-privilege function is on the reviewed list, pins search_path, and none accepts a company id from the caller", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const defs = await s.query<{ name: string; args: string; config: string[] | null }>(
        "select n.nspname || '.' || p.proname as name, pg_get_function_identity_arguments(p.oid) as args, p.proconfig as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.prosecdef order by 1",
      );
      expect(defs.rows.map((r) => r.name).sort()).toEqual([...REVIEWED_DEFINER_FUNCTIONS].sort());
      for (const d of defs.rows) {
        expect(d.config ?? [], d.name).toContain('search_path=""');
        if (d.name.startsWith("public.") && !COMPANY_ID_ARGUMENT_REVIEWED.includes(d.name)) {
          expect(d.args.replace(/p_company_name text/g, ""), d.name).not.toMatch(/company/);
        }
      }
    });
  });

  it("app users cannot call internal functions", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      expect((await pgError(s.query("select private.create_company('X', 'x-co')"))).code).toBe("42501");
      expect((await pgError(s.query("select private.next_document_number($1, 'quote')", [TOP_LINE]))).code).toBe("42501");
      expect((await pgError(s.query("select private.resolve_price(null, null, null, null, current_date)"))).code).toBe("42501");
    });
  });
});

describe("reads are limited to the caller's company", () => {
  it("a second company sees none of Top Line's rows in any table or view, and vice versa", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      for (const [user, other] of [
        [w.bOwner, TOP_LINE],
        [w.tlOwner, w.B],
      ] as const) {
        await s.as(user);
        for (const t of TENANT_TABLES) {
          const r = await s.query<{ n: number }>(`select count(*)::int as n from public.${t} where company_id = $1`, [other]);
          expect(r.rows[0].n, `${t} visible across companies`).toBe(0);
        }
        for (const v of ["quote_list", "order_list", "billing_order_status", "billing_load_status"]) {
          // Views have no company column: every customer they list must be one of the caller's own customers.
          const listed = new Set((await s.query<{ customer_id: string }>(`select customer_id from public.${v}`)).rows.map((r) => r.customer_id));
          const own = await s.query<{ n: number }>("select count(*)::int as n from public.customers where id = any($1)", [[...listed]]);
          expect(own.rows[0].n, `${v} lists another company's records`).toBe(listed.size);
        }
      }
      await s.as(w.bOwner);
      expect((await s.query("select * from public.quotes where id = $1", [w.tlQuote.quote_id])).rowCount).toBe(0);
      expect((await s.query("select * from public.customers where id = $1", [w.ids.customerId])).rowCount).toBe(0);
      expect((await s.query("select * from public.companies")).rows.map((r) => r.id)).toEqual([w.B]);
    });
  });

  it("each company sees its own data", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.bOwner);
      expect((await s.query("select id from public.customers")).rows.map((r) => r.id)).toEqual([w.bCustomerId]);
      await s.as(w.tlOffice);
      expect((await s.query("select id from public.customers where id = $1", [w.ids.customerId])).rowCount).toBe(1);
    });
  });

  it("profiles, memberships and the staff directory stay within the company; emails only for user managers", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.bOwner);
      expect((await s.query("select * from public.profiles where id = $1", [w.tlOwner])).rowCount).toBe(0);
      expect((await s.query("select * from public.company_memberships where user_id = $1", [w.tlOwner])).rowCount).toBe(0);
      const dirB = await s.query<{ id: string; email: string }>("select * from public.user_directory()");
      expect(dirB.rows.map((r) => r.id).sort()).toEqual([w.bOwner, w.bOffice].sort());
      expect(dirB.rows.every((r) => r.email.includes("@"))).toBe(true); // owner manages users

      await s.as(w.bOffice);
      const dirOffice = await s.query<{ email: string }>("select * from public.user_directory()");
      expect(dirOffice.rows.every((r) => r.email === "")).toBe(true);
      expect((await s.query("select * from public.profiles")).rowCount).toBe(1); // only themselves
    });
  });
});

describe("writes cannot cross companies", () => {
  it("inserts into another company are refused", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.bOwner);
      expect((await pgError(s.query("insert into public.customers (company_id, name) values ($1, 'Intruder')", [TOP_LINE]))).code).toBe("42501");
      expect((await pgError(s.query("insert into public.materials (company_id, name, default_unit_code) values ($1, 'X', 'ton')", [TOP_LINE]))).code).toBe("42501");
      expect((await pgError(s.query("insert into public.units_of_measure (company_id, code, label, abbreviation) values ($1, 'zz', 'Z', 'z')", [TOP_LINE]))).code).toBe("42501");
      await s.asAdmin();
      expect((await s.query("select 1 from public.customers where name = 'Intruder'")).rowCount).toBe(0);
    });
  });

  it("records in one company cannot reference another company's records", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.bOwner);
      // contact for a Top Line customer, created in B
      expect((await pgError(s.query("insert into public.customer_contacts (customer_id, name) values ($1, 'X')", [w.ids.customerId]))).code).toBe("23503");
      expect((await pgError(s.query("insert into public.customer_sites (customer_id, label, line1) values ($1, 'X', '1 Rd')", [w.ids.customerId]))).code).toBe("23503");
      // B customer pointing at a Top Line price list
      const tlList = await (async () => {
        await s.asAdmin();
        const r = await s.query<{ id: string }>("select id from public.price_lists where company_id = $1 and is_standard", [TOP_LINE]);
        await s.as(w.bOwner);
        return r.rows[0].id;
      })();
      expect((await pgError(s.query("update public.customers set price_list_id = $1 where id = $2", [tlList, w.bCustomerId]))).code).toBe("23503");
      // rate on B's standard list for a Top Line material
      const bList = (await s.query<{ id: string }>("select id from public.price_lists where is_standard")).rows[0].id;
      expect((await pgError(s.query(
        "insert into public.price_list_entries (price_list_id, material_id, unit_code, rate_cents) values ($1, $2, 'ton', 100)",
        [bList, w.ids.gravelId],
      ))).code).toBe("23503");
    });
  });

  it("the database itself rejects cross-company links, even for the database owner", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.asAdmin();
      expect((await pgError(s.query(
        "insert into public.quotes (company_id, quote_number, customer_id) values ($1, 'Q-X', $2)", [w.B, w.ids.customerId],
      ))).code).toBe("23503");
      expect((await pgError(s.query(
        "insert into public.orders (company_id, order_number, customer_id, order_date) values ($1, 'O-X', $2, current_date)", [w.B, w.ids.customerId],
      ))).code).toBe("23503");
      expect((await pgError(s.query(
        "insert into public.materials (company_id, name, default_unit_code) values ($1, 'Unit from elsewhere', 'pallet')", [w.B],
      ))).code).toBe("23503");
    });
  });

  it("updates and deletes of another company's rows affect nothing, and rows cannot be moved", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.bOwner);
      expect((await s.query("update public.customers set name = 'Hijacked' where id = $1", [w.ids.customerId])).rowCount).toBe(0);
      expect((await s.query("update public.company_settings set company_name = 'Hijacked' where company_id = $1", [TOP_LINE])).rowCount).toBe(0);
      expect((await s.query("update public.document_sequences set next_value = 1 where company_id = $1", [TOP_LINE])).rowCount).toBe(0);
      expect((await s.query("delete from public.price_list_entries where company_id = $1", [TOP_LINE])).rowCount).toBe(0);
      expect((await pgError(s.query("update public.customers set company_id = $1 where id = $2", [TOP_LINE, w.bCustomerId]))).code).toBe("42501");

      await s.asAdmin();
      expect((await s.query<{ name: string }>("select name from public.customers where id = $1", [w.ids.customerId])).rows[0].name).not.toBe("Hijacked");
      expect((await s.query<{ company_name: string }>("select company_name from public.company_settings where company_id = $1", [TOP_LINE])).rows[0].company_name).not.toBe("Hijacked");
      expect((await s.query<{ n: number }>("select count(*)::int as n from public.price_list_entries where company_id = $1", [TOP_LINE])).rows[0].n).toBeGreaterThan(0);
    });
  });
});

describe("elevated-privilege functions refuse other companies' records", () => {
  it("quote functions", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      // a unit that exists only at Top Line
      await s.as(w.tlOwner);
      await s.query("insert into public.units_of_measure (code, label, abbreviation) values ('pallet', 'Pallets', 'plt')");

      await s.as(w.bOwner);
      const bLine = { kind: "other", calc_method: "per_unit", description: "Trucking", unit_code: "hour", quantity: "1", unit_rate_cents: 100 };
      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ["Top Line customer", { customer_id: w.ids.customerId, lines: [bLine] }, /Select a customer/],
        ["Top Line quote id", { quote_id: w.tlQuote.quote_id, customer_id: w.bCustomerId, lines: [bLine] }, /Quote not found/],
        ["Top Line material", { customer_id: w.bCustomerId, lines: [{ ...bLine, kind: "material", material_id: w.ids.gravelId }] }, /material not found/],
        ["Top Line charge", { customer_id: w.bCustomerId, lines: [{ ...bLine, kind: "hauling", charge_item_id: w.ids.haulTonId }] }, /charge not found/],
        ["Top Line-only unit", { customer_id: w.bCustomerId, lines: [{ ...bLine, unit_code: "pallet" }] }, /valid unit/],
        ["Top Line contact", { customer_id: w.bCustomerId, contact_id: w.tlContactId, lines: [bLine] }, /contact does not belong/],
        ["Top Line job site", { customer_id: w.bCustomerId, site_id: w.tlSiteId, lines: [bLine] }, /job site does not belong/],
      ];
      for (const [label, payload, re] of cases) {
        expect((await pgError(saveQuote(s, payload))).message, label).toMatch(re);
      }

      const q = w.tlQuote.quote_id;
      expect((await pgError(s.query("select * from public.effective_prices($1, current_date)", [w.ids.customerId]))).message).toMatch(/Customer not found/);
      expect((await pgError(s.query("select public.issue_quote_version($1, null)", [q]))).message).toMatch(/Quote not found/);
      expect((await pgError(s.query("select public.mark_quote_sent($1, null, 'x')", [q]))).message).toMatch(/Quote not found/);
      expect((await pgError(s.query(
        "select public.record_quote_delivery($1, $2, 'failed', array['a@example.com'], '{}', 's', 'b', 'p', null, 'e', null)", [q, w.tlQuote.version_id],
      ))).message).toMatch(/Quote not found/);
      expect((await pgError(s.query("select public.revise_quote($1, 'x')", [w.tlAcceptedQuote]))).message).toMatch(/Quote not found/);
      expect((await pgError(s.query("select public.set_quote_status($1, 'canceled', 'x')", [q]))).message).toMatch(/Quote not found/);
      expect((await pgError(s.query("select public.convert_quote_to_order($1)", [w.tlAcceptedQuote]))).message).toMatch(/Quote not found/);

      await s.asAdmin();
      const tl = await s.query("select status, current_version_id from public.quotes where id = $1", [q]);
      expect(tl.rows[0].status).toBe("draft");
      expect((await s.query("select 1 from public.orders where source_quote_id = $1", [w.tlAcceptedQuote])).rowCount).toBe(0);
      expect((await s.query("select 1 from public.email_deliveries where quote_id = $1", [q])).rowCount).toBe(0);
    });
  });

  it("user and permission administration", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.bOwner);
      expect((await pgError(s.query("select public.set_user_access($1, 'driver', false, 'Renamed')", [w.tlOffice]))).message).toMatch(/User not found/);
      await s.query("select public.set_role_permission('office', 'pricing.override', true)");
      await s.query("select public.set_role_permission('office', 'quotes.view', false)");

      // Adding a Top Line user to B grants them B access only — never Top Line data to B — and cannot rename them.
      await s.query("select public.add_company_member($1, 'dispatcher', 'Renamed by B')", [w.tlOffice]);
      expect((await s.query("select * from public.customers where company_id = $1", [TOP_LINE])).rowCount).toBe(0);

      await s.asAdmin();
      const tlm = await s.query("select role, active from public.company_memberships where user_id = $1 and company_id = $2", [w.tlOffice, TOP_LINE]);
      expect(tlm.rows[0]).toEqual({ role: "office", active: true });
      expect((await s.query<{ full_name: string }>("select full_name from public.profiles where id = $1", [w.tlOffice])).rows[0].full_name).not.toBe("Renamed by B");
      const tlGrants = await s.query<{ permission: string }>("select permission from public.role_permissions where company_id = $1 and role = 'office'", [TOP_LINE]);
      expect(tlGrants.rows.map((r) => r.permission)).toContain("quotes.view");
      expect(tlGrants.rows.map((r) => r.permission)).not.toContain("pricing.override");

      // The Top Line user still works in Top Line (oldest membership) unless they switch.
      await s.as(w.tlOffice);
      const access = await s.query<{ a: { company_id: string } }>("select public.my_access() as a");
      expect(access.rows[0].a.company_id).toBe(TOP_LINE);
    });
  });

  it("sample data and settings are per company", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.tlOwner);
      const tlBefore = (await s.query<{ c: Record<string, number> }>("select public.sample_data_counts() as c")).rows[0].c;
      expect(tlBefore.customers).toBeGreaterThan(0);

      await s.as(w.bOwner);
      expect((await s.query<{ c: Record<string, number> }>("select public.sample_data_counts() as c")).rows[0].c).toEqual({
        customers: 0, materials: 0, charge_items: 0, price_lists: 0, quotes: 0, orders: 0,
      });
      await s.query("select public.remove_sample_data()");
      await s.query("update public.company_settings set company_name = 'Brookside Aggregates', default_tax_rate_bp = 600");

      await s.as(w.tlOwner);
      expect((await s.query<{ c: Record<string, number> }>("select public.sample_data_counts() as c")).rows[0].c).toEqual(tlBefore);
      const settings = await s.query<{ company_name: string; default_tax_rate_bp: number }>("select company_name, default_tax_rate_bp from public.company_settings");
      expect(settings.rowCount).toBe(1);
      expect(settings.rows[0].company_name).not.toBe("Brookside Aggregates");
    });
  });
});

describe("per-company numbering and uniqueness", () => {
  it("each company numbers its own documents and may reuse names", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.bOwner);
      const cust = await s.query<{ customer_number: string }>("select customer_number from public.customers where id = $1", [w.bCustomerId]);
      expect(cust.rows[0].customer_number).toBe("C-00001");
      await s.query("insert into public.materials (name, default_unit_code) values ('Gravel #53 limestone', 'ton')");
      const q = await saveQuote(s, {
        customer_id: w.bCustomerId,
        lines: [{ kind: "other", calc_method: "per_unit", description: "Trucking", unit_code: "hour", quantity: "2", unit_rate_cents: 12345 }],
      });
      expect(q.quote_number).toMatch(/^Q-\d{4}-0001$/);
      expect(q.total_cents).toBe(24690);

      await s.query("select public.mark_quote_sent($1, $2, 'Handed over')", [q.quote_id, q.edit_seq]);
      await s.query("select public.set_quote_status($1, 'accepted', '')", [q.quote_id]);
      const o = await s.query<{ r: { order_number: string; created: boolean } }>("select public.convert_quote_to_order($1) as r", [q.quote_id]);
      expect(o.rows[0].r.order_number).toMatch(/^O-\d{4}-0001$/);
      const again = await s.query<{ r: { created: boolean } }>("select public.convert_quote_to_order($1) as r", [q.quote_id]);
      expect(again.rows[0].r.created).toBe(false);

      // Top Line can still have its own Q-…-0001 etc. without conflict.
      await s.asAdmin();
      const dup = await s.query<{ n: number }>("select count(distinct company_id)::int as n from public.customers where customer_number = 'C-00001'");
      expect(dup.rows[0].n).toBe(2);
    });
  });
});

describe("membership states", () => {
  it("inactive memberships, inactive companies and users without a role see nothing", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      const inactive = await s.createUser("office", { companyId: w.B, active: false });
      const pending = await s.createUser(null, { companyId: w.B });
      const none = await s.createUser("office", { membership: false });
      for (const u of [inactive, pending, none]) {
        await s.as(u);
        expect((await s.query("select * from public.customers")).rowCount).toBe(0);
        expect((await s.query<{ a: { company_id: string | null } }>("select public.my_access() as a")).rows[0].a.company_id).toBeNull();
      }
      await s.asAdmin();
      await s.query("update public.companies set active = false where id = $1", [w.B]);
      await s.as(w.bOwner);
      expect((await s.query("select * from public.customers")).rowCount).toBe(0);
    });
  });

  it("a person in two companies sees only the company they are working in", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.asAdmin();
      await s.query("insert into public.company_memberships (company_id, user_id, role) values ($1, $2, 'owner')", [w.B, w.tlOffice]);

      await s.as(w.tlOffice);
      expect((await s.query<{ n: number }>("select count(*)::int as n from public.customers where company_id = $1", [w.B])).rows[0].n).toBe(0);
      expect((await s.query<{ n: number }>("select count(*)::int as n from public.customers where company_id = $1", [TOP_LINE])).rows[0].n).toBeGreaterThan(0);

      await s.asAdmin();
      await s.query("update public.profiles set active_company_id = $1 where id = $2", [w.B, w.tlOffice]);
      await s.as(w.tlOffice);
      expect((await s.query<{ n: number }>("select count(*)::int as n from public.customers where company_id = $1", [TOP_LINE])).rows[0].n).toBe(0);
      expect((await s.query<{ n: number }>("select count(*)::int as n from public.customers where company_id = $1", [w.B])).rows[0].n).toBe(1);
      // Role and permissions are those of the B membership (owner), not Top Line (office).
      const a = await s.query<{ a: { role: string; permissions: string[] } }>("select public.my_access() as a");
      expect(a.rows[0].a.role).toBe("owner");
      expect(a.rows[0].a.permissions).toContain("users.manage");
    });
  });
});

describe("audit history is per company", () => {
  it("each company sees only its own audit events, and actions are recorded under the actor's company", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.bOwner);
      const b = await s.query<{ company_id: string; entity_id: string }>("select company_id, entity_id from public.audit_events");
      expect(b.rows.length).toBeGreaterThan(0);
      expect(b.rows.every((r) => r.company_id === w.B)).toBe(true);
      expect(b.rows.some((r) => r.entity_id === w.bCustomerId)).toBe(true);

      await s.as(w.tlOwner);
      const tl = await s.query<{ entity_id: string }>("select entity_id from public.audit_events where entity_id = $1", [w.bCustomerId]);
      expect(tl.rowCount).toBe(0);
    });
  });
});
