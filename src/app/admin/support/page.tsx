import { EmptyState, Notice } from "@/components/ui/states";
import { SupportInboxList } from "@/components/admin/support-inbox";
import { HELP_ARTICLES } from "@/lib/help/articles";
import { INBOX_FILTERS, type InboxFilter } from "@/lib/platform/console";
import { supportInbox } from "@/server/data/console";
import { createClient } from "@/server/supabase/server";
import { ConsolePageHeader, Panel, PanelBody, PanelHeader, groupOf } from "@/components/admin/ui";

export const metadata = { title: "Support" };

type Overview = {
  searches: number;
  no_results: Array<{ query: string; n: number }>;
  feedback: Array<{ article_id: string; helpful: number; not_helpful: number }>;
  requests: Array<{ id: string; company: string; is_demo: boolean; page: string; article_id: string | null; message: string; status: string; created_at: string }>;
};

/** The support inbox (requests sent from Help, with status, notes and replies) and what Help is missing. */
export default async function SupportPage({ searchParams }: { searchParams: Promise<{ status?: string; error?: string }> }) {
  const sp = await searchParams;
  const filter: InboxFilter = INBOX_FILTERS.some((f) => f.key === sp.status) ? (sp.status as InboxFilter) : "open";
  const supabase = await createClient();
  const [{ data, error }, inbox] = await Promise.all([supabase.rpc("platform_help_overview"), supportInbox(filter)]);
  const o = data as Overview | null;
  const title = new Map(HELP_ARTICLES.map((a) => [a.id, a.title]));
  return (
    <>
      <ConsolePageHeader eyebrow={groupOf("/admin/support")} title="Support" description="Requests customers sent from Help, and where the Help Center falls short, read live from what people did (last 90 days for searches)." crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Support" }]} />
      {sp.error ? <div className="mb-4"><Notice tone="warning" title="Not saved">{sp.error}</Notice></div> : null}
      <div className="space-y-5">
        {inbox.ok ? (
          <SupportInboxList inbox={inbox.data} filter={filter} base="/admin/support" />
        ) : (
          <Notice tone={inbox.reason === "error" ? "warning" : "info"} title="Support inbox">{inbox.message}</Notice>
        )}
        {error || !o ? (
          <EmptyState title="Help feedback is not available yet" description="Searches with no result and article feedback are not recorded on this database yet." />
        ) : (
          <>
            {!inbox.ok && (
              <Panel>
                <PanelHeader title="Support Requests" description="Written and reviewed by the person before sending. Reply using the contact details on their account." />
                {o.requests.length ? (
                  <ul className="divide-y divide-line text-sm" aria-label="Support requests">
                    {o.requests.map((r) => <li key={r.id} className="px-5 py-2.5 sm:px-6"><span className="font-semibold">{r.company}</span> <span className="text-muted">· {r.status}</span><span className="block whitespace-pre-wrap">{r.message}</span></li>)}
                  </ul>
                ) : <PanelBody><p className="text-sm text-muted">No support requests yet.</p></PanelBody>}
              </Panel>
            )}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <Panel>
                <PanelHeader title="Searches With No Result" description={`${o.searches} searches in the last 90 days. These are the questions the articles do not answer yet.`} />
                <PanelBody>
                  {o.no_results.length ? (
                    <ul className="divide-y divide-line text-sm" aria-label="Searches with no result">
                      {o.no_results.map((x) => <li key={x.query} className="flex justify-between gap-3 py-1.5"><span>{x.query}</span><span className="tabular text-muted">{x.n}</span></li>)}
                    </ul>
                  ) : <p className="text-sm text-muted">None.</p>}
                </PanelBody>
              </Panel>
              <Panel>
                <PanelHeader title="Article Feedback" description="Answers to “Did this help?”, least helpful first." />
                <PanelBody>
                  {o.feedback.length ? (
                    <ul className="divide-y divide-line text-sm" aria-label="Article feedback">
                      {o.feedback.map((x) => <li key={x.article_id} className="flex justify-between gap-3 py-1.5"><span>{title.get(x.article_id) ?? x.article_id}</span><span className="tabular text-muted">{x.helpful} yes · {x.not_helpful} no</span></li>)}
                    </ul>
                  ) : <p className="text-sm text-muted">No feedback yet.</p>}
                </PanelBody>
              </Panel>
            </div>
          </>
        )}
      </div>
    </>
  );
}
