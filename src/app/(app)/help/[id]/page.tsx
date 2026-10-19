import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { formatDate } from "@/lib/dates";
import { HELP_CATEGORIES } from "@/lib/help/types";
import { requireAccess } from "@/server/auth";
import { helpFor, myFeedback } from "@/server/help";
import { GuideStart } from "@/components/help/guide-start";
import { sendFeedback } from "../actions";

/** One help article: what the page is for, who uses it, what it shows, how to do the common tasks, and what to do next. */
export default async function HelpArticlePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ feedback?: string }> }) {
  const access = await requireAccess();
  const { id } = await params;
  const sp = await searchParams;
  const { articles, guides } = helpFor(access.permissions);
  const a = articles.find((x) => x.id === id);
  if (!a) notFound(); // not written, or not for this person's role
  const byId = new Map(articles.map((x) => [x.id, x]));
  const guide = guides.find((g) => g.article === a.id);
  const feedback = await myFeedback(a.id);
  const pageHref = a.routes.find((r) => !r.includes("*"));
  const links = (ids: string[]) => ids.map((x) => byId.get(x)).filter((x): x is NonNullable<typeof x> => Boolean(x));

  return (
    <article className="max-w-3xl">
      <PageHeader title={a.title} description={a.summary} crumbs={[{ label: "Help Center", href: "/help" }, { label: HELP_CATEGORIES[a.category], href: `/help?category=${a.category}` }]} />
      <div className="mb-5 flex flex-wrap items-center gap-3 text-sm">
        {pageHref ? <Link href={pageHref} className="font-semibold text-brand-fg underline">Open this page</Link> : null}
        {guide ? <GuideStart id={guide.id} href={guide.steps[0].href ?? guide.steps[0].route.replace(/\/\*$/, "")} label="Show Me How" /> : null}
        <span className="text-muted">Checked against Taviron on {formatDate(a.reviewed)}</span>
      </div>
      <div className="space-y-5">
        <Card><CardBody className="space-y-2"><h2 className="text-base font-semibold">Who uses it</h2><p className="text-[15px]">{a.audience}</p></CardBody></Card>
        <Card><CardBody className="space-y-2"><h2 className="text-base font-semibold">What you see</h2><ul className="list-disc space-y-1 pl-5 text-[15px]">{a.whatYouSee.map((w) => <li key={w}>{w}</li>)}</ul></CardBody></Card>
        {a.tasks.map((t) => (
          <Card key={t.title}><CardBody className="space-y-2"><h2 className="text-base font-semibold">{t.title}</h2><ol className="list-decimal space-y-1 pl-5 text-[15px]">{t.steps.map((s) => <li key={s}>{s}</li>)}</ol></CardBody></Card>
        ))}
        {a.prerequisites.length ? <Card><CardBody className="space-y-2"><h2 className="text-base font-semibold">Before you start</h2><ul className="list-disc space-y-1 pl-5 text-[15px]">{a.prerequisites.map((p) => <li key={p}>{p}</li>)}</ul></CardBody></Card> : null}
        {a.limitations?.length ? <Notice title="Good to know">{a.limitations.join(" ")}</Notice> : null}
        {a.troubleshooting.length ? (
          <Card><CardBody className="space-y-3"><h2 className="text-base font-semibold">If something goes wrong</h2>
            <dl className="space-y-3 text-[15px]">{a.troubleshooting.map((t) => <div key={t.problem}><dt className="font-semibold">{t.problem}</dt><dd className="text-muted">{t.fix}</dd></div>)}</dl>
          </CardBody></Card>
        ) : null}
        {links(a.next).length || links(a.related).length ? (
          <Card><CardBody className="space-y-2"><h2 className="text-base font-semibold">Where to go next</h2>
            <ul className="space-y-1 text-[15px]">{[...links(a.next), ...links(a.related).filter((r) => !a.next.includes(r.id))].map((r) => <li key={r.id}><Link className="font-semibold text-brand-fg underline" href={`/help/${r.id}`}>{r.title}</Link> <span className="text-muted">— {r.summary}</span></li>)}</ul>
          </CardBody></Card>
        ) : null}

        <section id="feedback" aria-labelledby="feedback-heading" className="rounded-lg border border-line bg-card p-4">
          <h2 id="feedback-heading" className="text-base font-semibold">Did this help?</h2>
          {sp.feedback === "yes" || sp.feedback === "no" ? <p role="status" className="mt-1 text-sm text-muted">Thanks — your answer is saved. You can change it any time.</p> : null}
          {sp.feedback === "error" ? <p role="status" className="mt-1 text-sm text-muted">Your answer could not be saved (feedback needs a database update that may not be installed yet).</p> : null}
          <form action={sendFeedback} className="mt-3 space-y-3">
            <input type="hidden" name="article" value={a.id} />
            <label htmlFor="fb-note" className="block text-sm font-semibold">What was missing or wrong? <span className="font-normal text-muted">(optional)</span></label>
            <textarea id="fb-note" name="note" maxLength={1000} rows={2} className="w-full rounded-md border border-line bg-card px-3 py-2 text-[15px] text-ink" />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" name="helpful" value="yes" variant={feedback === true ? "primary" : "secondary"} size="sm" aria-pressed={feedback === true}>Yes, it helped</Button>
              <Button type="submit" name="helpful" value="no" variant={feedback === false ? "primary" : "secondary"} size="sm" aria-pressed={feedback === false}>No</Button>
              <Link href={`/help/contact?from=${encodeURIComponent(`/help/${a.id}`)}&article=${a.id}`} className="ml-auto self-center text-sm font-semibold text-brand-fg underline">Contact support</Link>
            </div>
          </form>
        </section>
      </div>
    </article>
  );
}
