import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { formatDateTime } from "@/lib/dates";
import { CHANGE_REQUEST_LABELS, visitEndText } from "@/lib/platform/console";
import { mySupportWork } from "@/server/data/console";
import { requirePlatformStaff } from "@/server/platform";

export const metadata = { title: "My visits and requests" };

/** The signed-in staff member's own support visits and the changes they asked owners to approve. */
export default async function MyWorkPage() {
  await requirePlatformStaff();
  const work = await mySupportWork();
  return (
    <>
      <PageHeader title="My visits and requests" description="The companies you went into, why, and how each visit ended; and the changes you asked an owner to approve." crumbs={[{ label: "Company access", href: "/staff" }, { label: "My visits and requests" }]} />
      {!work.ok ? (
        <Notice tone={work.reason === "error" ? "warning" : "info"} title="Not available">{work.message}</Notice>
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader title="Changes waiting for an owner" description="During a visit, changes to people, roles and sign-ins are sent to an owner of the company to approve in Settings, Taviron support. They expire after 3 days." />
            {work.data.requests.length === 0 ? (
              <CardBody><p className="text-sm text-muted">You have not asked for any change yet.</p></CardBody>
            ) : (
              <ul className="divide-y divide-line" aria-label="My change requests">
                {work.data.requests.map((q) => {
                  const s = CHANGE_REQUEST_LABELS[q.status] ?? { label: q.status, tone: "gray" as const };
                  return (
                    <li key={q.id} className="px-5 py-3 text-sm sm:px-6">
                      <p className="flex flex-wrap items-center gap-2">
                        <Badge tone={s.tone}>{s.label}</Badge>
                        <span className="font-semibold text-ink">{q.company}</span>
                        <span className="ml-auto text-xs text-muted">Asked {formatDateTime(q.created_at)}</span>
                      </p>
                      <p className="mt-1 text-ink">{q.summary}</p>
                      <p className="text-xs text-muted">
                        {q.status === "pending" ? `Expires ${formatDateTime(q.expires_at)}` : q.decided_at ? `${q.decided_by ?? "An owner"} · ${formatDateTime(q.decided_at)}` : ""}
                        {q.result ? ` · ${q.result}` : ""}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="My visits" description="Your last 50 visits, newest first. The company sees the same history in its own audit log." />
            {work.data.visits.length === 0 ? (
              <CardBody><p className="text-sm text-muted">No visits yet. Go into a company from <Link href="/staff" className="font-semibold underline">Company access</Link>.</p></CardBody>
            ) : (
              <ul className="divide-y divide-line" aria-label="My visits">
                {work.data.visits.map((v) => (
                  <li key={v.id} className="px-5 py-3 text-sm sm:px-6">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink">{v.company}</span>
                      {v.is_demo ? <Badge>Demo</Badge> : null}
                      <Badge tone={v.open ? "green" : "gray"}>{visitEndText(v)}</Badge>
                      <span className="ml-auto text-xs text-muted">{formatDateTime(v.started_at)}{v.ended_at ? ` to ${formatDateTime(v.ended_at)}` : ""}</span>
                    </p>
                    <p className="mt-1 text-muted">{v.reason ? `Helping with: ${v.reason}` : "No reason given"}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
