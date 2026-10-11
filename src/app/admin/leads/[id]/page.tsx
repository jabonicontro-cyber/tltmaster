import { notFound } from "next/navigation";
import { AdminFlash } from "@/components/admin/flash";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { LEAD_STATUSES, LEAD_STATUS_LABELS, LEAD_STATUS_TONES, leadEventText, type LeadStatus } from "@/lib/platform/leads";
import { createClient } from "@/server/supabase/server";
import { addLeadNote, createCompany, updateLead } from "../../actions";

export const metadata = { title: "Lead" };

interface LeadEvent {
  action: string;
  detail: Record<string, unknown>;
  note: string;
  occurred_at: string;
  actor: string;
}
interface Lead {
  id: string;
  kind: "demo" | "contact";
  status: LeadStatus;
  name: string;
  email: string;
  company_name: string;
  phone: string;
  role_title: string;
  fleet_size: string;
  message: string;
  owner_id: string | null;
  follow_up_on: string | null;
  submission_count: number;
  created_at: string;
  events: LeadEvent[];
}

function eventDetail(e: LeadEvent, team: Map<string, string>): string {
  const d = e.detail ?? {};
  const name = (v: unknown) => (typeof v === "string" ? team.get(v) ?? "someone no longer on the team" : "nobody");
  switch (e.action) {
    case "status_changed":
      return `${LEAD_STATUS_LABELS[d.from as LeadStatus] ?? d.from} → ${LEAD_STATUS_LABELS[d.to as LeadStatus] ?? d.to}`;
    case "owner_changed":
      return `${name(d.from)} → ${name(d.to)}`;
    case "follow_up_changed":
      return `${d.from ?? "none"} → ${d.to ?? "none"}`;
    case "submitted":
    case "resubmitted":
      return d.kind === "demo" ? "Demo request" : "Contact form";
    case "company_created":
      return String(d.company_name ?? "");
    default:
      return "";
  }
}

export default async function LeadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const [{ data }, { data: teamData }] = await Promise.all([supabase.rpc("platform_lead", { p_id: id }), supabase.rpc("platform_team")]);
  const lead = data as Lead | null;
  if (!lead) notFound();
  const team = (teamData ?? []) as Array<{ user_id: string; full_name: string; email: string }>;
  const teamNames = new Map(team.map((t) => [t.user_id, t.full_name || t.email]));
  return (
    <>
      <PageHeader
        title={lead.name}
        description={`${lead.kind === "demo" ? "Demo request" : "Contact message"} · received ${formatDateTime(lead.created_at)}${lead.submission_count > 1 ? ` · sent ${lead.submission_count} times` : ""}`}
        crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Leads", href: "/admin/leads" }, { label: lead.name }]}
        badges={<Badge tone={LEAD_STATUS_TONES[lead.status]}>{LEAD_STATUS_LABELS[lead.status]}</Badge>}
      />
      <AdminFlash error={sp.error} saved={sp.saved} />
      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div><dt className="text-muted">Email</dt><dd><a href={`mailto:${lead.email}`} className="font-semibold underline">{lead.email}</a></dd></div>
                <div><dt className="text-muted">Phone</dt><dd>{lead.phone || "—"}</dd></div>
                <div><dt className="text-muted">Company</dt><dd>{lead.company_name || "—"}</dd></div>
                <div><dt className="text-muted">Role</dt><dd>{lead.role_title || "—"}</dd></div>
                <div><dt className="text-muted">Fleet size</dt><dd>{lead.fleet_size || "—"}</dd></div>
              </dl>
              {lead.message ? <p className="mt-4 rounded-md bg-surface p-3 text-sm whitespace-pre-wrap">{lead.message}</p> : null}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="History" />
            <CardBody>
              <ol id="history" className="space-y-3">
                {lead.events.map((e, i) => (
                  <li key={i} className="border-l-2 border-line pl-3 text-sm">
                    <p>
                      <span className="font-semibold">{e.actor}</span> · {leadEventText(e.action)}
                      {eventDetail(e, teamNames) ? <span className="text-muted"> · {eventDetail(e, teamNames)}</span> : null}
                    </p>
                    <p className="text-xs text-muted">{formatDateTime(e.occurred_at)}</p>
                    {e.note ? <p className="mt-1 whitespace-pre-wrap">{e.note}</p> : null}
                  </li>
                ))}
              </ol>
              <form action={addLeadNote} className="mt-5 space-y-2">
                <input type="hidden" name="id" value={lead.id} />
                <Field label="Add a note" htmlFor="note">
                  <Textarea id="note" name="note" maxLength={4000} required />
                </Field>
                <SubmitButton variant="secondary" pendingLabel="Saving…">Add note</SubmitButton>
              </form>
            </CardBody>
          </Card>
        </div>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Work this lead" />
            <CardBody>
              <form action={updateLead} className="space-y-3">
                <input type="hidden" name="id" value={lead.id} />
                <Field label="Status" htmlFor="status">
                  <Select id="status" name="status" defaultValue={lead.status}>
                    {LEAD_STATUSES.map((s) => (
                      <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Owner" htmlFor="owner">
                  <Select id="owner" name="owner" defaultValue={lead.owner_id ?? ""}>
                    <option value="">Unassigned</option>
                    {team.map((t) => (
                      <option key={t.user_id} value={t.user_id}>{t.full_name || t.email}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Follow up on" htmlFor="follow_up_on">
                  <Input id="follow_up_on" name="follow_up_on" type="date" defaultValue={lead.follow_up_on ?? ""} />
                </Field>
                <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
              </form>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Start onboarding" description="Creates the company (no users yet) and opens its import page. The lead moves to Onboarding." />
            <CardBody>
              <form action={createCompany} className="space-y-3">
                <input type="hidden" name="lead" value={lead.id} />
                <Field label="Company name" htmlFor="company-name">
                  <Input id="company-name" name="name" defaultValue={lead.company_name} required maxLength={120} />
                </Field>
                <Field label="Time zone" htmlFor="company-tz">
                  <Input id="company-tz" name="timezone" defaultValue="America/Chicago" required />
                </Field>
                <SubmitButton variant="dark" pendingLabel="Creating…">Create company</SubmitButton>
              </form>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
