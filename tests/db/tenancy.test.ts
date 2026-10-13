// Cross-company isolation tests. Top Line Trucking (company #1, seed data)
// and a throwaway second company ("Brookside Aggregates", fictional) created
// inside each rolled-back test transaction.
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, saveQuote, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

/** Business tables that must carry a company_id (all except the global catalogs). */
const TENANT_TABLES = [
  "comm_settings", "conversations", "conversation_members", "messages", "message_revisions", "conversation_events",
  "user_presence", "comm_preferences", "comm_notifications", "announcements", "announcement_revisions", "announcement_receipts",
  "operation_workspaces", "comm_housekeeping_runs", "message_attachments",
  "comm_alert_settings", "alerts", "alert_recipients", "alert_acknowledgments", "alert_events",
  "ai_usage_events",
  "employees", "employee_compensation",
  "time_off_requests", "time_off_events",
  "vehicle_documents", "truck_assignment_events",
  "truck_readings", "maintenance_schedules", "work_orders", "work_order_events", "work_order_costs",
  "company_settings", "document_sequences", "role_permissions", "audit_events", "units_of_measure",
  "price_lists", "customers", "customer_contacts", "customer_sites", "materials", "charge_items",
  "price_list_entries", "quotes", "quote_versions", "quote_lines", "quote_status_events", "documents",
  "email_deliveries", "orders", "order_lines", "order_status_events", "company_memberships",
  "trucks", "trailers", "equipment_status_events", "drivers", "driver_qualifications",
  "order_loads", "dispatch_assignments", "delivery_tickets", "delivery_ticket_events",
  "billing_reviews", "billing_handoffs", "billing_handoff_orders", "exception_assignments",
  "field_reports", "ticket_attachments",
  "order_urgencies", "order_urgency_events", "user_preferences", "exception_dismissals",
  "dispatch_recommendation_rejections",
];

