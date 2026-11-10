import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AlertTriangle, CheckCircle2, Smartphone } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { ReadinessBadge } from "@/components/fleet/fleet-badges";
import { DriverActions, QualificationsPanel } from "@/components/fleet/driver-panels";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PhoneSignInQr } from "@/components/accounts/phone-sign-in-qr";
import { FlashToast } from "@/components/ui/flash-toast";
import { PageHeader } from "@/components/ui/page-header";
import { addDays, formatDate, formatDateTime } from "@/lib/dates";
import { EXPIRY_WARNING_DAYS, eligibilityMessage } from "@/lib/fleet/eligibility";
import { can, isMoneyPermission, ROLE_LABELS, type AppRole } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getDriver } from "@/server/data/fleet";
import { managedPasskeys } from "@/server/passkeys";
import { businessToday } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";
import Link from "next/link";

export const metadata = { title: "Driver" };

const HISTORY_LABELS: Record<string, string> = {
  "driver.created": "Driver added",
  "driver.updated": "Driver details edited",
  "driver_qualification.created": "Qualification added",
  "driver_qualification.updated": "Qualification edited",
  "driver_qualification.deleted": "Qualification removed",
};

export default async function DriverPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("fleet.view");
  const { id } = await params;
  const detail = await getDriver(id);
  if (!detail) notFound();
  const { driver: d, qualifications, readiness, audit, names, today } = detail;
  const { timezone } = await businessToday();
  const who = (uid: string | null) => (uid ? names[uid] ?? "Former user" : "System");
  const canEdit = can(access, "fleet.edit");
  const supabase = await createClient();
  const { data: own } = await supabase.from("drivers").select("primary_truck_id").eq("id", d.id).maybeSingle();
  const truckId = (own as { primary_truck_id?: string | null } | null)?.primary_truck_id ?? null;
  const { data: truck } = truckId ? await supabase.from("trucks").select("id, unit_number").eq("id", truckId).maybeSingle() : { data: null };
  // Phone sign-in (no email needed): from here in one step, for a driver without a login. The sign-in is made on the
  // driver's People record so the two stay one person; the wizard links the driver record to it.
  const canSetUpSignIn = !d.user_id && d.active && can(access, "users.manage") && can(access, "employees.edit");
  const person = canSetUpSignIn ? (await supabase.from("employees").select("id, user_id").eq("driver_id", d.id).maybeSingle()).data as { id: string; user_id: string | null } | null : null;
  // Sign in without typing (DS1): a one-time QR code for a driver sign-in, and face or fingerprint sign-in to remove
  // for a lost phone. users.manage, as for resetting a sign-in; the database checks every rule again. In a demo company
  // the code is a labelled sample for any driver (nothing real signs in from a demo; docs/DEMO_TENANTS.md §2).
  const canManageSignIns = d.active && can(access, "users.manage");
  const demoQr = canManageSignIns && Boolean(access.isDemo);
  const driverLogin = canManageSignIns && !access.isDemo && Boolean(d.user_id) && d.account_role === "driver" && d.account_active !== false;
  // Two-step verification is for anyone who can see or change money (SEC4): when this company gave the driver role a
  // money permission, drivers sign in with a password and two-step verification, not a code (the database refuses too).
  const moneyRole = driverLogin
    ? ((await supabase.from("role_permissions").select("permission").eq("role", "driver")).data ?? []).some((r) => isMoneyPermission(String((r as { permission: string }).permission)))
    : false;
  const liveQr = driverLogin && !moneyRole;
  const passkeys = liveQr && d.user_id ? await managedPasskeys(d.user_id) : null;

  return (
    <>
      <Suspense>
        <FlashToast messages={{ saved: { text: "Driver saved." } }} />
      </Suspense>
      <PageHeader
        title={d.display_name}
        crumbs={[{ label: "Fleet", href: "/fleet" }, { label: "Drivers", href: "/fleet/drivers" }, { label: d.display_name }]}
        badges={
          <>
            {d.active ? <ReadinessBadge readiness={readiness} /> : <Badge tone="gray">Inactive</Badge>}
            {d.user_id && <Badge tone="blue">Has login</Badge>}
          </>
        }
        actions={<DriverActions id={d.id} name={d.display_name} active={d.active} canEdit={canEdit} />}
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          {!d.user_id && d.active && (
            <Card>
              <CardHeader title="Phone sign-in" description="So this driver sees their loads and sends tickets from their phone (My Day)." />
              <CardBody>
                {canSetUpSignIn && person && !person.user_id ? (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-muted">No email needed. You get a username and a temporary password to print or show them; they choose their own password the first time they sign in.</p>
                    <ButtonLink href={`/employees/new-sign-in?employee=${person.id}`} icon={<Smartphone className="size-4" />} className="h-12 shrink-0 sm:h-10">Set up phone sign-in</ButtonLink>
                  </div>
                ) : canSetUpSignIn ? (
                  <p className="text-sm text-muted">This driver has no record in People yet. <Link href="/employees" className="font-semibold text-brand-fg underline-offset-2 hover:underline">Open People</Link> to add them, then set up their sign-in there.</p>
                ) : (
                  <p className="text-sm text-muted">No sign-in yet. Someone who manages sign-ins (People → Sign-ins &amp; roles) can set one up; no email is needed.</p>
                )}
                {demoQr ? <div className="mt-3 border-t border-line pt-3"><PhoneSignInQr driverId={d.id} userId={null} driverName={d.display_name} demo passkeys={null} /></div> : null}
              </CardBody>
            </Card>
          )}
          {d.user_id && canManageSignIns && (
            <Card>
              <CardHeader title="Phone sign-in" description="Sign this driver in on their phone without typing, or stop a lost phone signing in with face or fingerprint." />
              <CardBody>
                {liveQr || demoQr ? (
                  <PhoneSignInQr driverId={d.id} userId={d.user_id} driverName={d.display_name} demo={demoQr} passkeys={passkeys} supportVisit={Boolean(access.support)} />
                ) : moneyRole ? (
                  <p className="text-sm text-muted" data-testid="qr-money-refused">QR sign-in is off for drivers here: the driver role can see or change money (Settings → Roles and permissions), so drivers sign in with their username, password and two-step verification. Remove the money permissions from the driver role to use QR codes.</p>
                ) : d.account_active === false ? (
                  <p className="text-sm text-muted">This sign-in is turned off. Turn it on in People first; then you can show a QR code.</p>
                ) : (
                  <p className="text-sm text-muted">QR sign-in is for driver sign-ins only. This login has the role {d.account_role ? (ROLE_LABELS[d.account_role as AppRole] ?? d.account_role) : "of no role"}; they sign in with their username or email and password.</p>
                )}
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Primary truck" description="The truck this driver normally uses. Change it from the truck's page (Fleet → Trucks) or the employee record." />
            <CardBody>
              {truck ? <Link href={`/fleet/trucks/${(truck as { id: string }).id}`} className="font-semibold hover:underline">Truck {(truck as { unit_number: string }).unit_number}</Link> : <p className="text-sm text-muted">No primary truck.</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={`Eligibility today (${formatDate(today)})`} description="Without a specific truck: class B CDL or higher and a medical card. A trailer requires class A." />
            <CardBody>
              {readiness.blockers.length === 0 && readiness.warnings.length === 0 ? (
                <p className="flex items-center gap-2 text-green-800">
                  <CheckCircle2 className="size-5" aria-hidden /> Eligible for assignments.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {readiness.blockers.map((c) => (
                    <li key={c} className="flex items-start gap-2 text-red-800">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {eligibilityMessage(c)}
                    </li>
                  ))}
                  {readiness.warnings.map((c) => (
                    <li key={c} className="flex items-start gap-2 text-amber-900">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {eligibilityMessage(c)}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          <QualificationsPanel
            driverId={d.id}
            qualifications={qualifications}
            today={today}
            soon={addDays(today, EXPIRY_WARNING_DAYS)}
            timezone={timezone}
            names={names}
            canEdit={canEdit}
          />
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DescriptionList
                items={[
                  {
                    label: "User account",
                    value: d.user_id
                      ? `Linked${d.account_role ? `: ${ROLE_LABELS[d.account_role as AppRole] ?? d.account_role}` : ""}${d.account_active === false ? " (account inactive)" : ""}`
                      : "No login",
                  },
                  { label: "Employee number", value: d.employee_number },
                  { label: "Phone", value: d.phone },
                  { label: "Hire date", value: d.hire_date ? formatDate(d.hire_date) : "" },
                  { label: "Status", value: d.active ? "Active" : "Inactive" },
                  { label: "Notes", value: d.notes, wide: true },
                ]}
              />
            </CardBody>
          </Card>
        </div>
        <Card className="self-start">
          <CardHeader title="History" description="Changes to this driver and their qualifications." />
          {audit.length === 0 ? (
            <CardBody>
              <p className="text-sm text-muted">No changes recorded.</p>
            </CardBody>
          ) : (
            <ol className="px-5 py-3 sm:px-6" aria-label="Driver history">
              {audit.map((a) => (
                <li key={a.id} className="relative border-l-2 border-line pb-4 pl-4 last:pb-0">
                  <span className="absolute top-1 -left-[5px] size-2 rounded-full bg-strong" aria-hidden />
                  <p className="text-sm font-semibold">{HISTORY_LABELS[a.action] ?? a.summary}</p>
                  <p className="text-xs text-muted">{formatDateTime(a.occurred_at, timezone)} · {who(a.actor_id)}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}
