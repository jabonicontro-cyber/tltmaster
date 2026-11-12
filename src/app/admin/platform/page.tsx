import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Field, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDateTime } from "@/lib/dates";
import { StaffTeam, type StaffInvite, type StaffMember } from "@/components/admin/staff-team";
import { accessScopeText, auditHref, parseAuditFilters, securityEventText, type AuditRow, type SecurityOverview } from "@/lib/platform/console";
import { activityHref, activityText } from "@/lib/platform/launchpad";
import { auditFacets, auditLog, securityOverview } from "@/server/data/console";
import { requirePlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Administration" };

type Search = Promise<Record<string, string | string[] | undefined>>;

/**
 * Administration: the Taviron team, a security overview (counts, no secrets) and the platform audit log with filters
 * (who, what, which company, which days) and paging. Every read is checked again in the database (Admins only).
 */
export default async function PlatformAdminPage({ searchParams }: { searchParams: Search }) {
  await requirePlatformAdmin();
  const filters = parseAuditFilters(await searchParams);
  const supabase = await createClient();
  const [{ data: team }, staff, invites, log, facets, security, companiesRes] = await Promise.all([
    supabase.rpc("platform_team"),
    // The team with levels and invitations (SA1); before it is installed, the plain list.
    supabase.rpc("platform_staff_list"),
    supabase.rpc("platform_staff_invites"),
    auditLog(filters),
    auditFacets(),
    securityOverview(),
    supabase.rpc("platform_support_companies"),
  ]);
  const members = (team ?? []) as Array<{ user_id: string; full_name: string; email: string }>;
  const staffInstalled = !staff.error && !invites.error;
  // Before the filtered log is installed: the latest 200 entries, unfiltered (as before).
  const fallback = log.ok ? null : await supabase.rpc("platform_audit_recent", { p_limit: 200 });
  const rows: AuditRow[] = log.ok
    ? log.data.rows
    : ((fallback?.data ?? []) as Array<Omit<AuditRow, "id" | "actor_id" | "company_id" | "company">>).map((r, i) => ({ ...r, id: i, actor_id: null, company_id: null, company: null }));
  const companies = ((companiesRes.data ?? []) as Array<{ id: string; name: string; is_demo: boolean }>).sort((a, b) => a.name.localeCompare(b.name));
  const filtered = Boolean(filters.actor || filters.action || filters.company || filters.from || filters.to);
  const last = rows[rows.length - 1];
  return (
    <>
      <PageHeader title="Platform administration" description="Who is on the Taviron team, how sign-ins and two-step codes are going, and every sensitive platform action." crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Administration" }]} />
      <div className="space-y-5">
        <Card>
          {staffInstalled ? (
            <>
              <CardHeader title="Taviron team" description="Invite people from here: they get a link, choose a password and set up an authenticator app. Support goes into customer companies to help; Admin also manages plans, prices, subscriptions and the team. Every change is in the audit log below." />
              <CardBody><StaffTeam members={(staff.data ?? []) as StaffMember[]} invites={(invites.data ?? []) as StaffInvite[]} /></CardBody>
            </>
          ) : (
            <>
              <CardHeader title="Platform team" description="Inviting from here is not available on this database yet. Until then, ask the platform owner to add or remove team members." />
              <CardBody>
                <ul className="space-y-2 text-sm">
                  {members.map((m) => (
                    <li key={m.user_id}>
                      <span className="font-semibold">{m.full_name || m.email}</span>
                      {m.full_name ? <span className="block text-xs text-muted">{m.email}</span> : null}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </>
          )}
        </Card>

        {security.ok ? <SecurityCard s={security.data} /> : security.reason === "error" ? <Notice tone="warning" title="Security overview">{security.message}</Notice> : null}

        <Card>
          <div id="audit" className="scroll-mt-24" />
          <CardHeader title="Audit log" description={log.ok ? "Append-only, newest first. Filter by who, what, which company or which days (Central time)." : "Append-only, newest first (the latest 200). Filters are not available on this database yet."} />
          {log.ok && facets.ok ? (
            <CardBody className="border-b border-line">
              <form method="get" action="/admin/platform#audit" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] lg:items-end" aria-label="Filter the audit log">
                <Field label="Who" htmlFor="f-actor">
                  <Select id="f-actor" name="actor" defaultValue={filters.actor}>
                    <option value="">Anyone</option>
                    {facets.data.actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                </Field>
                <Field label="What" htmlFor="f-action">
                  <Select id="f-action" name="action" defaultValue={filters.action}>
                    <option value="">Any action</option>
                    {facets.data.actions.map((a) => <option key={a.action} value={a.action}>{activityText(a.action)} ({a.n})</option>)}
                  </Select>
                </Field>
                <Field label="Company" htmlFor="f-company">
                  <Select id="f-company" name="company" defaultValue={filters.company}>
                    <option value="">Any company</option>
                    {companies.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_demo ? " (demo)" : ""}</option>)}
                  </Select>
                </Field>
                <Field label="From" htmlFor="f-from"><DateInput id="f-from" name="from" defaultValue={filters.from} /></Field>
                <Field label="To" htmlFor="f-to"><DateInput id="f-to" name="to" defaultValue={filters.to} /></Field>
                <div className="flex items-center gap-3">
                  <button type="submit" className={buttonClasses("secondary")}>Filter</button>
                  {filtered ? <Link href="/admin/platform#audit" className="text-sm font-semibold text-brand-fg hover:underline">Clear</Link> : null}
                </div>
              </form>
            </CardBody>
          ) : null}
          {!log.ok && log.reason === "error" ? <CardBody><Notice tone="warning" title="Not filtered">{log.message}</Notice></CardBody> : null}
          {rows.length === 0 ? (
            <CardBody><p className="text-sm text-muted">{filtered ? "No entries match these filters." : "Nothing recorded yet."}</p></CardBody>
          ) : (
            <TableWrap className="rounded-none border-0">
              <Table aria-label="Audit log">
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Who</Th>
                    <Th>What</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l) => {
                    const href = activityHref({ ref_type: l.target_type, ref_id: l.target_id });
                    return (
                      <Tr key={l.id}>
                        <Td className="whitespace-nowrap">{formatDateTime(l.occurred_at)}</Td>
                        <Td>{l.actor}</Td>
                        <Td>
                          <span className="font-semibold">{href ? <Link href={href} className="hover:underline">{activityText(l.action)}</Link> : activityText(l.action)}</span>
                          {l.company ? <span className="ml-2 text-xs text-muted">{l.company}</span> : null}
                          {l.summary ? <span className="block text-xs text-muted">{l.summary}</span> : null}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
          )}
          {log.ok && (log.data.more || filters.before) ? (
            <CardBody className="flex flex-wrap gap-4 border-t border-line text-sm">
              {filters.before ? <Link href={auditHref(filters)} className="font-semibold text-brand-fg hover:underline">Newest entries</Link> : null}
              {log.data.more && last ? <Link href={auditHref(filters, String(last.id))} className="font-semibold text-brand-fg hover:underline">Older entries</Link> : null}
            </CardBody>
          ) : null}
        </Card>
      </div>
    </>
  );
}

function Count({ label, value, sub, warn }: { label: string; value: number; sub: string; warn?: boolean }) {
  return (
    <li className="rounded-xl border border-line bg-card p-3">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular text-ink">{value}</p>
      <p className="text-xs text-muted">{sub}</p>
      {warn ? <Badge tone="amber" className="mt-1">Worth a look</Badge> : null}
    </li>
  );
}

/** Counts and the latest security events; no hashes, codes, addresses or event details are ever read. */
function SecurityCard({ s }: { s: SecurityOverview }) {
  const accessFailed = s.access.reduce((n, a) => n + a.failed_week, 0);
  return (
    <Card>
      <CardHeader title="Security overview" description={`Sign-in and two-step verification attempts across Taviron, counted. As of ${formatDateTime(s.as_of)}.`} />
      <CardBody className="space-y-4">
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Security counts">
          <Count label="Failed sign-ins" value={s.signin_failures.day} sub={`last 24 hours · ${s.signin_failures.week} in 7 days, ${s.signin_failures.logins_week} different sign-in names`} warn={s.signin_failures.day >= 20} />
          <Count label="Wrong authenticator codes" value={s.mfa.failed_day} sub={`last 24 hours · ${s.mfa.failed_week} in 7 days, ${s.mfa.people_failed_week} people`} warn={s.mfa.failed_day >= 10} />
          <Count label="Correct authenticator codes" value={s.mfa.ok_week} sub="in 7 days" />
          <Count label="Wrong access codes" value={accessFailed} sub="website and sign-up access codes, 7 days" />
        </ul>
        {s.access.length > 0 && (
          <ul className="space-y-1 text-sm" aria-label="Access code attempts">
            {s.access.map((a) => <li key={a.scope} className="flex justify-between gap-3"><span>{accessScopeText(a.scope)}</span><span className="tabular text-muted">{a.failed_week} wrong · {a.ok_week} right</span></li>)}
          </ul>
        )}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 text-sm font-semibold text-ink">Security events, last 7 days</h3>
            {s.events.length ? (
              <ul className="divide-y divide-line text-sm" aria-label="Security events by kind">
                {s.events.map((e) => <li key={e.event} className="flex justify-between gap-3 py-1.5"><span>{securityEventText(e.event)}</span><span className="tabular text-muted">{e.n}</span></li>)}
              </ul>
            ) : <p className="text-sm text-muted">None.</p>}
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold text-ink">Latest security events</h3>
            {s.recent.length ? (
              <ul className="divide-y divide-line text-sm" aria-label="Latest security events">
                {s.recent.slice(0, 12).map((e, i) => (
                  <li key={`${e.at}:${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
                    <span>{securityEventText(e.event)} <span className="text-muted">· {e.person}{e.staff ? " (Taviron)" : ""}</span></span>
                    <span className="text-xs text-muted">{formatDateTime(e.at)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">None recorded.</p>}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
