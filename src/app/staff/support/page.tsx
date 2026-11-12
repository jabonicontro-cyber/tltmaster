import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { SupportInboxList } from "@/components/admin/support-inbox";
import { INBOX_FILTERS, type InboxFilter } from "@/lib/platform/console";
import { supportInbox } from "@/server/data/console";
import { requirePlatformStaff } from "@/server/platform";

export const metadata = { title: "Support inbox" };

/** The support inbox for Support staff (Admins have the same list under Support in the console). */
export default async function StaffSupportPage({ searchParams }: { searchParams: Promise<{ status?: string; error?: string }> }) {
  await requirePlatformStaff();
  const sp = await searchParams;
  const filter: InboxFilter = INBOX_FILTERS.some((f) => f.key === sp.status) ? (sp.status as InboxFilter) : "open";
  const inbox = await supportInbox(filter);
  return (
    <>
      <PageHeader title="Support inbox" description="Questions people in customer companies sent from Help. Answer from your own email, record the answer here and close the request." crumbs={[{ label: "Company access", href: "/staff" }, { label: "Support inbox" }]} />
      {sp.error ? <div className="mb-4"><Notice tone="warning" title="Not saved">{sp.error}</Notice></div> : null}
      {inbox.ok ? <SupportInboxList inbox={inbox.data} filter={filter} base="/staff/support" /> : <Notice tone={inbox.reason === "error" ? "warning" : "info"} title="Support inbox">{inbox.message}</Notice>}
    </>
  );
}
