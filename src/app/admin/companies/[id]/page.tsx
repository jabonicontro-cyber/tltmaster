import Link from "next/link";
import { CompanyLifecycleControls, type DeletePreview } from "@/components/admin/company-lifecycle-controls";
import { notFound } from "next/navigation";
import { CheckCircle2, Circle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { FlashToast } from "@/components/ui/flash-toast";
import { Notice } from "@/components/ui/states";
import { SubscriptionCard } from "@/components/admin/subscription-card";
import { PortalEntitlementCard, type PortalEntitlement } from "@/components/admin/portal-entitlement-card";
import type { Lifecycle, PlanVersion } from "@/lib/platform/lifecycle";
import { formatDate, formatDateTime } from "@/lib/dates";
import { activityText } from "@/lib/platform/launchpad";
import { LEAD_STATUS_LABELS, ONBOARDING_LABELS, type LeadStatus, type OnboardingStage } from "@/lib/platform/leads";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Company" };

interface CompanyDetail {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  is_demo: boolean;
  created_at: string;
  timezone: string | null;
  setup: { owner_login: boolean; customers: number; trucks: number; drivers: number; members: number; imports_in_review: number };
  missing: string[];
  members: Array<{ name: string; email: string; role: string | null; active: boolean }>;
  imports: Array<{ id: string; entity: string; status: string; file_name: string; created_at: string; rows: number; errors: number }>;
  lead: { id: string; name: string; status: LeadStatus; onboarding_stage: OnboardingStage } | null;
  audit: Array<{ at: string; action: string; summary: string; actor: string }>;
}

const IMPORT_STATUS: Record<string, string> = { review: "Waiting for review", approved: "Approved", reverted: "Reverted", discarded: "Discarded" };

/**
 * One customer company for the platform team: setup progress, who can sign in, imports and the platform actions taken
 * on it. Operational records (orders, tickets, money) are not shown here — they belong to the company.
 */
const SAVED: Record<string, string> = {
  classified: "Classification saved.",
  archived: "Company archived. Its people cannot open it until it is restored.",
  restored: "Company restored.",
  portal_on: "Customer portal entitlement granted. The company turns its portal on itself.",
  portal_off: "Customer portal entitlement removed. The portal is off; accounts and records are kept.",
};

export default async function CompanyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_company", { p_id: id });
  if (error?.code === "P0002" || (!error && !data)) notFound();
  if (error) throw new Error("The company could not be loaded.");
  const c = data as CompanyDetail;
  // Subscription lifecycle (20261118000300); before that update is installed the card says so.
  const [life, plans] = c.is_demo ? [null, null] : await Promise.all([supabase.rpc("platform_lifecycle", { p_company: id }), supabase.rpc("platform_plans")]);
  // Classification, archive and delete (20261120000500); not shown before that update or for demo companies.
  const pv = c.is_demo ? null : await supabase.rpc("platform_company_delete_preview", { p_company: id });
  const preview = pv && !pv.error ? (pv.data as DeletePreview) : null;
  // Customer portal entitlement (20261120000700); not shown before that update.
  const pe = await supabase.rpc("platform_portal_entitlement", { p_company: id });
  const portal = pe.error ? null : (pe.data as PortalEntitlement);
  const lifecycleMissing = life?.error?.code === "PGRST202" || plans?.error?.code === "PGRST202";
  const steps = [
    { label: "Owner login", done: c.setup.owner_login, hint: "Added by an operator (docs/DEPLOYMENT.md §3) or by invitation." },
    { label: "Customers", done: c.setup.customers > 0, hint: `${c.setup.customers} active` },
    { label: "Trucks", done: c.setup.trucks > 0, hint: `${c.setup.trucks} active` },
    { label: "Drivers", done: c.setup.drivers > 0, hint: `${c.setup.drivers} active` },
  ];
  return (
    <>
      <PageHeader
        title={c.name}
        description={`${c.active ? "Active" : "Inactive"} · created ${formatDate(c.created_at.slice(0, 10))}${c.timezone ? ` · ${c.timezone}` : ""}`}
        crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Companies", href: "/admin/companies" }, { label: c.name }]}
        actions={<Link href={`/admin/onboarding/${c.id}`} className="text-sm font-semibold text-brand-fg hover:underline">Imports for this company</Link>}
      />
      <FlashToast messages={{ saved: { text: SAVED[sp.saved ?? ""] ?? "Saved." } }} />
      {sp.error && <div className="mb-4"><Notice tone="warning" title="Not saved">{sp.error}</Notice></div>}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Setup" description={c.missing.length ? `Missing: ${c.missing.join(", ")}.` : "Every setup step is done."} />
          <ul className="divide-y divide-line" aria-label="Setup steps">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5">
                {s.done ? <CheckCircle2 className="size-4 text-green-700" aria-hidden /> : <Circle className="size-4 text-muted" aria-hidden />}
                <span className="font-medium text-ink">{s.label}</span>
                <span className="ml-auto text-xs text-muted">{s.done ? "Done" : "Not yet"} · {s.hint}</span>
              </li>
            ))}
          </ul>
          {c.lead && (
            <CardBody className="border-t border-line text-sm">
              From lead <Link href={`/admin/leads/${c.lead.id}`} className="font-semibold hover:underline">{c.lead.name}</Link> · {LEAD_STATUS_LABELS[c.lead.status] ?? c.lead.status} · onboarding {ONBOARDING_LABELS[c.lead.onboarding_stage] ?? c.lead.onboarding_stage}
            </CardBody>
          )}
        </Card>
        <Card>
          <CardHeader title="People who can sign in" description="Names and roles only. Roles are managed by the company's owner in People." />
          {c.members.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted sm:px-5">Nobody can sign in to this company yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {c.members.map((m) => (
                <li key={m.email} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm sm:px-5">
                  <span className="font-medium text-ink">{m.name}</span>
                  <span className="text-xs text-muted">{m.email}</span>
                  <span className="ml-auto flex gap-1.5">{m.role ? <Badge>{m.role}</Badge> : <Badge tone="amber">No role</Badge>}{!m.active && <Badge>Inactive</Badge>}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {!c.is_demo && (lifecycleMissing ? (
        <div className="mt-5"><Notice title="Subscription needs a database update">Apply migration 20261118000300 (owner step) to record plans, onboarding fees and go-live dates.</Notice></div>
      ) : life?.error || plans?.error ? (
        <div className="mt-5"><Notice tone="warning" title="The subscription could not be loaded">Nothing is shown rather than guessed. Reload to try again.</Notice></div>
      ) : (
        <SubscriptionCard companyId={c.id} life={(life?.data ?? null) as Lifecycle | null} plans={(plans?.data ?? []) as PlanVersion[]} />
      ))}

      <Card className="mt-5">
        <CardHeader title="Imports" />
        {c.imports.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">No imports yet.</p>
        ) : (
          <TableWrap className="rounded-none border-0">
            <Table>
              <thead><tr><Th>Records</Th><Th>Status</Th><Th align="right">Rows</Th><Th align="right">With problems</Th><Th>Uploaded</Th></tr></thead>
              <tbody>
                {c.imports.map((b) => (
                  <Tr key={b.id}>
                    <Td><Link href={`/admin/onboarding/batch/${b.id}`} className="font-semibold capitalize hover:underline">{b.entity}</Link>{b.file_name ? <span className="block text-xs text-muted">{b.file_name}</span> : null}</Td>
                    <Td>{b.status === "review" ? <Badge tone="amber">{IMPORT_STATUS[b.status]}</Badge> : IMPORT_STATUS[b.status] ?? b.status}</Td>
                    <Td align="right">{b.rows}</Td>
                    <Td align="right">{b.errors}</Td>
                    <Td className="whitespace-nowrap">{formatDateTime(b.created_at)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {portal ? (
        <Card className="mt-5">
          <PortalEntitlementCard companyId={c.id} state={portal} />
        </Card>
      ) : null}
      {preview ? (
        <Card className="mt-5">
          <CompanyLifecycleControls company={{ id: c.id, name: c.name, classification: preview.classification, archived_at: preview.archived_at, archive_reason: preview.archive_reason, is_demo: c.is_demo }} preview={preview} />
        </Card>
      ) : null}

      <Card className="mt-5">
        <CardHeader title="Platform actions on this company" description="From the append-only platform audit." />
        {c.audit.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">Nothing recorded.</p>
        ) : (
          <ul className="divide-y divide-line">
            {c.audit.map((a, i) => (
              <li key={`${a.at}:${i}`} className="flex flex-wrap items-baseline justify-between gap-x-4 px-4 py-2 text-sm sm:px-5">
                <span>{activityText({ source: "platform", action: a.action })}{a.summary ? ` — ${a.summary}` : ""}</span>
                <span className="text-xs text-muted">{formatDateTime(a.at)} · {a.actor}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
