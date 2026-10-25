import { TERMS } from "@/lib/terminology";
import Link from "next/link";
import { AppWindow, ArrowRight, Building2, CheckCircle2, Inbox, PlayCircle, ReceiptText, ShieldCheck, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/dates";
import { FlashToast } from "@/components/ui/flash-toast";
import { Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { ackFor, type Console } from "@/lib/platform/lifecycle";
import { usd } from "@/lib/site/pricing";
import { acknowledgeAttention } from "./lifecycle-actions";
import { ATTENTION_ACTIONS, ATTENTION_LABELS, activityHref, activityText, ageText, attentionHref, type Launchpad } from "@/lib/platform/launchpad";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Launchpad" };

const QUICK = [
  { href: "/admin/leads?status=new", icon: Inbox, label: "Review new leads" },
  { href: "/admin/companies", icon: Building2, label: "Company directory" },
  { href: "/admin/plans", icon: ReceiptText, label: "Plans and prices" },
  { href: "/admin/onboarding", icon: Upload, label: "Start Onboarding or an Import" },
  { href: "/admin/demo", icon: PlayCircle, label: "Manage demos" },
  { href: "/admin/platform", icon: ShieldCheck, label: "Team and audit log" },
  { href: "/command-center", icon: AppWindow, label: "Open the app" },
];

/**
 * The platform owner's daily workspace: live counts, one prioritized list of what needs attention, demos with their
 * last refresh, and recent platform activity. Everything comes from public.platform_launchpad() (platform admins only,
 * checked in the database); nothing is estimated, and a section that could not be read says so instead of showing 0.
 */
export default async function LaunchpadPage() {
  const supabase = await createClient();
  const [{ data, error }, consoleRes] = await Promise.all([supabase.rpc("platform_launchpad"), supabase.rpc("platform_console")]);
  if (error || !data) {
    // Before the 20261118000100 update is installed: the earlier overview still works.
    const old = await supabase.rpc("platform_overview");
    return (
      <>
        <PageHeader title="Launchpad" description="The Taviron team's workspace." />
        <ErrorState
          title={error?.code === "PGRST202" ? "The new Launchpad needs a database update" : "The Launchpad could not be loaded"}
          description={error?.code === "PGRST202" ? "Apply migration 20261118000100 (owner step). Leads, demos and onboarding still work from the menu." : "No figures are shown rather than guessed. Try again, or open Leads, Live demo and Onboarding from the menu."}
        />
        {old.data ? <p className="mt-3 text-sm text-muted">From the earlier overview: {(old.data as { new_leads?: number }).new_leads ?? 0} new leads, {(old.data as { companies?: number }).companies ?? 0} companies.</p> : null}
      </>
    );
  }
  const p = data as Launchpad;
  // The business KPIs and acknowledgements (20261118000300). Without that update they say so instead of showing 0.
  const k = consoleRes.error ? null : (consoleRes.data as Console);
  const kpiNote = consoleRes.error?.code === "PGRST202" ? "Needs database update 20261118000300" : "Could not be read";
  const now = Date.parse(p.as_of); // ages are measured at the moment the figures were read
  const kpis = [
    { label: "Customer companies", value: k ? String(k.customers.live) : "—", sub: k ? `live · ${k.customers.total} active in all` : kpiNote, href: "/admin/companies" },
    { label: "Monthly recurring revenue", value: k ? usd(k.mrr.cents) : "—", sub: k ? `agreed amounts of ${k.mrr.live} live compan${k.mrr.live === 1 ? "y" : "ies"}${k.mrr.free ? ` (${k.mrr.free} free beta)` : ""}` : kpiNote, href: "/admin/companies" },
    { label: "Pipeline", value: k ? String(k.pipeline.open) : "—", sub: k ? `open leads · ${k.pipeline.demo_scheduled} demo scheduled · ${k.pipeline.overdue} overdue` : kpiNote, href: "/admin/leads" },
    { label: "Onboarding", value: k ? String(k.customers.onboarding + k.customers.fee_due) : "—", sub: k ? `${k.customers.fee_due} fee due · ${k.customers.go_live_14d} going live within 14 days` : kpiNote, href: "/admin/companies" },
  ];
  const urgent = p.attention.items.filter((i) => i.priority === 1).length;
  const metrics = [
    { label: "Setup Not Complete", value: p.companies.setup_incomplete, sub: "Missing an owner login, customers, trucks or drivers", href: "/admin/companies?setup=open", warn: p.companies.setup_incomplete > 0 },
    { label: "New leads", value: p.leads.new, sub: `${p.leads.due_today} follow-ups due today`, href: "/admin/leads?status=new", warn: p.leads.new > 0 },
    { label: "Follow-ups overdue", value: p.leads.overdue, sub: "Past the follow-up date you set", href: "/admin/leads?due=1", bad: p.leads.overdue > 0 },
    { label: "Demos scheduled", value: p.leads.demo_scheduled, sub: "Leads in Demo Scheduled (no demo dates are recorded)", href: "/admin/leads?status=demo_scheduled" },
    { label: "Imports to review", value: p.imports.in_review, sub: p.imports.oldest_review_at ? `Oldest waiting ${ageText(p.imports.oldest_review_at, now)}` : `${p.imports.approved_30d} approved in 30 days`, href: "/admin/onboarding", warn: p.imports.in_review > 0 },
  ];
  return (
    <>
      <PageHeader title="Launchpad" description="What needs you today across leads, customer companies, imports and demos — read live from the platform records." />
      <FlashToast messages={{ saved: { text: "Acknowledged. It stays on the list until its cause is resolved." } }} />

      <ul className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4" aria-label="Business KPIs">
        {kpis.map((m) => (
          <li key={m.label}>
            <Link href={m.href} className="flex h-full flex-col rounded-panel border border-line/70 bg-card shadow-card p-4 shadow-xs transition-colors hover:border-strong/40 sm:p-5">
              <p className="text-[13px] font-medium text-muted">{m.label}</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight tabular text-ink">{m.value}</p>
              <p className="mt-auto pt-1 text-xs text-muted">{m.sub}</p>
            </Link>
          </li>
        ))}
      </ul>

      <section aria-label="Platform status" className={cn("mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-line border-l-4 bg-card px-4 py-3 shadow-xs sm:px-5", urgent ? "border-l-critical" : p.attention.total ? "border-l-amber-400" : "border-l-green-500")}>
        <p className="text-base font-semibold text-ink">{p.attention.total === 0 ? "Nothing needs attention" : `${p.attention.total} item${p.attention.total === 1 ? "" : "s"} need attention`}</p>
        {urgent > 0 && <span className="rounded bg-critical px-2 py-0.5 text-sm font-semibold text-white">{urgent} urgent</span>}
        {p.email_failures_7d > 0 && <span className="text-sm font-semibold text-critical">{p.email_failures_7d} lead email{p.email_failures_7d === 1 ? "" : "s"} failed this week</span>}
        <p className="ml-auto text-xs text-muted">As of {formatDateTime(p.as_of)}</p>
      </section>

      <ul className="mb-6 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-5" aria-label="Platform overview">
        {metrics.map((m) => (
          <li key={m.label}>
            <Link href={m.href} className="flex h-full flex-col rounded-panel border border-line/70 bg-card shadow-card p-3 transition-colors hover:border-strong/40 hover:bg-surface/40 sm:p-4">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted">
                {(m.bad || m.warn) && <span className={cn("size-1.5 rounded-full", m.bad ? "bg-critical" : "bg-amber-500")} aria-hidden />}
                {m.label}
              </p>
              <p className={cn("mt-1 text-2xl font-semibold tracking-tight tabular", m.bad ? "text-critical" : "text-ink")}>{m.value}</p>
              <p className="mt-auto pt-1 text-xs text-muted">{m.sub}</p>
            </Link>
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader title="Needs attention" description="One item per problem: overdue follow-ups, failed emails and demo refreshes first, then new leads, imports and companies still being set up." />
          {p.attention.items.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="size-6" />} title="Nothing needs attention" description="Checked: new and overdue leads, failed lead emails, imports waiting for review, companies with incomplete setup and demo refreshes." className="py-8" />
          ) : (
            <>
              <ul className="divide-y divide-line" aria-label="Needs attention">
                {p.attention.items.map((i) => {
                  const ack = ackFor(k?.acks, i);
                  return (
                  <li key={`${i.kind}:${i.ref_id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 sm:px-5">
                    <div className="min-w-0 flex-[1_1_18rem]">
                      <p className="flex flex-wrap items-center gap-2">
                        <Badge tone={i.priority === 1 ? "critical-soft" : i.priority === 2 ? "amber" : "gray"}>{ATTENTION_LABELS[i.kind]}</Badge>
                        <span className="font-semibold break-words text-ink">{i.title}</span>
                      </p>
                      <p className="mt-0.5 text-sm text-muted">
                        {i.detail}
                        {i.since && i.kind !== "lead_overdue" ? ` · ${ageText(i.since, now)} ago` : ""}
                      </p>
                      {ack && <p className="mt-0.5 text-xs text-muted">Acknowledged by {ack.by} · {formatDateTime(ack.at)}{ack.note ? ` — ${ack.note}` : ""} · still open</p>}
                    </div>
                    <div className="ml-auto flex flex-wrap items-center gap-3">
                      {k && !ack && (
                        <form action={acknowledgeAttention} className="flex items-center gap-1.5">
                          <input type="hidden" name="key" value={`${i.kind}:${i.ref_id}`} />
                          <Input name="note" placeholder="Note (optional)" aria-label={`Note for ${i.title}`} maxLength={300} className="h-8 w-36 text-xs" />
                          <SubmitButton size="sm" variant="secondary" pendingLabel="…">Acknowledge</SubmitButton>
                        </form>
                      )}
                      <Link href={attentionHref(i)} className="inline-flex items-center gap-1 text-sm font-semibold text-brand-fg hover:underline">
                        {ATTENTION_ACTIONS[i.kind]} <ArrowRight className="size-3.5" aria-hidden />
                      </Link>
                    </div>
                  </li>
                  );
                })}
              </ul>
              {p.attention.total > p.attention.items.length && (
                <p className="border-t border-line px-4 py-2.5 text-sm text-muted sm:px-5">
                  Showing {p.attention.items.length} of {p.attention.total}. The rest: {Object.entries(p.attention.by_kind).map(([k, n]) => `${n} ${ATTENTION_LABELS[k as keyof typeof ATTENTION_LABELS].toLowerCase()}`).join(", ")}.
                </p>
              )}
            </>
          )}
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Quick actions" />
            <ul className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 xl:grid-cols-1" aria-label="Quick actions">
              {QUICK.map((q) => (
                <li key={q.href} className="bg-card">
                  <Link href={q.href} className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-ink hover:bg-surface/60 sm:px-5">
                    <q.icon className="size-4 text-brand-fg" aria-hidden /> {q.label}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Demos" description="Separate demo companies with fictional data. Refreshes are recorded here." actions={<Link href="/admin/demo" className="text-sm font-semibold text-brand-fg hover:underline">{TERMS.demoManagement}</Link>} />
            {p.demos.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted sm:px-5">No demo company yet. Create one in Live demo.</p>
            ) : (
              <ul className="divide-y divide-line" aria-label="Demos">
                {p.demos.slice(0, 8).map((d) => (
                  <li key={d.id} className="px-4 py-2.5 text-sm sm:px-5">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">{d.name} <Badge>{d.kind === "presenter" ? "Presenter" : "Prospect"}</Badge></p>
                    <p className={cn("text-xs", d.last_refresh_ok === false ? "font-semibold text-critical" : "text-muted")}>
                      {d.last_refresh_at
                        ? `${d.last_refresh_ok ? "Last refreshed" : "Last refresh failed"} ${formatDateTime(d.last_refresh_at)}${d.last_refresh_summary ? ` — ${d.last_refresh_summary}` : ""}`
                        : `Created ${formatDate(d.created_at.slice(0, 10))}; no refresh recorded yet`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {p.demos.length > 8 && <p className="border-t border-line px-4 py-2.5 text-sm sm:px-5"><Link href="/admin/demo" className="font-semibold text-brand-fg hover:underline">All {p.demos.length} demos</Link></p>}
          </Card>
        </div>
      </div>

      <Card className="mt-5">
        <CardHeader title="Recent activity" description="Platform actions (from the append-only platform audit) and lead history, newest first." actions={<Link href="/admin/platform" className="text-sm font-semibold text-brand-fg hover:underline">Full audit log</Link>} />
        {p.activity.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted sm:px-5">No activity recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Recent activity">
            {p.activity.map((a, idx) => {
              const href = activityHref(a);
              const text = `${activityText(a)}${a.summary ? ` — ${a.summary}` : ""}`;
              return (
                <li key={`${a.at}:${idx}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2 text-sm sm:px-5">
                  {href ? <Link href={href} className="min-w-0 break-words hover:underline">{text}</Link> : <span className="min-w-0 break-words">{text}</span>}
                  <span className="text-xs text-muted">{formatDateTime(a.at)} · {a.actor}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
