import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDateTime } from "@/lib/dates";
import { StaffTeam, type StaffInvite, type StaffMember } from "@/components/admin/staff-team";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Administration" };

const ACTIONS: Record<string, string> = {
  admin_granted: "Platform access granted",
  admin_revoked: "Platform access revoked",
  demo_started: "Demo started",
  demo_entered: "Demo opened",
  company_created: "Company created",
  import_staged: "Import staged",
  import_approved: "Import approved",
  import_discarded: "Import discarded",
  import_reverted: "Import reverted",
  staff_invited: "Team invitation sent",
  staff_invite_revoked: "Team invitation withdrawn",
  staff_joined: "Joined the team",
  staff_level_changed: "Team level changed",
  staff_removed: "Removed from the team",
  support_entered: "Entered a company as support",
  support_left: "Left a company",
};

export default async function PlatformAdminPage() {
  const supabase = await createClient();
  const [{ data: team }, { data: audit }, staff, invites] = await Promise.all([
    supabase.rpc("platform_team"),
    supabase.rpc("platform_audit_recent", { p_limit: 200 }),
    // The team with levels and invitations (SA1, 20261120008900); before it is installed, the plain list.
    supabase.rpc("platform_staff_list"),
    supabase.rpc("platform_staff_invites"),
  ]);
  const members = (team ?? []) as Array<{ user_id: string; full_name: string; email: string }>;
  const staffInstalled = !staff.error && !invites.error;
  const log = (audit ?? []) as Array<{ occurred_at: string; actor: string; action: string; target_type: string; target_id: string; summary: string }>;
  return (
    <>
      <PageHeader title="Platform administration" description="Who is on the Taviron team, and every sensitive platform action." crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Administration" }]} />
      <div className="space-y-5">
        <Card>
          {staffInstalled ? (
            <>
              <CardHeader title="Taviron team" description="Invite people from here: they get a link, choose a password and set up an authenticator app. Support goes into customer companies to help; Admin also manages plans, prices, subscriptions and the team. Every change is in the audit log below." />
              <CardBody><StaffTeam members={(staff.data ?? []) as StaffMember[]} invites={(invites.data ?? []) as StaffInvite[]} /></CardBody>
            </>
          ) : (
            <>
              <CardHeader title="Platform team" description="Inviting from here needs the database update 20261120008900. Until then the team is managed by an operator with node scripts/platform-admin.mjs." />
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
        <Card>
          <CardHeader title="Audit log" description="Append-only. Most recent first." />
          <TableWrap className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Who</Th>
                  <Th>What</Th>
                </tr>
              </thead>
              <tbody>
                {log.map((l, i) => (
                  <Tr key={i}>
                    <Td className="whitespace-nowrap">{formatDateTime(l.occurred_at)}</Td>
                    <Td>{l.actor}</Td>
                    <Td>
                      <span className="font-semibold">{ACTIONS[l.action] ?? l.action}</span>
                      {l.summary ? <span className="block text-xs text-muted">{l.summary}</span> : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      </div>
    </>
  );
}
