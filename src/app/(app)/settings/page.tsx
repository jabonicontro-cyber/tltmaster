import Link from "next/link";
import { redirect } from "next/navigation";
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
import { can, type Access } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { emailStatusSummary } from "@/server/email/provider";
import { getUserNames } from "@/server/data/quotes";
import { businessToday, getSettings } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";
import { documentRules } from "@/server/data/fleet";
import { DocumentRulesForm } from "@/components/settings/document-rules-form";
import { ApprovalChainForm } from "@/components/settings/approval-chain-form";
import { approvalChain } from "@/server/data/time-off";
import { BasesPanel } from "@/components/settings/bases-panel";
import { CompanyMfaPolicyForm } from "@/components/security/company-mfa-policy";
import { baseAllowance, baseMembers, baseSummary, listBases } from "@/server/data/bases";
import { listSignIns } from "@/server/data/people";

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

type Group = "Company" | "Operations" | "Access" | "System";

/** Four groups (owner 2026-10-14); the tab keys stay the same so existing links keep working. */
const TABS: Array<{ key: string; label: string; group: Group; visible: (a: Access) => boolean }> = [
  { key: "company", label: "Company and branding", group: "Company", visible: () => true },
  { key: "numbering", label: "Numbering", group: "Company", visible: (a) => can(a, "settings.manage") },
  { key: "email", label: "Email", group: "Company", visible: () => true },
  { key: "dispatch", label: "Dispatch rules", group: "Operations", visible: (a) => can(a, "settings.manage") || can(a, "dispatch.view") },
  { key: "bases", label: "Dispatch Bases", group: "Operations", visible: (a) => can(a, "settings.manage") || can(a, "users.manage") || can(a, "dispatch.view") },
  { key: "time-off", label: "Time off", group: "Operations", visible: (a) => can(a, "settings.manage") },
  { key: "permissions", label: "Roles and permissions", group: "Access", visible: (a) => can(a, "users.manage") },
  { key: "security", label: "Security", group: "Access", visible: (a) => can(a, "settings.manage") },
  { key: "sample", label: "Sample data", group: "System", visible: (a) => can(a, "settings.manage") },
  { key: "audit", label: "Audit log", group: "System", visible: (a) => can(a, "audit.view") },
];
const GROUPS: Group[] = ["Company", "Operations", "Access", "System"];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string; saved?: string; error?: string }> }) {
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
        <div className="border-t border-line">
          <BrandingForm settings={settings} canEdit={can(access, "settings.manage")} companyId={access.companyId!} />
        </div>
      </>
    );
  } else if (tab === "dispatch") {
    const rules = await documentRules();
    content = (
      <>
        <CardHeader
          title="Expired vehicle documents"
          description="What an expired document does to dispatch, per kind. Only a document someone marked verified in Fleet can block; an unverified one is a warning so a person confirms the renewal. Lease, title and other documents are not checked. Check the rules that apply where you operate."
        />
        <CardBody>
          {rules ? <DocumentRulesForm rules={rules} canEdit={can(access, "settings.manage")} /> : <p className="text-sm text-muted">Document rules need a database update that has not been installed yet. Until then expired documents are review notes only.</p>}
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
  } else if (tab === "security") {
    const { data, error } = await supabase.from("company_settings").select("require_mfa").maybeSingle();
    content = (
      <>
        <CardHeader title="Two-step verification" description="A code from an authenticator app after the password, for everyone in this company." />
        <CardBody>
          {error ? (
            <p className="text-sm text-muted">Two-step verification needs a database update that has not been installed yet (20261120000900). Until then nobody is asked for a code.</p>
          ) : (
            <CompanyMfaPolicyForm required={Boolean((data as { require_mfa?: boolean } | null)?.require_mfa)} canEdit={can(access, "settings.manage")} />
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
      </>
    );
  } else if (tab === "sample") {
    const { data } = await supabase.rpc("sample_data_counts");
    content = <SampleDataPanel counts={(data ?? {}) as Record<string, number>} />;
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
      {actionError ? <div className="mb-3"><Notice tone="warning" title="Not saved">{actionError}</Notice></div> : null}
      <nav aria-label="Settings groups" className="mb-3 flex gap-1 overflow-x-auto border-b border-line">
        {groups.map(({ g, first }) => (
          <Link
            key={g}
            href={`/settings?tab=${first!.key}`}
            aria-current={group === g ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-4 py-2.5 text-[15px] font-semibold whitespace-nowrap", group === g ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {g}
          </Link>
        ))}
      </nav>
      {inGroup.length > 1 && (
        <nav aria-label="Settings sections" className="mb-4 flex flex-wrap gap-1.5">
          {inGroup.map((t) => (
            <Link
              key={t.key}
              href={`/settings?tab=${t.key}`}
              aria-current={tab === t.key ? "page" : undefined}
              className={cn("rounded-md border px-3 py-1.5 text-sm font-medium whitespace-nowrap", tab === t.key ? "border-strong bg-strong text-white" : "border-line bg-card text-muted hover:text-ink")}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      )}
      {!can(access, "settings.manage") ? (
        <p className="mb-3 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink">
          You can view these settings. Changing them needs the company settings permission (an owner or administrator).
        </p>
      ) : null}
      <Card>{content}</Card>
    </>
  );
}
