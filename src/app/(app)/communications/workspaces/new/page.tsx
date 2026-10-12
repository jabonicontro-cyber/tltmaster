import { WorkspaceForm } from "@/components/communications/workspace-form";
import { CommunicationsUnavailable } from "@/components/communications/unavailable";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { isOperationalDate, todayIn } from "@/lib/dates";
import { requireAccess, requirePagePermission } from "@/server/auth";
import { isCommunicationsInstalled, loadDirectory, loadWorkspaceChoices } from "@/server/data/communications";

export const metadata = { title: "New workspace" };

export default async function NewWorkspacePage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  await requireAccess();
  if (!(await isCommunicationsInstalled())) return <CommunicationsUnavailable title="New workspace" />;
  const access = await requirePagePermission("comms.operations");
  const sp = await searchParams;
  const date = sp.date && isOperationalDate(sp.date) ? sp.date : todayIn();
  const [directory, choices] = await Promise.all([loadDirectory(), loadWorkspaceChoices(date)]);
  if (!directory) return <CommunicationsUnavailable title="New workspace" />;
  return (
    <>
      <PageHeader
        title="New operational workspace"
        crumbs={[{ label: "Communications", href: "/communications" }]}
        description="A conversation for a job, destination or set of loads. Drivers join and leave automatically as dispatch assigns, replaces or cancels them; a replacement driver sees only pinned context."
      />
      <Card>
        <CardBody>
          <WorkspaceForm date={date} orders={choices.orders} loads={choices.loads} sites={choices.sites}
            staff={directory.filter((p) => p.role !== "driver")} me={access.userId} />
        </CardBody>
      </Card>
    </>
  );
}
