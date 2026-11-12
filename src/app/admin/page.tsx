import { TERMS } from "@/lib/terminology";
import Link from "next/link";
import { AppWindow, ArrowRight, Building2, CheckCircle2, Inbox, PlayCircle, ReceiptText, ShieldCheck, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/dates";
import { FlashToast } from "@/components/ui/flash-toast";
import { Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConsoleBand, ConsolePageHeader, Panel, PanelHeader, PanelLink, StatGrid, type Stat } from "@/components/admin/ui";
import { ackFor, type Console } from "@/lib/platform/lifecycle";
import { usd } from "@/lib/site/pricing";
import { acknowledgeAttention } from "./lifecycle-actions";
import { ATTENTION_ACTIONS, ATTENTION_LABELS, activityHref, activityText, ageText, attentionHref, customersSub, demoScheduledSub, type Launchpad } from "@/lib/platform/launchpad";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Launchpad" };

const QUICK = [
  { href: "/admin/leads?status=new", icon: Inbox, label: "Review new leads", text: "Reply to demo requests and messages." },
  { href: "/admin/companies", icon: Building2, label: "Company directory", text: "Every customer and its setup." },
  { href: "/admin/onboarding", icon: Upload, label: "Onboard a company", text: "Create it and import its records." },
  { href: "/admin/plans", icon: ReceiptText, label: "Plans and prices", text: "Dated price versions." },
  { href: "/admin/demo", icon: PlayCircle, label: TERMS.demoManagement, text: "Start, refresh and present demos." },
  { href: "/admin/platform", icon: ShieldCheck, label: "Team and audit log", text: "Who is on the team, and what they did." },
  { href: "/command-center", icon: AppWindow, label: "Open the app", text: "The company workspace you last used." },
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
        <ConsolePageHeader title="Launchpad" description="What needs the Taviron team today." />
        <ErrorState
          title={error?.code === "PGRST202" ? "The Launchpad needs a database update" : "The Launchpad could not be loaded"}
          description={error?.code === "PGRST202" ? "A Taviron Admin installs it. Leads, demos and onboarding still work from the menu." : "No figures are shown rather than guessed. Try again, or open Leads, Demo Management and Onboarding from the menu."}
        />
        {old.data ? <p className="mt-3 text-sm text-muted">From the earlier overview: {(old.data as { new_leads?: number }).new_leads ?? 0} new leads, {(old.data as { companies?: number }).companies ?? 0} companies.</p> : null}
      </>
    );
  }
  const p = data as Launchpad;
  // The business KPIs and acknowledgements (20261118000300). Without that update they say so instead of showing 0.
  const k = consoleRes.error ? null : (consoleRes.data as Console);
  const kpiNote = consoleRes.error?.code === "PGRST202" ? "Needs a database update" : "Could not be read";
  const now = Date.parse(p.as_of); // ages are measured at the moment the figures were read
  const kpis: Stat[] = [
    { label: "Customer companies", value: k ? String(k.customers.live) : "–", sub: k ? customersSub(k.customers) : kpiNote, href: "/admin/companies" },
    { label: "Monthly recurring revenue", value: k ? usd(k.mrr.cents) : "–", sub: k ? `agreed amounts of ${k.mrr.live} live compan${k.mrr.live === 1 ? "y" : "ies"}${k.mrr.free ? ` (${k.mrr.free} free beta)` : ""}` : kpiNote, href: "/admin/companies" },
    { label: "Pipeline", value: k ? String(k.pipeline.open) : "–", sub: k ? `open leads · ${k.pipeline.demo_scheduled} demo scheduled · ${k.pipeline.overdue} overdue` : kpiNote, href: "/admin/leads" },
    { label: "Onboarding", value: k ? String(k.customers.onboarding + k.customers.fee_due) : "–", sub: k ? `${k.customers.fee_due} fee due · ${k.customers.go_live_14d} going live within 14 days` : kpiNote, href: "/admin/companies" },
  ];
  const urgent = p.attention.items.filter((i) => i.priority === 1).length;
  const work: Stat[] = [
    { label: "Setup not complete", value: p.companies.setup_incomplete, sub: "Missing an owner login, customers, trucks or drivers", href: "/admin/companies?setup=open", tone: p.companies.setup_incomplete > 0 ? "attention" : "default" },
    { label: "New leads", value: p.leads.new, sub: `${p.leads.due_today} follow-up${p.leads.due_today === 1 ? "" : "s"} due today`, href: "/admin/leads?status=new", tone: p.leads.new > 0 ? "attention" : "default" },
    { label: "Follow-ups overdue", value: p.leads.overdue, sub: "Past the follow-up date you set", href: "/admin/leads?due=1", tone: p.leads.overdue > 0 ? "critical" : "default" },
    { label: "Demos scheduled", value: p.leads.demo_scheduled, sub: demoScheduledSub(p.leads, formatDate), href: "/admin/leads?status=demo_scheduled" },
    { label: "Imports to review", value: p.imports.in_review, sub: p.imports.oldest_review_at ? `Oldest waiting ${ageText(p.imports.oldest_review_at, now)}` : `${p.imports.approved_30d} approved in 30 days`, href: "/admin/onboarding", tone: p.imports.in_review > 0 ? "attention" : "default" },
  ];
  return (
    <>
      <ConsolePageHeader title="Launchpad" description="What needs the Taviron team today across leads, customer companies, imports and demos, read live from the records." />
      <FlashToast messages={{ saved: { text: "Acknowledged. It stays on the list until its cause is resolved." } }} />

      <ConsoleBand aria-label="Platform status" className="mb-6">
        <div className="relative grid grid-cols-1 gap-6 p-5 sm:p-7 xl:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] xl:items-stretch xl:gap-8">
          <div className="flex flex-col">
            <p className="text-sm font-medium text-silver">Today</p>
            <p className="console-title mt-2 text-[1.75rem] font-bold text-cloud sm:text-[2rem]">
              {p.attention.total === 0 ? "Nothing needs attention" : `${p.attention.total} item${p.attention.total === 1 ? "" : "s"} need attention`}
            </p>
            {urgent > 0 || p.email_failures_7d > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {urgent > 0 && <span className="inline-flex h-[22px] items-center rounded-full bg-critical px-2.5 text-xs font-semibold text-white"><span className="pill-text">{urgent} urgent</span></span>}
                {p.email_failures_7d > 0 && <span className="inline-flex h-[22px] items-center rounded-full bg-critical px-2.5 text-xs font-semibold text-white"><span className="pill-text">{p.email_failures_7d} lead email{p.email_failures_7d === 1 ? "" : "s"} failed this week</span></span>}
              </div>
            ) : null}
            <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-5 text-sm">
              {p.attention.total > 0 ? (
                <a href="#attention" className="inline-flex items-center gap-1 font-semibold text-brand-fg hover:underline">
                  See the list <ArrowRight className="size-3.5" aria-hidden />
                </a>
              ) : null}
              <span className="text-xs text-silver/85">As of {formatDateTime(p.as_of)}</span>
            </div>
          </div>
          <StatGrid stats={kpis} label="Business KPIs" columns={4} onNavy />
        </div>
      </ConsoleBand>

      <section aria-labelledby="work-heading" className="mb-8">
        <h2 id="work-heading" className="mb-3 text-[17px] font-semibold tracking-[-0.015em] text-ink">Today&apos;s work</h2>
        <StatGrid stats={work} label="Platform overview" columns={5} />
      </section>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel id="attention" className="scroll-mt-32">
          <PanelHeader title="Needs attention" description="Overdue follow-ups, failed emails and demo refreshes first, then new leads, imports and companies still being set up. Acknowledging keeps an item here until its cause is fixed." />
          {p.attention.items.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="size-6" />} title="Nothing needs attention" description="Checked: new and overdue leads, failed lead emails, imports waiting for review, companies with incomplete setup and demo refreshes." className="py-10" />
          ) : (
            <>
              <ul className="border-t border-line" aria-label="Needs attention">
                {p.attention.items.map((i) => {
                  const ack = ackFor(k?.acks, i);
                  return (
                    <li key={`${i.kind}:${i.ref_id}`} className="grid grid-cols-1 gap-x-6 gap-y-3 border-b border-line/70 px-5 py-4 last:border-b-0 sm:px-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2">
                          <Badge tone={i.priority === 1 ? "critical-soft" : i.priority === 2 ? "amber" : "gray"}>{ATTENTION_LABELS[i.kind]}</Badge>
                          <span className="font-semibold break-words text-ink">{i.title}</span>
                        </p>
                        <p className="mt-1 text-sm text-muted">
                          {i.detail}
                          {i.since && i.kind !== "lead_overdue" ? ` · ${ageText(i.since, now)} ago` : ""}
                        </p>
                        {ack && <p className="mt-1 text-xs text-muted">Acknowledged by {ack.by} · {formatDateTime(ack.at)}{ack.note ? `: ${ack.note}` : ""} · still open</p>}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 lg:justify-end">
                        {k && !ack && (
                          <form action={acknowledgeAttention} className="flex items-center gap-1.5">
                            <input type="hidden" name="key" value={`${i.kind}:${i.ref_id}`} />
                            <Input name="note" placeholder="Note (optional)" aria-label={`Note for ${i.title}`} maxLength={300} className="h-9 w-36 text-sm sm:w-40" />
                            <SubmitButton size="sm" variant="secondary" pendingLabel="…">Acknowledge</SubmitButton>
                          </form>
                        )}
                        <Link href={attentionHref(i)} className="inline-flex h-9 items-center gap-1 text-sm font-semibold whitespace-nowrap text-brand-fg hover:underline">
                          {ATTENTION_ACTIONS[i.kind]} <ArrowRight className="size-3.5" aria-hidden />
                        </Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {p.attention.total > p.attention.items.length && (
                <p className="border-t border-line px-5 py-3 text-sm text-muted sm:px-6">
                  Showing {p.attention.items.length} of {p.attention.total}. The rest: {Object.entries(p.attention.by_kind).map(([kind, n]) => `${n} ${ATTENTION_LABELS[kind as keyof typeof ATTENTION_LABELS].toLowerCase()}`).join(", ")}.
                </p>
              )}
            </>
          )}
        </Panel>

        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Quick actions" />
            <ul className="grid grid-cols-1 border-t border-line sm:grid-cols-2 xl:grid-cols-1" aria-label="Quick actions">
              {QUICK.map((q) => (
                <li key={q.href} className="border-b border-line/70 last:border-b-0 sm:odd:border-r xl:odd:border-r-0">
                  <Link href={q.href} className="group flex items-center gap-3 px-5 py-3 transition-colors duration-150 hover:bg-surface sm:px-6">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-light text-brand-fg" aria-hidden>
                      <q.icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink">{q.label}</span>
                      <span className="block truncate text-xs text-muted">{q.text}</span>
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-muted transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel>
            <PanelHeader title="Demos" description="Demo companies with fictional data, and their last refresh." actions={<PanelLink href="/admin/demo">{TERMS.demoManagement}</PanelLink>} />
            {p.demos.length === 0 ? (
              <p className="border-t border-line px-5 py-4 text-sm text-muted sm:px-6">No demo company yet. Start one in {TERMS.demoManagement}.</p>
            ) : (
              <ul className="border-t border-line" aria-label="Demos">
                {p.demos.slice(0, 8).map((d) => (
                  <li key={d.id} className="border-b border-line/70 px-5 py-3 text-sm last:border-b-0 sm:px-6">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">{d.name} <Badge>{d.kind === "presenter" ? "Presenter" : "Prospect"}</Badge></p>
                    <p className={cn("mt-0.5 text-xs", d.last_refresh_ok === false ? "font-semibold text-critical" : "text-muted")}>
                      {d.last_refresh_at
                        ? `${d.last_refresh_ok ? "Last refreshed" : "Last refresh failed"} ${formatDateTime(d.last_refresh_at)}${d.last_refresh_summary ? `: ${d.last_refresh_summary}` : ""}`
                        : `Created ${formatDate(d.created_at.slice(0, 10))}; no refresh recorded yet`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {p.demos.length > 8 && <p className="border-t border-line px-5 py-3 text-sm sm:px-6"><PanelLink href="/admin/demo">All {p.demos.length} demos</PanelLink></p>}
          </Panel>
        </div>
      </div>

      <Panel className="mt-6">
        <PanelHeader title="Recent activity" description="Platform actions and lead history, newest first." actions={<PanelLink href="/admin/platform">Full audit log</PanelLink>} />
        {p.activity.length === 0 ? (
          <p className="border-t border-line px-5 py-6 text-sm text-muted sm:px-6">No activity recorded yet.</p>
        ) : (
          <ul className="border-t border-line" aria-label="Recent activity">
            {p.activity.map((a, idx) => {
              const href = activityHref(a);
              const text = `${activityText(a)}${a.summary ? `: ${a.summary}` : ""}`;
              return (
                <li key={`${a.at}:${idx}`} className="grid grid-cols-1 gap-x-6 gap-y-0.5 border-b border-line/70 px-5 py-2.5 text-sm last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:px-6">
                  {href ? <Link href={href} className="min-w-0 break-words text-ink hover:underline">{text}</Link> : <span className="min-w-0 break-words text-ink">{text}</span>}
                  <span className="text-xs whitespace-nowrap text-muted tabular">{formatDateTime(a.at)} · {a.actor}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
