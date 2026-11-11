import { AccountantAccess, type AccountantRow } from "@/components/settings/accountant-access";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, BookOpenCheck, LifeBuoy, Calculator, CalendarDays, CalendarPlus, Navigation, Receipt, Database, Hash, Lock, Mail, MapPin, Route, ScrollText, Upload, Users, type LucideIcon } from "lucide-react";
import {
  BrandingForm,
  CompanySettingsForm,
  PermissionsMatrix,
  SampleDataPanel,
  SequencesPanel,
  type SequenceRow,
} from "@/components/settings/settings-client";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import { can, type Access, type AppRole } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { emailStatusSummary } from "@/server/email/provider";
import { getUserNames } from "@/server/data/quotes";
import { SupportAccess, type SupportStatus } from "@/components/settings/support-access";
import { SupportRequests, type SupportRequestRow } from "@/components/settings/support-requests";
import { businessToday, getSettings } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";
import { documentRules } from "@/server/data/fleet";
import { DocumentRulesForm } from "@/components/settings/document-rules-form";
import { CostRatesForm } from "@/components/settings/cost-rates-form";
import { TruckHealthForm } from "@/components/settings/truck-health-form";
import { DailySummaryForm } from "@/components/settings/daily-summary-form";
import { IndustryForm } from "@/components/settings/industry-form";
import { MenuAreasForm } from "@/components/settings/menu-areas-form";
import { hiddenAreasOf } from "@/lib/menu-areas";
import { industryOf } from "@/lib/industry";
import { summaryLines, type DailySummary } from "@/lib/summary/daily";
import { parseRules } from "@/lib/fleet/health";
import { ApprovalChainForm } from "@/components/settings/approval-chain-form";
import { approvalChain } from "@/server/data/time-off";
import { BasesPanel } from "@/components/settings/bases-panel";
import { CompanyMfaPolicyForm } from "@/components/security/company-mfa-policy";
import { MfaWho } from "@/components/security/mfa-who";
import { moneyRoles } from "@/lib/mfa-policy";
import { baseAllowance, baseMembers, baseSummary, listBases } from "@/server/data/bases";
import { listSignIns } from "@/server/data/people";
import { ImportUploader } from "@/components/admin/import-uploader";
import { ENTITY_LABELS, type ImportEntity } from "@/lib/platform/imports";
import { stageCompanyImport } from "./import/actions";
import { shiftOfferMode } from "@/server/data/shift-offers";
import { invoicingSettings } from "@/server/data/invoices";
import { telematicsStatus } from "@/server/data/telematics";
import { waitTimeSettings } from "@/server/data/wait-times";
import { WaitTimeForm } from "@/components/settings/wait-time-form";
import { env } from "@/server/env";
import { TelematicsSettingsForm } from "@/components/fleet/telematics";
import { saveBillingTolerance, saveCreditHoldSettings, saveInvoicingSettings } from "../billing/invoices/actions";
import { saveTruckHoursSettings } from "../dispatch/truck-day-actions";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { ShiftOfferModeForm } from "@/components/schedule/shift-offers";
import { getSay } from "@/server/industry";

const BASE_SAVED: Record<string, string> = {
  created: "Base added.",
  updated: "Base saved.",
  activated: "Base reactivated.",
  deactivated: "Base deactivated. Its trucks, drivers and orders are unchanged.",
  default: "Default base changed. New trucks, drivers and orders without a base go there.",
  access: "Base access saved.",
  cross_on: "Cross-base dispatch is on. Smart Dispatch may now propose trucks and drivers from other bases, with a warning.",
  cross_off: "Cross-base dispatch is off. Smart Dispatch proposes only the order's own base.",
};

export const metadata = { title: "Settings" };

