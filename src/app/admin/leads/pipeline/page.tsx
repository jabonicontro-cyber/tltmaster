import { Notice } from "@/components/ui/states";
import { ConsolePageHeader, groupOf } from "@/components/admin/ui";
import { LeadPipeline, LeadViews } from "@/components/admin/lead-pipeline";
import { todayIn } from "@/lib/dates";
import { leadPipeline } from "@/server/data/console";
import { requirePlatformAdmin } from "@/server/platform";

export const metadata = { title: "Lead pipeline" };

/** Leads by status, with demo dates and follow-ups (PC1). The list view is Leads; both read the same records. */
export default async function LeadPipelinePage() {
  await requirePlatformAdmin();
  const leads = await leadPipeline();
  return (
    <>
      <ConsolePageHeader
        eyebrow={groupOf("/admin/leads")}
        title="Lead pipeline"
        description="Every open lead by status, with its demo date and follow-up. Open a card to change the lead. Spam is left out; converted and not proceeding show the last 90 days."
        actions={<LeadViews current="pipeline" />}
      />
      {leads.ok ? <LeadPipeline leads={leads.data} today={todayIn()} /> : <Notice tone={leads.reason === "error" ? "warning" : "info"} title="Lead pipeline">{leads.message}</Notice>}
    </>
  );
}
