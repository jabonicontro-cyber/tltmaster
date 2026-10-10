import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { ReadinessBadge } from "@/components/fleet/fleet-badges";
import { DriverActions, QualificationsPanel } from "@/components/fleet/driver-panels";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { FlashToast } from "@/components/ui/flash-toast";
import { PageHeader } from "@/components/ui/page-header";
import { addDays, formatDate, formatDateTime } from "@/lib/dates";
import { EXPIRY_WARNING_DAYS, eligibilityMessage } from "@/lib/fleet/eligibility";
import { can, ROLE_LABELS, type AppRole } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getDriver } from "@/server/data/fleet";
import { businessToday } from "@/server/data/settings";

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
                      ? `Linked${d.account_role ? ` — ${ROLE_LABELS[d.account_role as AppRole] ?? d.account_role}` : ""}${d.account_active === false ? " (account inactive)" : ""}`
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
            <ol className="px-4 py-3 sm:px-5" aria-label="Driver history">
              {audit.map((a) => (
                <li key={a.id} className="relative border-l-2 border-line pb-4 pl-4 last:pb-0">
                  <span className="absolute top-1 -left-[5px] size-2 rounded-full bg-charcoal" aria-hidden />
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