type CompanyImportSummary = { id: string; entity: string; status: string; file_name: string; created_at: string; created_by: string | null; rows: number; to_import: number; result: { created?: number } | null };
const IMPORT_STATUS: Record<string, { label: string; tone: "amber" | "green" | "gray" }> = {
  review: { label: "In review", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  reverted: { label: "Reverted", tone: "gray" },
  discarded: { label: "Discarded", tone: "gray" },
  deactivated: { label: "Undone", tone: "gray" },
};

const TAB_ICONS: Record<string, LucideIcon> = {
  company: Building2, numbering: Hash, costs: Calculator, invoicing: Receipt, email: Mail, dispatch: Route, bases: MapPin, "time-off": CalendarDays,
  permissions: Users, accountants: BookOpenCheck, support: LifeBuoy, security: Lock, sample: Database, import: Upload, "shift-offers": CalendarPlus, gps: Navigation, audit: ScrollText,
};

type Group = "Company" | "Operations" | "Access" | "System";

/** Four groups (owner 2026-10-14); the tab keys stay the same so existing links keep working. */
const TABS: Array<{ key: string; label: string; group: Group; visible: (a: Access) => boolean }> = [
  { key: "company", label: "Company and branding", group: "Company", visible: () => true },
  { key: "numbering", label: "Numbering", group: "Company", visible: (a) => can(a, "settings.manage") },
  { key: "email", label: "Email", group: "Company", visible: () => true },
  { key: "dispatch", label: "Dispatch rules", group: "Operations", visible: (a) => can(a, "settings.manage") || can(a, "dispatch.view") },
  { key: "bases", label: "Dispatch Bases", group: "Operations", visible: (a) => can(a, "settings.manage") || can(a, "users.manage") || can(a, "dispatch.view") },
  { key: "time-off", label: "Time off", group: "Operations", visible: (a) => can(a, "settings.manage") },
  { key: "shift-offers", label: "Shift offers", group: "Operations", visible: (a) => can(a, "settings.manage") },
  { key: "gps", label: "GPS and hours", group: "Operations", visible: (a) => can(a, "settings.manage") },
  { key: "costs", label: "Cost rates", group: "Operations", visible: (a) => can(a, "billing.view") },
  { key: "invoicing", label: "Invoicing", group: "Company", visible: (a) => can(a, "billing.view") },
  { key: "permissions", label: "Roles and permissions", group: "Access", visible: (a) => can(a, "users.manage") },
  { key: "accountants", label: "Accountant access", group: "Access", visible: (a) => a.role === "owner" },
  { key: "support", label: "Taviron support", group: "Access", visible: (a) => a.role === "owner" },
  { key: "security", label: "Security", group: "Access", visible: (a) => can(a, "settings.manage") },
  { key: "sample", label: "Sample data", group: "System", visible: (a) => can(a, "settings.manage") },
  { key: "import", label: "Import", group: "System", visible: (a) => can(a, "settings.manage") },
  { key: "audit", label: "Audit log", group: "System", visible: (a) => can(a, "audit.view") },
];
const GROUPS: Group[] = ["Company", "Operations", "Access", "System"];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string; saved?: string; error?: string }> }) {
  const say = await getSay();
  const access = await requireAccess();
  const { tab: rawTab, saved, error: actionError } = await searchParams;
  // Sign-ins and roles live on People now (owner 2026-10-14); old links keep working.
  if (rawTab === "users") redirect("/employees?view=access");
  // My account is the profile page now (the profile menu's My profile).
  if (rawTab === "account") redirect("/profile");
  const tabs = TABS.filter((t) => t.visible(access));
  const tab = tabs.find((t) => t.key === rawTab)?.key ?? "company";
  const group = TABS.find((t) => t.key === tab)!.group;
  const groups = GROUPS.map((g) => ({ g, first: tabs.find((t) => t.group === g) })).filter((x) => x.first);
  const inGroup = tabs.filter((t) => t.group === group);
  const supabase = await createClient();
  const { timezone, today } = await businessToday();

  let content: React.ReactNode = null;

  if (tab === "company") {
    const settings = await getSettings();
    content = (
      <>
        <CompanySettingsForm settings={settings} canEdit={can(access, "settings.manage")} />
        {"industry" in settings && (
          <div className="border-t border-line">
            <IndustryForm industry={industryOf(settings.industry)} canEdit={can(access, "settings.manage")} />
          </div>
        )}
        {"hidden_areas" in settings && (
          <div className="border-t border-line">
            <MenuAreasForm hidden={hiddenAreasOf(settings.hidden_areas)} canEdit={can(access, "settings.manage")} />
          </div>
        )}
        <div className="border-t border-line">
          <BrandingForm settings={settings} canEdit={can(access, "settings.manage")} companyId={access.companyId!} />
        </div>
      </>
    );
  } else if (tab === "costs") {
    // The cost per empty mile (B113, 20261120005300) when installed; otherwise the three original rates.
    const withMile = await supabase.from("company_cost_rates").select("truck_hour_cents, driver_hour_cents, per_load_cents, empty_mile_cents").maybeSingle();
    const mileSupported = !withMile.error;
    const rates = mileSupported ? withMile : await supabase.from("company_cost_rates").select("truck_hour_cents, driver_hour_cents, per_load_cents").maybeSingle();
    content = (
      <>
        <CardHeader
          title="Cost rates"
          description="Your own costs, used for profit per load in Reports: each delivered load's planned hours × the truck and driver rates, plus the fixed amount per load. Profit is an estimate; a rate left empty counts as nothing, and with no rates no profit is shown."
        />
        <CardBody>
          {rates.error ? <p className="text-sm text-muted">Cost rates need a database update that has not been installed yet.</p> : <CostRatesForm rates={rates.data ?? null} canEdit={can(access, "billing.manage")} mileSupported={mileSupported} />}
        </CardBody>
      </>
    );
  } else if (tab === "dispatch") {
    const [rules, health, wait] = await Promise.all([documentRules(), supabase.from("company_settings").select("truck_health_rules").maybeSingle(), waitTimeSettings()]);
    content = (
      <>
        <CardHeader
          title="Expired vehicle documents"
          description="What an expired document does to dispatch, per kind. Only a document someone marked verified in Fleet can block; an unverified one is a warning so a person confirms the renewal. Lease, title and other documents are not checked. Check the rules that apply where you operate."
        />
        <CardBody>
          {rules ? <DocumentRulesForm rules={rules} canEdit={can(access, "settings.manage")} /> : <p className="text-sm text-muted">Document rules need a database update that has not been installed yet. Until then expired documents are review notes only.</p>}
        </CardBody>
        <CardHeader
          title="Truck health"
          description="When a truck reads Watch or At risk on Maintenance and Fleet. An open safety-critical defect or Out of service is always At risk; these rules add the rest. The level is information: only safety restrictions block dispatch."
        />
        <CardBody>
          {health.error ? <p className="text-sm text-muted">Truck health needs a database update that has not been installed yet.</p> : <TruckHealthForm rules={parseRules((health.data as { truck_health_rules?: unknown } | null)?.truck_health_rules)} canEdit={can(access, "settings.manage")} />}
        </CardBody>
        <CardHeader
          title="Wait times"
          description={say("How long a truck may wait at a pickup or job site before Reports → Wait times flags it. Drivers tap Arrived and Left on My Day. Nothing is billed.")}
        />
        <CardBody>
          {wait.installed ? <WaitTimeForm freeMinutes={wait.freeMinutes} canEdit={can(access, "settings.manage")} /> : <p className="text-sm text-muted">Wait times need a database update that has not been installed yet.</p>}
        </CardBody>
      </>
    );
  } else if (tab === "bases") {
    const bases = await listBases();
    if (!bases) {
      content = (
        <CardBody>
          <Notice title="Needs a database update">Dispatch bases need a database update that has not been installed yet. Until then the company works as one base.</Notice>
        </CardBody>
      );
    } else {
      const monthStart = `${today.slice(0, 8)}01`;
      const [summary, allowance, members, people, cross] = await Promise.all([
        baseSummary(monthStart, today),
        baseAllowance(),
        can(access, "users.manage") ? baseMembers() : Promise.resolve(null),
        can(access, "users.manage") ? listSignIns(access.companyId!) : Promise.resolve([]),
        supabase.from("company_settings").select("cross_base_dispatch").maybeSingle(),
      ]);
      content = <BasesPanel bases={bases} summary={summary} allowance={allowance} people={people} access={members} canEdit={can(access, "settings.manage")} canManagePeople={can(access, "users.manage")} crossBase={cross.error ? null : Boolean((cross.data as { cross_base_dispatch?: boolean } | null)?.cross_base_dispatch)} />;
    }
  } else if (tab === "time-off") {
    const chain = await approvalChain();
    content = (
      <>
        <CardHeader
          title="Time-off approval chain"
          description="Who decides a time-off request, in order. Each step is decided by someone in that role who also has the time-off approval permission; only the last step approves and uses hours from the balance; a denial at any step ends the request. Nobody decides their own request. Saving a new chain restarts pending requests at step 1."
        />
        <CardBody>
          {chain ? <ApprovalChainForm steps={chain.map((c) => ({ role: c.role, label: c.label }))} canEdit={can(access, "settings.manage")} /> : <p className="text-sm text-muted">Approval chains need a database update that has not been installed yet. Until then one approval decides each request.</p>}
        </CardBody>
      </>
    );
  } else if (tab === "accountants") {
    // Accountant access (B134): owners only; empty before 20261120006300 is installed.
    const list = await supabase.rpc("accountant_list");
    const [ty, tm, td] = today.split("-").map(Number);
    const defaultEnd = `${tm < 4 || (tm === 4 && td <= 15) ? ty : ty + 1}-04-15`;
    content = (
      <>
        <CardHeader
          title="Accountant access"
          description="Let your outside accountant look through the company's financials during tax season: read-only, until the date you choose. You can extend it or end it at any time, and every visit is recorded."
        />
        <CardBody>
          {list.error ? <Notice title="Not available yet">Accountant access needs a database update that has not been installed yet.</Notice> : (
            <AccountantAccess rows={(list.data ?? []) as AccountantRow[]} today={today} timezone={timezone} defaultEnd={defaultEnd} demo={Boolean(access.isDemo)} companyName={access.companyName ?? "Your company"} />
          )}
        </CardBody>
      </>
    );
  } else if (tab === "support") {
    // Taviron support access (SA1): owners only; "not available yet" before 20261120008900 is installed.
    const [st, reqs] = await Promise.all([supabase.rpc("support_access_status"), supabase.rpc("support_change_requests")]);
    content = (
      <>
        <CardHeader title="Taviron support" description="Let the Taviron team into your account to help or fix something for you: for 1, 3 or 7 days, ended by you at any time. Every visit and change is recorded." />
        <CardBody>
          {st.error ? <Notice title="Not available yet">Taviron support access needs a database update that has not been installed yet.</Notice> : (
            <div className="space-y-8">
              {/* Changes Taviron support asked for (SA2); hidden until 20261120009200 is installed. */}
              {!reqs.error && <SupportRequests requests={(reqs.data ?? []) as SupportRequestRow[]} canDecide={!access.support} timezone={timezone} />}
              <SupportAccess status={st.data as SupportStatus} timezone={timezone} canChange={!access.support} companyName={access.companyName ?? "Your company"} />
            </div>
          )}
        </CardBody>
      </>
    );
  } else if (tab === "security") {
    // Who must use it (walkthrough 2026-11-11): the roles holding a money permission here, and their people for those
    // who manage users (the same rule as the database, private.money_mfa_required).
    const peopleShown = can(access, "users.manage") && Boolean(access.companyId);
    const [{ data, error }, { data: grants }, people] = await Promise.all([
      supabase.from("company_settings").select("require_mfa").maybeSingle(),
      supabase.from("role_permissions").select("role, permission"),
      peopleShown ? listSignIns(access.companyId!) : Promise.resolve([]),
    ]);
    const roles = moneyRoles((grants ?? []) as Array<{ role: AppRole; permission: string }>, people.map((p) => ({ id: p.id, name: p.full_name || p.email, role: p.role as AppRole | null, active: p.active })));
    content = (
      <>
        <CardHeader title="Two-step verification" description="A code from an authenticator app after the password. Some people must always use it; you can require it for everyone." />
        <CardBody className="space-y-5">
          {error ? (
            <p className="text-sm text-muted">Two-step verification needs a database update that has not been installed yet (20261120000900). Until then nobody is asked for a code.</p>
          ) : (
            <>
              <MfaWho roles={roles} demo={Boolean(access.isDemo)} peopleShown={peopleShown} />
              <CompanyMfaPolicyForm required={Boolean((data as { require_mfa?: boolean } | null)?.require_mfa)} canEdit={can(access, "settings.manage")} />
            </>
          )}
        </CardBody>
      </>
    );
  } else if (tab === "numbering") {
    const { data } = await supabase.from("document_sequences").select("*").order("key");
    content = <SequencesPanel rows={(data ?? []) as SequenceRow[]} year={Number(today.slice(0, 4))} />;
  } else if (tab === "permissions") {
    const [{ data: perms }, { data: grants }] = await Promise.all([
      supabase.from("permissions").select("*").order("category").order("code"),
      supabase.from("role_permissions").select("role, permission"),
    ]);
    const granted: Record<string, string[]> = {};
    for (const g of grants ?? []) (granted[g.role] ??= []).push(g.permission);
    content = <PermissionsMatrix permissions={perms ?? []} granted={granted} />;
  } else if (tab === "email") {
    const status = emailStatusSummary();
    // End-of-day owner summary (B97): settings, today's figures as they stand, and the last sends.
    const [ds, preview, log] = await Promise.all([
      supabase.from("company_settings").select("daily_summary_enabled, daily_summary_hour").maybeSingle(),
      supabase.rpc("my_daily_summary", { p_day: today }),
      supabase.from("daily_summary_log").select("day, status, recipients").order("day", { ascending: false }).limit(5),
    ]);
    const dsRow = ds.error ? null : (ds.data as { daily_summary_enabled: boolean; daily_summary_hour: number } | null);
    content = (
      <>
        <CardHeader title="Email delivery" description="How quote emails are handled. Configured by environment variables on the server." />
        <CardBody className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Mode:</span>
            {status.mode === "live" ? <Badge tone="green">Live</Badge> : status.mode === "test" ? <Badge tone="amber">Test</Badge> : <Badge>Preview only</Badge>}
          </div>
          <p>{status.description}</p>
          {status.from && <p className="text-sm text-muted">From: {status.from}</p>}
          {status.mode !== "live" && (
            <Notice title="To send real emails">
              Create a Resend account, verify your sending domain, then set <code>EMAIL_PROVIDER=resend</code>, <code>RESEND_API_KEY</code> and{" "}
              <code>EMAIL_FROM</code> on the server. Use <code>EMAIL_TEST_RECIPIENT</code> first to send everything to a test inbox. See docs/SETUP.md.
            </Notice>
          )}
        </CardBody>
        <CardHeader
          title="End-of-day summary"
          description={access.isDemo ? "Demo companies never send it; the figures below are what it would say today." : say("One short email a day to the company's owners: loads delivered, tickets missing or waiting, trucks down, open driver reports and tomorrow's loads without a truck. Counts only. Text messages come once Twilio is set up.")}
        />
        <CardBody className="space-y-4">
          {dsRow ? (
            <>
              <DailySummaryForm enabled={dsRow.daily_summary_enabled} hour={dsRow.daily_summary_hour} canEdit={can(access, "settings.manage")} demo={Boolean(access.isDemo)} />
              <p className="text-xs text-muted">Sent with the evening run (about 6 PM Central on the current hosting plan), once the chosen hour has passed; never twice a day.</p>
              {preview.data ? (
                <div className="rounded-xl bg-surface px-4 py-3 text-sm">
                  <p className="font-semibold">Today so far</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">{summaryLines(preview.data as DailySummary).map((l) => <li key={l}>{l}</li>)}</ul>
                </div>
              ) : null}
              {(log.data ?? []).length ? (
                <p className="text-xs text-muted">Last sends: {((log.data ?? []) as Array<{ day: string; status: string; recipients: number }>).map((l) => `${l.day} ${l.status === "sent" ? `sent to ${l.recipients}` : l.status.replace("_", " ")}`).join(" · ")}</p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted">The end-of-day summary needs a database update that has not been installed yet.</p>
          )}
        </CardBody>
      </>
    );
  } else if (tab === "gps") {
    const gps = await telematicsStatus();
    content = (
      <>
        <CardHeader
          title="GPS and hours of service"
          description="Where truck positions and drivers' hours come from. They appear on Fleet → Locations and hours with their age and source. Nothing is estimated."
        />
        <CardBody>
          {!gps.installed ? (
            <p className="text-sm text-muted">GPS and hours need a database update that has not been installed yet.</p>
          ) : (
            <TelematicsSettingsForm source={gps.source} staleMinutes={gps.staleMinutes} keyHint={gps.feedKeyHint} canEdit={can(access, "settings.manage")} endpoint={`${env().APP_BASE_URL}/api/telematics/ingest`} />
          )}
        </CardBody>
      </>
    );
  } else if (tab === "sample") {
    const { data } = await supabase.rpc("sample_data_counts");
    content = <SampleDataPanel counts={(data ?? {}) as Record<string, number>} />;
  } else if (tab === "invoicing") {
    const inv = await invoicingSettings();
    // Credit holds (B128): null until that update is installed.
    const credit = await supabase.from("credit_hold_settings").select("overdue_days").maybeSingle();
    const tolerance = await supabase.from("billing_tolerance_settings").select("percent").maybeSingle();
    // Truck-hours (UX11): an error means 20261120008600 is not installed; no row means off.
    const truckHours = await supabase.from("truck_hours_settings").select("basis, minimum_hours, shortfall").maybeSingle();
    const th = (truckHours.data ?? null) as { basis: string | null; minimum_hours: number | string | null; shortfall: string } | null;
    const edit = can(access, "billing.manage");
    content = (
      <>
        <CardHeader
          title="Invoicing"
          description="Who issues your invoices. QuickBooks: handed-off orders are sent to QuickBooks and invoiced there. Taviron: you create, issue and email invoices here, with your logo and colour, and record payments; nothing goes to QuickBooks for those orders."
        />
        <CardBody>
          {!inv.installed ? (
            <p className="text-sm text-muted">Invoicing needs a database update that has not been installed yet.</p>
          ) : (
            <form action={saveInvoicingSettings} className="max-w-xl space-y-4" aria-label="Invoicing">
              <fieldset className="space-y-2" disabled={!edit}>
                <legend className="mb-1 text-sm font-medium">Invoices are issued by</legend>
                {([["quickbooks", "QuickBooks", "Send handed-off orders to QuickBooks (Billing → Businesses and QuickBooks)."], ["taviron", "Taviron", "Create, issue and email invoices from Taviron and track what each customer owes."]] as const).map(([v, label, hint]) => (
                  <label key={v} className="flex items-start gap-3 rounded-control border border-line p-3 has-[:checked]:border-strong has-[:checked]:bg-surface">
                    <input type="radio" name="issuer" value={v} defaultChecked={inv.issuer === v} className="mt-1 size-4 accent-brand" />
                    <span><span className="block font-medium">{label}</span><span className="block text-sm text-muted">{hint}</span></span>
                  </label>
                ))}
              </fieldset>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Payment terms (days)" htmlFor="terms_days" hint="0 = due on receipt"><Input id="terms_days" name="terms_days" inputMode="numeric" defaultValue={String(inv.termsDays)} disabled={!edit} /></Field>
              </div>
              <Field label="Footer on invoices" htmlFor="footer" hint="For example how to pay, or a thank-you"><Textarea id="footer" name="footer" rows={3} maxLength={500} defaultValue={inv.footer} disabled={!edit} /></Field>
              {edit && <SubmitButton>Save</SubmitButton>}
            </form>
          )}
          {!credit.error && (
            <form action={saveCreditHoldSettings} className="mt-8 max-w-xl space-y-3 border-t border-line pt-6" aria-label="Credit holds">
              <h3 className="text-base font-semibold text-ink">Credit holds</h3>
              <p className="text-sm text-muted">A customer goes on credit hold when an issued Taviron invoice is more than this many days past due (or their open balance is over the credit limit on their page). New orders and dispatch for them are never blocked: whoever goes ahead gives a reason, which is recorded.</p>
              <Field label="Days past due" htmlFor="overdue_days" hint="Empty: off. Holds put on by hand always apply."><Input id="overdue_days" name="overdue_days" inputMode="numeric" defaultValue={(credit.data as { overdue_days: number | null } | null)?.overdue_days?.toString() ?? ""} disabled={!edit} className="max-w-28" /></Field>
              {edit && <SubmitButton>Save</SubmitButton>}
            </form>
          )}
          {!tolerance.error && (
            <form action={saveBillingTolerance} className="mt-8 max-w-xl space-y-3 border-t border-line pt-6" aria-label="Billing tolerance">
              <h3 className="text-base font-semibold text-ink">Billing tolerance</h3>
              <p className="text-sm text-muted">{say("Scale weights rarely match the plan exactly. A difference between the tickets and the planned or ordered quantity within this percentage is not a billing exception; a larger one still is, and different units, missing tickets and zero rates always are. Empty: tickets must match exactly.")}</p>
              <Field label="Allowed difference (%)" htmlFor="tolerance_percent" hint="Above 0 and up to 10, for example 1 or 2.5. Your company chooses the number."><Input id="tolerance_percent" name="tolerance_percent" inputMode="decimal" defaultValue={(tolerance.data as { percent: number | string | null } | null)?.percent?.toString() ?? ""} disabled={!edit} className="max-w-28" /></Field>
              {edit && <SubmitButton>Save</SubmitButton>}
            </form>
          )}
          {!truckHours.error && (
            <form action={saveTruckHoursSettings} className="mt-8 max-w-xl space-y-3 border-t border-line pt-6" aria-label="Truck-hours">
              <h3 className="text-base font-semibold text-ink">Trucks for the day: which hours count</h3>
              <p className="text-sm text-muted">For orders billed by truck-hours. Off until you choose: Taviron never picks the rule. Hours end when the truck is released (by dispatch, its driver or the customer&apos;s site contact).</p>
              <Field label="Hours count from" htmlFor="th_basis">
                <Select id="th_basis" name="basis" defaultValue={th?.basis ?? ""} disabled={!edit} className="max-w-sm">
                  <option value="">Off (no truck-hours)</option>
                  <option value="scheduled">The scheduled start</option>
                  <option value="arrived">The driver&apos;s recorded arrival</option>
                </Select>
              </Field>
              <Field label="Minimum hours per truck" htmlFor="th_minimum" hint="Optional. Above 0 and up to 24, for example 4."><Input id="th_minimum" name="minimum" inputMode="decimal" defaultValue={th?.minimum_hours != null ? String(Number(th.minimum_hours)) : ""} disabled={!edit} className="max-w-28" /></Field>
              <Field label="A truck released before the minimum" htmlFor="th_shortfall">
                <Select id="th_shortfall" name="shortfall" defaultValue={th?.shortfall ?? "review"} disabled={!edit} className="max-w-sm">
                  <option value="review">Flag it for review (bill the hours worked)</option>
                  <option value="bill_minimum">Bill the minimum</option>
                </Select>
              </Field>
              {edit && <SubmitButton>Save</SubmitButton>}
            </form>
          )}
        </CardBody>
      </>
    );
  } else if (tab === "shift-offers") {
    const { installed, mode } = await shiftOfferMode();
    content = (
      <>
        <CardHeader
          title="Shift offers"
          description="How an extra shift offered on the Schedule is filled. Whatever you choose, Taviron checks that the person is in the right group, is not already working that day and is not on approved time off, both when they answer and right before the shift is written. Changing this never changes offers already out."
        />
        <CardBody>
          {installed ? <ShiftOfferModeForm mode={mode} canEdit={can(access, "settings.manage")} /> : <p className="text-sm text-muted">Shift offers need a database update that has not been installed yet.</p>}
        </CardBody>
      </>
    );
  } else if (tab === "import") {
    const { data, error } = await supabase.rpc("company_import_batches");
    const batches = (data ?? []) as CompanyImportSummary[];
    content = (
      <>
        <CardHeader
          title="Import from a spreadsheet"
          description="Bring in customers, materials, trucks or drivers from a CSV file. Nothing is created until you review every row and approve; rows that need fixing are never imported, and an approved import can be undone (its records become inactive, never deleted)."
        />
        <CardBody>
          {error ? <p className="text-sm text-muted">Importing needs a database update that has not been installed yet.</p> : <ImportUploader action={stageCompanyImport} />}
        </CardBody>
        {!error && batches.length > 0 && (
          <>
            <CardHeader title="Imports" />
            <TableWrap>
              <Table aria-label="Imports">
                <thead>
                  <tr><Th>File</Th><Th>Records</Th><Th className="hidden md:table-cell">By</Th><Th>Status</Th></tr>
                </thead>
                <tbody>
                  {batches.map((b) => {
                    const st = IMPORT_STATUS[b.status] ?? { label: b.status, tone: "gray" as const };
                    const created = typeof b.result?.created === "number" ? b.result.created : null;
                    return (
                      <Tr key={b.id}>
                        <Td>
                          <Link href={`/settings/import/${b.id}`} className="font-medium text-brand-fg hover:underline">{b.file_name || "Spreadsheet"}</Link>
                          <div className="text-xs text-muted">{formatDateTime(b.created_at, timezone)}</div>
                        </Td>
                        <Td className="text-sm">
                          {ENTITY_LABELS[b.entity as ImportEntity] ?? b.entity}
                          <div className="text-xs text-muted tabular">{b.status === "review" ? `${b.to_import} of ${b.rows} to import` : created != null ? `${created} created` : `${b.rows} rows`}</div>
                        </Td>
                        <Td className="hidden text-sm md:table-cell">{b.created_by ?? "–"}</Td>
                        <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
          </>
        )}
      </>
    );
  } else if (tab === "audit") {
    const [{ data }, names] = await Promise.all([
      supabase.from("audit_events").select("*").order("occurred_at", { ascending: false }).limit(200),
      getUserNames(),
    ]);
    const rows = (data ?? []) as Array<{ id: string; occurred_at: string; actor_id: string | null; action: string; entity_type: string; entity_id: string | null; summary: string; details: Record<string, unknown> }>;
    content = (
      <>
        <CardHeader title="Audit log" description="Latest 200 changes. Entries cannot be edited or deleted." />
        <TableWrap>
          <Table>
            <thead>
              <tr><Th>When</Th><Th>Who</Th><Th>What</Th><Th className="hidden lg:table-cell">Details</Th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td className="text-sm whitespace-nowrap">{formatDateTime(r.occurred_at, timezone)}</Td>
                  <Td className="text-sm">{r.actor_id ? names[r.actor_id] ?? "Former user" : "System"}</Td>
                  <Td>
                    <div className="text-sm">{r.summary}</div>
                    <div className="font-mono text-xs text-muted">{r.action}</div>
                  </Td>
                  <Td className="hidden max-w-md lg:table-cell">
                    <code className="line-clamp-3 text-xs break-all text-muted">{JSON.stringify(r.details)}</code>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Settings" />
      {saved && tab === "bases" ? <div className="mb-3"><Notice title="Saved">{BASE_SAVED[saved] ?? "Saved."}</Notice></div> : null}
      {saved === "invoicing" && tab === "invoicing" ? <div className="mb-3"><Notice title="Saved">Invoicing settings saved. New invoices use them; issued invoices keep theirs.</Notice></div> : null}
      {actionError ? <div className="mb-3"><Notice tone="warning" title="Not saved">{actionError}</Notice></div> : null}
      <div className="lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-start lg:gap-6">
      {/* Wide screens: one grouped menu (owner's references 2026-10-27); phones and tablets keep the two pill rows. */}
      <nav aria-label="Settings menu" className="sticky top-20 hidden space-y-5 lg:block">
        {groups.map(({ g }) => (
          <div key={g}>
            <p className="mb-1.5 px-3 text-xs font-medium text-muted">{g}</p>
            <ul className="space-y-0.5">
              {tabs.filter((t) => t.group === g).map((t) => {
                const Icon = TAB_ICONS[t.key] ?? Building2;
                return (
                  <li key={t.key}>
                    <Link
                      href={`/settings?tab=${t.key}`}
                      aria-current={tab === t.key ? "page" : undefined}
                      className={cn("flex h-9 items-center gap-2.5 rounded-control px-3 text-sm font-medium transition-colors", tab === t.key ? "bg-card text-ink shadow-xs ring-1 ring-line/60" : "text-muted hover:bg-ink/[0.04] hover:text-ink")}
                    >
                      <Icon className={cn("size-4 shrink-0", tab === t.key ? "text-brand-fg" : "")} aria-hidden />
                      <span className="truncate">{t.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="min-w-0">
      <nav aria-label="Settings groups" className="mb-3 flex lg:hidden w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.05] p-1">
        {groups.map(({ g, first }) => (
          <Link
            key={g}
            href={`/settings?tab=${first!.key}`}
            aria-current={group === g ? "page" : undefined}
            className={cn("flex h-8 items-center gap-1.5 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors duration-150", group === g ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink")}
          >
            <span className="pill-text">{g}</span>
          </Link>
        ))}
      </nav>
      {inGroup.length > 1 && (
        <nav aria-label="Settings sections" className="mb-4 flex flex-wrap gap-1.5 lg:hidden">
          {inGroup.map((t) => (
            <Link
              key={t.key}
              href={`/settings?tab=${t.key}`}
              aria-current={tab === t.key ? "page" : undefined}
              className={cn("inline-flex h-8 items-center rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors", tab === t.key ? "bg-ink/[0.07] text-ink" : "text-muted hover:text-ink")}
            >
              <span className="pill-text">{t.label}</span>
            </Link>
          ))}
        </nav>
      )}
      {!can(access, "settings.manage") ? (
        <p className="mb-3 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink">
          You can view these settings. Changing them needs the company settings permission (an owner or administrator).
        </p>
      ) : null}
      <Card>{content}</Card>
      </div>
      </div>
    </>
  );
}
