import Link from "next/link";
import { ArrowRight, CircleCheck, CircleDashed, CircleAlert } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { requirePagePermission } from "@/server/auth";
import { getCompanyReadiness } from "@/server/data/readiness";

export const metadata = { title: "Company setup" };

const ICON = { done: CircleCheck, incomplete: CircleAlert, missing: CircleDashed };
const LABEL = { done: "Done", incomplete: "Incomplete", missing: "Not started" };
const TONE = { done: "text-green-700", incomplete: "text-amber-700", missing: "text-muted" };

/**
 * Company setup checklist for administrators (docs/ONBOARDING.md): what is set up, what is incomplete and what is
 * missing before Taviron's checks, Smart Dispatch and Plan the day can rely on the data. Read-only; every link goes
 * to the page where the record is added or fixed. Counts come from the company's own data (RLS).
 */
export default async function SetupPage() {
  const access = await requirePagePermission("settings.manage");
  const readiness = await getCompanyReadiness(access.companyId!).catch((e: unknown) => ({ error: e instanceof Error ? e.message : "The checklist is unavailable." }));
  return (
    <>
      <PageHeader
        title="Company setup"
        description="What Taviron needs before its checks, dispatch suggestions and plans can rely on your data. Nothing here changes a record; each step links to where you add or fix it."
      />
      {"error" in readiness ? (
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-gray-950">{readiness.error}</p>
      ) : (
        <>
          <p className="mb-4 text-sm text-ink" aria-live="polite">
            <span className="font-semibold">{readiness.done} of {readiness.total}</span> steps complete.
          </p>
          <ol className="space-y-3">
            {readiness.items.map((item) => {
              const Icon = ICON[item.status];
              return (
                <li key={item.id} className="rounded-lg border border-line bg-card p-4">
                  <div className="flex items-start gap-3">
                    <Icon className={`mt-0.5 size-5 shrink-0 ${TONE[item.status]}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="font-semibold text-ink">{item.title}</h2>
                        <span className={`text-xs font-semibold ${TONE[item.status]}`}>{LABEL[item.status]}</span>
                      </div>
                      <p className="mt-1 text-sm text-ink">{item.detail}</p>
                      <p className="mt-1 text-xs text-muted">{item.why}</p>
                      {item.status !== "done" && (
                        <Link href={`${item.href}${item.href.includes("?") ? "&" : "?"}back=/setup`} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-brand-fg hover:underline">
                          {item.status === "missing" ? "Start" : "Complete"} {item.title.toLowerCase()} <ArrowRight className="size-4" aria-hidden />
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="mt-6 text-xs text-muted">
            Bringing records over from spreadsheets? Taviron&apos;s onboarding team imports customers, materials, trucks and drivers from CSV
            with a review step before anything is created, and can undo an import that nothing has used yet.
          </p>
        </>
      )}
    </>
  );
}
