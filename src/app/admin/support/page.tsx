import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDateTime } from "@/lib/dates";
import { HELP_ARTICLES } from "@/lib/help/articles";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Support" };

type Overview = {
  searches: number;
  no_results: Array<{ query: string; n: number }>;
  feedback: Array<{ article_id: string; helpful: number; not_helpful: number }>;
  requests: Array<{ id: string; company: string; is_demo: boolean; page: string; article_id: string | null; message: string; status: string; created_at: string }>;
};

/** Support requests sent from Help and what Help is missing (searches with no result, articles marked unhelpful). */
export default async function SupportPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_help_overview");
  const o = data as Overview | null;
  const title = new Map(HELP_ARTICLES.map((a) => [a.id, a.title]));
  return (
    <>
      <PageHeader title="Support" description="Requests customers sent from Help, and where the Help Center falls short — read live from what people did (last 90 days for searches)." crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Support" }]} />
      {error || !o ? (
        <EmptyState title="Not available yet" description="Support requests and help feedback need the database update 20261120000400." />
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader title="Support Requests" description="Written and reviewed by the person before sending. Reply using the contact details on their account; nothing is emailed from Taviron yet." />
            {o.requests.length ? (
              <TableWrap>
                <Table aria-label="Support requests">
                  <thead><tr><Th>Received</Th><Th>Company</Th><Th>Message</Th><Th>From page</Th><Th>Status</Th></tr></thead>
                  <tbody>
                    {o.requests.map((r) => (
                      <Tr key={r.id}>
                        <Td className="whitespace-nowrap text-sm">{formatDateTime(r.created_at)}</Td>
                        <Td>{r.company} {r.is_demo ? <Badge className="ml-1">Demo</Badge> : null}</Td>
                        <Td className="max-w-md text-sm whitespace-pre-wrap">{r.message}</Td>
                        <Td className="text-sm">{r.page || "—"}{r.article_id ? <span className="block text-xs text-muted">{title.get(r.article_id) ?? r.article_id}</span> : null}</Td>
                        <Td><Badge tone={r.status === "new" ? "amber" : "gray"}>{r.status === "new" ? "New" : r.status === "answered" ? "Answered" : "Closed"}</Badge></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            ) : <CardBody><p className="text-sm text-muted">No support requests yet.</p></CardBody>}
          </Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Searches With No Result" description={`${o.searches} searches in the last 90 days. These are the questions the articles do not answer yet.`} />
              <CardBody>
                {o.no_results.length ? (
                  <ul className="divide-y divide-line text-sm" aria-label="Searches with no result">
                    {o.no_results.map((x) => <li key={x.query} className="flex justify-between gap-3 py-1.5"><span>{x.query}</span><span className="tabular text-muted">{x.n}</span></li>)}
                  </ul>
                ) : <p className="text-sm text-muted">None.</p>}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Article Feedback" description="Answers to “Did this help?”, least helpful first." />
              <CardBody>
                {o.feedback.length ? (
                  <ul className="divide-y divide-line text-sm" aria-label="Article feedback">
                    {o.feedback.map((x) => <li key={x.article_id} className="flex justify-between gap-3 py-1.5"><span>{title.get(x.article_id) ?? x.article_id}</span><span className="tabular text-muted">{x.helpful} yes · {x.not_helpful} no</span></li>)}
                  </ul>
                ) : <p className="text-sm text-muted">No feedback yet.</p>}
              </CardBody>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
