import { TERMS } from "@/lib/terminology";
import { notFound } from "next/navigation";
import { DateInput } from "@/components/ui/date-input";
import { AdminFlash } from "@/components/admin/flash";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDate, formatDateTime } from "@/lib/dates";
import {
  EMAIL_KIND_LABELS, EMAIL_STATUS_LABELS, LEAD_STATUSES, LEAD_STATUS_LABELS, LEAD_STATUS_TONES, ONBOARDING_LABELS, ONBOARDING_STAGES,
  leadEventDetail, leadEventText, type LeadStatus, type OnboardingStage,
} from "@/lib/platform/leads";
import { createClient } from "@/server/supabase/server";
import { addLeadNote, createCompany, updateLead } from "../../actions";
import { ConsolePageHeader, Panel, PanelBody, PanelHeader, groupOf } from "@/components/admin/ui";

export const metadata = { title: "Lead" };

interface LeadEvent {
  action: string;
  detail: Record<string, unknown>;
  note: string;
  occurred_at: string;
  actor: string;
}
interface LeadEmail {
  kind: string;
  recipient: string;
  mode: "preview" | "test" | "live";
  status: "sent" | "failed" | "not_sent";
  detail: string;
  created_at: string;
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
  truck_count: number | null;
  base_count: number | null;
  disposition: "" | "spam";
  onboarding_stage: OnboardingStage;
  legacy_status: string | null;
  message: string;
  owner_id: string | null;
  follow_up_on: string | null;
  /** 20261120020100; absent before that update. */
  demo_on?: string | null;
  submission_count: number;
  created_at: string;
  events: LeadEvent[];
  emails: LeadEmail[];
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
      <ConsolePageHeader eyebrow={groupOf("/admin/leads")}
        title={lead.name}
        description={`${lead.kind === "demo" ? "Demo request" : "Contact message"} · received ${formatDateTime(lead.created_at)}${lead.submission_count > 1 ? ` · sent ${lead.submission_count} times` : ""}`}
        crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Leads", href: "/admin/leads" }, { label: lead.name }]}
        badges={
          <>
            <Badge tone={LEAD_STATUS_TONES[lead.status]}>{LEAD_STATUS_LABELS[lead.status]}</Badge>
            {lead.disposition === "spam" ? <Badge tone="gray">Spam</Badge> : null}
            {lead.onboarding_stage ? <Badge tone="amber">Onboarding: {ONBOARDING_LABELS[lead.onboarding_stage]}</Badge> : null}
            {lead.demo_on ? <Badge tone="blue">Demo {formatDate(lead.demo_on)}</Badge> : null}
          </>
        }
      />
      <AdminFlash error={sp.error} saved={sp.saved} />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Panel>
            <PanelHeader title="Details" />
            <PanelBody>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div><dt className="text-muted">Email</dt><dd><a href={`mailto:${lead.email}`} className="font-semibold underline">{lead.email}</a></dd></div>
                <div><dt className="text-muted">Phone</dt><dd>{lead.phone || "–"}</dd></div>
                <div><dt className="text-muted">Company</dt><dd>{lead.company_name || "–"}</dd></div>
                {lead.kind === "demo" || lead.truck_count !== null ? (
                  <>
                    <div><dt className="text-muted">Hauling trucks</dt><dd>{lead.truck_count ?? "Not given"}</dd></div>
                    <div><dt className="text-muted">Dispatch bases</dt><dd>{lead.base_count ?? "Not given"}</dd></div>
                  </>
                ) : null}
                {lead.role_title ? <div><dt className="text-muted">Role (earlier form)</dt><dd>{lead.role_title}</dd></div> : null}
                {lead.fleet_size ? <div><dt className="text-muted">Fleet size (earlier form)</dt><dd>{lead.fleet_size}</dd></div> : null}
              </dl>
              {lead.message ? (
                <div className="mt-4">
                  <p className="text-sm text-muted">{lead.kind === "demo" ? "What slows their operation down most" : "Message"}</p>
                  <p className="mt-1 rounded-xl bg-surface p-3 text-sm whitespace-pre-wrap">{lead.message}</p>
                </div>
              ) : null}
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title="Emails" description="Every confirmation and notification attempt for this lead. Nothing is sent while email is in preview mode." />
            <PanelBody>
              {lead.emails.length === 0 ? (
                <p className="text-sm text-muted">No email attempts recorded.</p>
              ) : (
                <ul aria-label="Email attempts" className="space-y-2 text-sm">
                  {lead.emails.map((m, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                      <Badge tone={m.status === "sent" ? "green" : m.status === "failed" ? "red" : "gray"}>{EMAIL_STATUS_LABELS[m.status] ?? m.status}</Badge>
                      <span className="font-semibold">{EMAIL_KIND_LABELS[m.kind] ?? m.kind}</span>
                      {m.recipient ? <span className="text-muted">to {m.recipient}</span> : null}
                      <span className="text-xs text-muted">{formatDateTime(m.created_at)}{m.mode === "test" ? " · test mode" : ""}</span>
                      {m.detail ? <p className="w-full text-xs text-muted">{m.detail}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title="History" />
            <PanelBody>
              <ol id="history" className="space-y-3">
                {lead.events.map((e, i) => (
                  <li key={i} className="border-l-2 border-line pl-3 text-sm">
                    <p>
                      <span className="font-semibold">{e.actor}</span> · {leadEventText(e.action)}
                      {leadEventDetail(e, teamNames) ? <span className="text-muted"> · {leadEventDetail(e, teamNames)}</span> : null}
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
            </PanelBody>
          </Panel>
        </div>
        <div className="space-y-5">
          <Panel>
            <PanelHeader title="Work this lead" />
            <PanelBody>
              <form action={updateLead} className="space-y-3">
                <input type="hidden" name="id" value={lead.id} />
                <Field label="Status" htmlFor="status">
                  <Select id="status" name="status" defaultValue={lead.status}>
                    {LEAD_STATUSES.map((s) => (
                      <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>
                    ))}
                  </Select>
                </Field>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="spam" defaultChecked={lead.disposition === "spam"} className="mt-0.5 size-4 accent-brand" />
                  <span>Spam <span className="block text-xs text-muted">Only with Not Proceeding. Hidden from the active queue.</span></span>
                </label>
                {lead.status === "converted" ? (
                  <Field label="Onboarding" htmlFor="onboarding_stage" hint="How far this customer's onboarding has come.">
                    <Select id="onboarding_stage" name="onboarding_stage" defaultValue={lead.onboarding_stage}>
                      {ONBOARDING_STAGES.map((s) => (
                        <option key={s} value={s}>{ONBOARDING_LABELS[s]}</option>
                      ))}
                    </Select>
                  </Field>
                ) : (
                  <input type="hidden" name="onboarding_stage" value={lead.onboarding_stage} />
                )}
                <Field label="Owner" htmlFor="owner">
                  <Select id="owner" name="owner" defaultValue={lead.owner_id ?? ""}>
                    <option value="">Unassigned</option>
                    {team.map((t) => (
                      <option key={t.user_id} value={t.user_id}>{t.full_name || t.email}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Follow up on" htmlFor="follow_up_on">
                  <DateInput id="follow_up_on" name="follow_up_on" defaultValue={lead.follow_up_on ?? ""} />
                </Field>
                {lead.demo_on !== undefined && (
                  <Field label="Demo date" htmlFor="demo_on" hint="The day the demo is booked. Leave empty when none is booked.">
                    <input type="hidden" name="demo_on_was" value={lead.demo_on ?? ""} />
                    <DateInput id="demo_on" name="demo_on" defaultValue={lead.demo_on ?? ""} />
                  </Field>
                )}
                <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
              </form>
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title={TERMS.startOnboarding} description="Creates the company (no users yet) and opens its import page. The lead becomes Converted, with onboarding in progress." />
            <PanelBody>
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
            </PanelBody>
          </Panel>
        </div>
      </div>
    </>
  );
}
