import Link from "next/link";
import { notFound } from "next/navigation";
import { ProspectEmail, ProspectManage } from "@/components/admin/outreach";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/dates";
import {
  OUTREACH_STATUS_LABELS, SEGMENT_LABELS, renderEmail, settingsProblems, withDefaults,
  type OutreachSettings, type OutreachStatus, type ProspectForEmail, type Segment,
} from "@/lib/platform/outreach";
import { requirePlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Outreach company" };

interface Prospect extends ProspectForEmail {
  id: string; phone: string; state: string; dot_number: string; drivers: number | null; segment: Segment; status: OutreachStatus;
  notes: string; lead_id: string | null; last_contacted_at: string | null; created_at: string; suppressed: boolean;
  events: Array<{ action: string; detail: Record<string, string>; occurred_at: string; actor: string | null }>;
}

const EVENT_TEXT: Record<string, (d: Record<string, string>) => string> = {
  imported: (d) => `Added from ${d.source === "fmcsa_census" ? "the FMCSA registry" : "a CSV file"}`,
  added: () => "Added by hand",
  prepared: () => "Email opened to send",
  marked_sent: () => "Email sent",
  status_changed: (d) => `Status: ${OUTREACH_STATUS_LABELS[d.to as OutreachStatus] ?? d.to}`,
  note_changed: () => "Notes changed",
  unsubscribed: () => "Unsubscribed from the email link",
  converted: () => "Added to Leads",
};

export default async function OutreachProspectPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePlatformAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const supabase = await createClient();
  const [{ data, error }, settingsRes] = await Promise.all([supabase.rpc("platform_outreach_get", { p_id: id }), supabase.rpc("platform_outreach_settings")]);
  if (error || !data) notFound();
  const p = data as Prospect;
  const settings = withDefaults(settingsRes.data as Partial<OutreachSettings>);
  const problems = settingsProblems(settings);
  const blocked = p.status === "do_not_contact" || p.suppressed
    ? "This company asked not to be contacted. No email can be prepared."
    : problems.length ? `${problems.join(" ")} (Outreach → Email and FAQ)` : null;
  const email = blocked ? null : renderEmail(p, settings);
  const facts = [
    ["Email", p.email], ["Contact", p.contact_name], ["Phone", p.phone], ["Where", [p.city, p.state].filter(Boolean).join(", ")],
    ["Trucks", p.power_units?.toString() ?? ""], ["Drivers", p.drivers?.toString() ?? ""], ["Kind", SEGMENT_LABELS[p.segment]],
    ["USDOT", p.dot_number], ["Last contact", p.last_contacted_at ? formatDateTime(p.last_contacted_at) : ""],
  ].filter(([, v]) => v);

  return (
    <>
      <PageHeader
        title={p.company_name}
        description={<Badge tone={p.status === "interested" ? "green" : "gray"}>{OUTREACH_STATUS_LABELS[p.status]}</Badge>}
        crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Outreach", href: "/admin/outreach" }, { label: p.company_name }]}
      />
      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Email" description="Filled in for this company from your saved email. Edit it in your mail program before sending if you like." />
          <CardBody><ProspectEmail id={p.id} email={email} blocked={blocked} /></CardBody>
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Company" />
            <CardBody>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                {facts.map(([k, v]) => (<div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="break-words text-ink">{v}</dd></div>))}
              </dl>
              {p.dot_number && <p className="mt-3 text-sm"><a className="font-semibold text-brand-fg underline" href={`https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${p.dot_number}`} target="_blank" rel="noreferrer">FMCSA record</a></p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Follow-up" />
            <CardBody><ProspectManage id={p.id} status={p.status} notes={p.notes} leadId={p.lead_id} /></CardBody>
          </Card>
          <Card>
            <CardHeader title="History" />
            <CardBody>
              <ol className="space-y-2 text-sm" aria-label="History">
                {p.events.map((e, i) => (
                  <li key={i}><span className="text-ink">{EVENT_TEXT[e.action]?.(e.detail ?? {}) ?? e.action}</span> <span className="text-xs text-muted">{e.actor ? `${e.actor} · ` : ""}{formatDateTime(e.occurred_at)}</span></li>
                ))}
              </ol>
              {p.lead_id && <p className="mt-3 text-sm"><Link className="font-semibold underline" href={`/admin/leads/${p.lead_id}`}>Open the lead</Link></p>}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
