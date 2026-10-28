import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { IncidentReportForm } from "@/components/safety/report-form";
import { clockNow } from "@/lib/safety";
import { requirePagePermission } from "@/server/auth";
import { reportOptions } from "@/server/data/safety";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Report a safety incident" };

/** Office report (safety.manage): any driver and truck of the company. Drivers report from /driver/safety. */
export default async function NewIncidentPage() {
  await requirePagePermission("safety.manage");
  const [{ today, timezone }, options] = await Promise.all([businessToday(), reportOptions()]);
  return (
    <>
      <PageHeader title="Report a safety incident" crumbs={[{ label: "Safety", href: "/safety" }]} description="Write it down as it was reported. The investigation and findings are added on the incident afterwards." />
      <Card className="max-w-3xl">
        <CardBody>
          <IncidentReportForm today={today} now={clockNow(timezone)} trucks={options.trucks} drivers={options.drivers} chooseDriver done="/safety/{id}" />
        </CardBody>
      </Card>
    </>
  );
}
