import Link from "next/link";
import { MaintenanceTabs } from "@/components/maintenance/tabs";
import { MyJobCard, OpenJobCard, RunningTimer } from "@/components/maintenance/my-jobs";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listMyJobs } from "@/server/data/maintenance-crew";
import { partsSummaryFor } from "@/server/data/parts";
import { partsSummaryText } from "@/lib/maintenance/parts-summary";
import { myShiftOffers } from "@/server/data/shift-offers";
import { MyShiftOffers } from "@/components/schedule/shift-offers";
import { GettingStarted } from "@/components/getting-started/getting-started";
import { BackFromShopPrompt } from "@/components/fleet/shop-decisions";
import { unitsBackFromShop } from "@/server/data/fleet";

export const metadata = { title: "My jobs" };

/**
 * The mechanic's phone workspace (docs/COMPANION_APP.md): my open jobs with the next step for each, my running timer,
 * and open jobs nobody leads yet. Same work orders, functions and rules as the rest of Maintenance.
 */
export default async function MyJobsPage() {
  const access = await requirePagePermission("maintenance.view");
  const manage = can(access, "maintenance.manage");
  const [jobs, shiftOffers, backFromShop] = await Promise.all([
    listMyJobs(access.userId),
    myShiftOffers("shop").catch(() => null),
    // A unit parked by hand whose shop work is all done (20261120015300): the same prompt as Maintenance and Dispatch.
    can(access, "fleet.view") ? unitsBackFromShop() : Promise.resolve([]),
  ]);
  // Parts used on each of my jobs (UX20); the cost only for people who see maintenance costs.
  const parts = await partsSummaryFor(jobs.mine.map((j) => j.id), can(access, "maintenance.costs")).catch(() => new Map());

  return (
    <>
      <PageHeader title="Maintenance" description="My jobs: what you are working on, your timer, and open jobs that need a mechanic." />
      <MaintenanceTabs active="my-jobs" />
      {!jobs.installed ? (
        <Notice title="Not available yet">My jobs needs a database update that has not been installed yet.</Notice>
      ) : (
        <div className="mx-auto max-w-2xl">
          <GettingStarted access={access} place="my-jobs" />
          {jobs.myTimer && <RunningTimer timer={jobs.myTimer} />}
          <BackFromShopPrompt units={backFromShop} wording="parked" canReturn={can(access, "fleet.service") || can(access, "fleet.edit") || can(access, "maintenance.manage")} />
          {/* Shift offers (B102): extra shop shifts this person can take. */}
          {shiftOffers && shiftOffers.length > 0 && (
            <section aria-label="Open shifts" className="mb-5 rounded-2xl border border-line bg-card px-4 pt-3 pb-1">
              <h2 className="text-sm font-semibold text-ink">Open shifts</h2>
              <MyShiftOffers offers={shiftOffers} />
            </section>
          )}
          <h2 className="mb-2 text-sm font-semibold text-ink">My jobs</h2>
          {jobs.mine.length ? (
            <ul className="space-y-3">
              {jobs.mine.map((j) => (
                <MyJobCard key={j.id} job={j} partsText={partsSummaryText(parts.get(j.id))} timerHere={jobs.myTimer?.workOrderId === j.id} timerElsewhere={Boolean(jobs.myTimer && jobs.myTimer.workOrderId !== j.id)} />
              ))}
            </ul>
          ) : (
            <EmptyState title="No jobs for you right now" description="When you are added to a work order, or take one below, it shows here." />
          )}
          {manage && jobs.unled.length > 0 && (
            <>
              <h2 className="mt-6 mb-1 text-sm font-semibold text-ink">Needs a mechanic</h2>
              <p className="mb-2 text-xs text-muted">Nobody leads these yet, new driver reports included. Safety-critical first, then the most urgent, then the oldest.</p>
              <ul className="space-y-3" aria-label="Needs a mechanic">
                {jobs.unled.map((j) => <OpenJobCard key={j.id} job={j} me={access.userId} />)}
              </ul>
              {jobs.unledMore > 0 && (
                <p className="mt-3 text-sm text-muted">
                  {jobs.unledMore} more {jobs.unledMore === 1 ? "job needs" : "jobs need"} a mechanic.{" "}
                  <Link href="/maintenance/work-orders" className="inline-flex min-h-11 items-center font-semibold text-brand-fg underline">See all jobs</Link>
                </p>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