/** Every SECURITY DEFINER function has been reviewed for company checks. Adding one fails this test until it is reviewed. */
const REVIEWED_DEFINER_FUNCTIONS = [
  // Communications hardening (20261108000100): legal-hold lookup is internal; housekeeping_all and the expired-file
  // functions are service role only (no company argument; they act on every company by design, from the scheduler);
  // seed_demo_samples needs require_company(), comms.admin and a demo company.
  "private.comm_legal_hold", "public.comm_housekeeping_all", "public.comm_expired_attachment_files",
  "public.comm_mark_attachment_files_removed", "public.comm_seed_demo_samples",
  // Prospect demo tenants (20261106000100): create needs the platform role; add_owner is service role only and
  // accepts only an active prospect demo company and an existing login.
  "public.platform_prospect_demo_create", "public.platform_prospect_demo_add_owner", "public.platform_prospect_demo_retire",
  // Communications attachments (20261105000400): reserve/confirm/discard/send need require_company(), comms.message,
  // current membership and the caller's own upload; readability follows the message's visibility; storage policies
  // only allow the reserved path; abandoned_comm_attachments is service role only.
  "private.can_read_comm_attachment", "private.can_upload_comm_attachment", "private.comm_attachment_readable",
  "public.abandoned_comm_attachments", "public.comm_begin_attachment", "public.comm_confirm_attachment",
  "public.comm_discard_attachment", "public.comm_send_files",
  // Communications (20261105000100): every public function uses require_company() and a comms.* permission or
  // active membership of the conversation; coworkers are checked with comm_require_coworker; history before a
  // member's history_from is never returned; admin search needs comms.admin and a reason and is audited.
  // Private helpers take a company id only from server-side callers (not executable by app users).
  "private.comm_active_member", "private.comm_add_member", "private.comm_apply_retention", "private.comm_can_manage",
  "private.comm_ever_member", "private.comm_in_quiet_hours", "private.comm_message_visible", "private.comm_my_department",
  "private.comm_notify", "private.comm_presence", "private.comm_require_coworker", "private.comm_settings_of",
  "private.comm_user_name", "private.comm_work_status",
  "public.comm_add_members", "public.comm_admin_search", "public.comm_announcement_receipt", "public.comm_create_channel",
  "public.comm_create_group", "public.comm_delete_message", "public.comm_directory", "public.comm_edit_announcement",
  "public.comm_edit_message", "public.comm_inbox", "public.comm_mark_notifications_read", "public.comm_mark_read",
  "public.comm_mute", "public.comm_open_direct", "public.comm_pin_message", "public.comm_publish_announcement",
  "public.comm_receipts", "public.comm_release_deferred", "public.comm_remove_member", "public.comm_save_preferences",
  "public.comm_save_settings", "public.comm_search", "public.comm_send", "public.comm_set_member_role",
  "public.comm_set_presence", "public.comm_set_title", "public.comm_withdraw_announcement",
  // Operational workspaces (20261105000200): comms.operations; scopes resolve orders and loads of require_company()
  // only (another company's ids are "not found"); dispatch triggers sync inside the same company.
  "private.comm_archive_finished", "private.comm_on_dispatch_change", "private.comm_scope_drivers", "private.comm_scope_from",
  "private.comm_scope_loads", "private.comm_sync_operation", "private.comm_sync_safely", "private.comm_workspaces_for_load",
  "public.comm_create_operation", "public.comm_housekeeping", "public.comm_operation_close", "public.comm_operation_preview",
  "public.comm_operation_reopen", "public.comm_operation_resync", "public.comm_operation_update_scope",
  // Operational alerts (20261105000300): actions need require_company() plus responsible recipiency (acknowledge) or
  // comms.alerts / comms.admin; recipients are always members of the alert's company; source triggers are internal.
  "private.alert_is_recipient", "private.alert_outstanding", "private.alert_policy", "private.alert_users_with",
  "private.alerts_from_announcement_receipts", "private.alerts_from_announcements", "private.alerts_from_assignments",
  "private.alerts_from_field_reports", "private.alerts_from_time_off", "private.alerts_from_work_orders",
  "private.comm_document_alerts", "private.comm_escalate_due", "private.comm_operation_can_archive",
  "private.comm_raise_alert", "private.comm_resolve_alert",
  "public.comm_alert_acknowledge", "public.comm_alert_counts", "public.comm_alert_reassign", "public.comm_alert_resolve",
  "public.comm_alert_set_priority", "public.comm_save_alert_setting",
  // Time off (20261104000100): own-employee check for RLS; conflict helpers are internal; save/decide/cancel check
  // the caller's company, own record or time_off.approve, and never let anyone decide their own request;
  // dispatch_time_off needs dispatch.view and returns no category or reason.
  "private.is_own_employee", "private.driver_time_off_conflict", "private.time_off_assignment_conflicts",
  "public.time_off_save", "public.time_off_decide", "public.time_off_cancel", "public.dispatch_time_off",
  // Dispatch maintenance (20261103000100): shop schedule needs dispatch.view, caller's company only, no costs.
  "public.dispatch_shop_schedule",
  // Fleet management (20261102000100): assignment history trigger (internal, not executable by app users);
  // assign_truck_driver needs fleet.assign and checks truck and driver against require_company().
  "private.record_truck_assignment", "public.assign_truck_driver",
  // Maintenance (20261101000100): every public function uses require_company() and a maintenance.* permission;
  // truck restriction/release helpers are internal (not executable by app users); driver notices read only the
  // caller's own driver record; the sequence trigger only inserts the new company's own row.
  "private.add_work_order_sequence", "private.wo_restrict_truck", "private.wo_release_truck",
  "public.record_truck_reading", "public.maintenance_save_schedule", "public.maintenance_create_work_order",
  "public.maintenance_update_work_order", "public.maintenance_set_status", "public.maintenance_start_inspection",
  "public.maintenance_record_clearance", "public.maintenance_generate_due", "public.driver_maintenance_notices",
  "public.maintenance_pm_status", "public.maintenance_assignee_options",
  // Profile self-service (20261030000100): own row only; photos only within the caller's current company.
  "public.my_profile", "public.update_my_profile", "public.set_my_photo", "public.profile_photo", "public.profile_photo_versions",
  // Employees (20261031000100): compensation audit without amounts; primary truck needs fleet.assign, same company.
  "private.audit_compensation_change", "public.set_driver_primary_truck",
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
  "private.operational_exceptions", "private.require_command_center", "private.demo_person_name", "public.command_center_summary",
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
  "public.save_my_preference", "public.hide_exception", "public.unhide_exception", "public.dismiss_demo_welcome",
  // AI usage ledger (docs/AI.md §6).
  "public.record_ai_usage", "public.ai_usage_summary",
  // N11: office scans of paper tickets.
  "public.begin_ticket_scan", "public.attach_ticket_scan",
  // N12: early-access site gate (service role only).
  "public.site_access_revoke_grants", "public.site_access_redeem", "public.site_access_validate",
  // Shared early-access password (service role only).
  "public.site_access_enter_shared", "public.site_access_revoke_grant",
  // N13: platform owner (every function checks private.require_platform_admin, or is service-role only), leads, demo, imports.
  "private.is_platform_admin", "private.require_platform_admin", "private.platform_log",
  "public.platform_whoami", "public.platform_admin_grant", "public.platform_admin_revoke", "public.platform_admin_list",
  "public.platform_team", "public.platform_audit_recent", "public.lead_submit", "public.lead_record_email", "public.platform_leads", "public.platform_lead",
  "public.platform_lead_update", "public.platform_lead_note", "public.platform_overview", "public.platform_demo_start",
  "public.platform_demo_enter", "public.platform_companies", "public.platform_create_company", "public.platform_import_stage",
  "public.platform_import_batches", "public.platform_import_batch", "public.platform_import_decide", "public.platform_import_discard",
  "public.platform_import_approve", "public.platform_import_revert",
  // N15: capacity check in assign_load, quote acceptance creates its order, Smart Dispatch rejections.
  "private.load_capacity_problem", "private.create_order_from_quote", "private.quote_accepted_create_order",
  "public.reject_dispatch_recommendation", "public.reconsider_dispatch_recommendations",
];

/**
 * Public functions that take a company id on purpose. switch_company only
 * accepts companies where the caller has an active membership (tested in
 * tests/db/onboarding.test.ts). The platform import functions are for the
 * platform team only (private.require_platform_admin; tested in
 * tests/db/platform.test.ts) and refuse demo and inactive companies.
 */
// platform_prospect_demo_add_owner (service role) and _retire (platform admins): refuse every company that is not an active prospect demo.
const COMPANY_ID_ARGUMENT_REVIEWED = ["public.switch_company", "public.platform_import_stage", "public.platform_import_batches", "public.platform_prospect_demo_add_owner", "public.platform_prospect_demo_retire"];

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
        "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and relname not in ('companies', 'profiles', 'permissions', 'role_permission_defaults', 'alert_event_types') order by 1",
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
      // Only the order its own acceptance created (N15); the other company's attempt added nothing.
      expect((await s.query("select 1 from public.orders where source_quote_id = $1", [w.tlAcceptedQuote])).rowCount).toBe(1);
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
      const dup = await s.query<{ n: number }>("select count(distinct company_id)::int as n from public.customers where customer_number = 'C-00001' and company_id in ($1, $2)", [TOP_LINE, w.B]);
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
