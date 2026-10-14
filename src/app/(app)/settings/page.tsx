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
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import { can, ROLE_LABELS, type Access } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { emailStatusSummary } from "@/server/email/provider";
import { getUserNames } from "@/server/data/quotes";
import { businessToday, getSettings } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";
import { documentRules } from "@/server/data/fleet";
import { DocumentRulesForm } from "@/components/settings/document-rules-form";
import { ApprovalChainForm } from "@/components/settings/approval-chain-form";
import { approvalChain } from "@/server/data/time-off";

export const metadata = { title: "Settings" };

const TABS: Array<{ key: string; label: string; visible: (a: Access) => boolean }> = [
  { key: "account", label: "My account", visible: () => true },
  { key: "company", label: "Company", visible: () => true },
  { key: "numbering", label: "Numbering", visible: (a) => can(a, "settings.manage") },
  { key: "dispatch", label: "Dispatch rules", visible: (a) => can(a, "settings.manage") || can(a, "dispatch.view") },
  { key: "time-off", label: "Time off", visible: (a) => can(a, "settings.manage") },
  { key: "permissions", label: "Permissions", visible: (a) => can(a, "users.manage") },
  { key: "email", label: "Email", visible: () => true },
  { key: "sample", label: "Sample data", visible: (a) => can(a, "settings.manage") },
  { key: "audit", label: "Audit log", visible: (a) => can(a, "audit.view") },
];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const access = await requireAccess();
  const { tab: rawTab } = await searchParams;
  // Sign-ins and roles live on People now (owner 2026-10-14); old links keep working.
  if (rawTab === "users") redirect("/employees?view=access");
  const tabs = TABS.filter((t) => t.visible(access));
  const tab = tabs.find((t) => t.key === rawTab)?.key ?? "account";
  const supabase = await createClient();
  const { timezone, today } = await businessToday();

  let content: React.ReactNode = null;

  if (tab === "account") {
    content = (
      <>
        <CardHeader title="My account" />
        <CardBody className="space-y-4">
          <DescriptionList
            items={[
              { label: "Name", value: access.fullName },
              { label: "Sign-in", value: access.email },
              { label: "Company", value: access.companyName ?? "" },
              { label: "Role", value: access.role ? ROLE_LABELS[access.role] : "None" },
              { label: "Permissions", value: access.permissions.join(", "), wide: true },
            ]}
          />
          <Link href="/forgot-password" className={buttonClasses("secondary")}>Change password (sends a reset link)</Link>
        </CardBody>
      </>
    );
  } else if (tab === "company") {
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
      <nav aria-label="Settings sections" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/settings?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-4 py-2.5 text-[15px] font-semibold whitespace-nowrap", tab === t.key ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <Card>{content}</Card>
    </>
  );
}
