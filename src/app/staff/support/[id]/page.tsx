import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Notice } from "@/components/ui/states";
import { SupportRequestView } from "@/components/admin/support-inbox";
import { REQUEST_STATUS_LABELS, REQUEST_STATUS_TONES } from "@/lib/platform/console";
import { supportRequest } from "@/server/data/console";
import { requirePlatformStaff } from "@/server/platform";
import { ConsolePageHeader, groupOf } from "@/components/admin/ui";

export const metadata = { title: "Support request" };

export default async function StaffSupportRequestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string }> }) {
  const me = await requirePlatformStaff();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const r = await supportRequest(id);
  if (!r.ok && r.message === "Request not found.") notFound();
  return (
    <>
      <ConsolePageHeader eyebrow={groupOf("/staff")}
        title={r.ok ? `${r.data.company}: support request` : "Support request"}
        badges={r.ok ? <Badge tone={REQUEST_STATUS_TONES[r.data.status]}>{REQUEST_STATUS_LABELS[r.data.status]}</Badge> : undefined}
        crumbs={[{ label: "Company access", href: "/staff" }, { label: "Support inbox", href: "/staff/support" }, { label: "Request" }]}
      />
      {r.ok ? <SupportRequestView r={r.data} base="/staff/support" level={me.level} saved={sp.saved} error={sp.error} /> : <Notice tone="warning" title="Not available">{r.message}</Notice>}
    </>
  );
}
