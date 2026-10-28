import { MaintenanceTabs } from "@/components/maintenance/tabs";
import { MyJobCard, OpenJobCard, RunningTimer } from "@/components/maintenance/my-jobs";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listMyJobs } from "@/server/data/maintenance-crew";
import { myShiftOffers } from "@/server/data/shift-offers";
import { MyShiftOffers } from "@/components/schedule/shift-offers";

export const metadata = { title: "My jobs" };

/**
 * The mechanic's phone workspace (docs/COMPANION_APP.md): my open jobs with the next step for each, my running timer,
 * and open jobs nobody leads yet. Same work orders, functions and rules as the rest of Maintenance.
 */
export default async function MyJobsPage() {
  const access = await requirePagePermission("maintenance.view");
  const manage = can(access, "maintenance.manage");
  const [jobs, shiftOffers] = await Promise.all([listMyJobs(access.userId), myShiftOffers().catch(() => null)]);

  return (
    <>
      <PageHeader title="Maintenance" description="My jobs: what you are working on, your timer, and open jobs that need a mechanic." />
      <MaintenanceTabs active="my-jobs" />
      {!jobs.installed ? (
        <Notice title="Not available yet">My jobs needs a database update that has not been installed yet.</Notice>
      ) : (
        <div className="mx-auto max-w-2xl">
          {jobs.myTimer && <RunningTimer timer={jobs.myTimer} />}
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
                <MyJobCard key={j.id} job={j} timerHere={jobs.myTimer?.workOrderId === j.id} timerElsewhere={Boolean(jobs.myTimer && jobs.myTimer.workOrderId !== j.id)} />
              ))}
            </ul>
          ) : (
            <EmptyState title="No jobs for you right now" description="When you are added to a work order, or take one below, it shows here." />
          )}
          {manage && jobs.unled.length > 0 && (
            <>
              <h2 className="mt-6 mb-2 text-sm font-semibold text-ink">Needs a mechanic</h2>
              <ul className="space-y-3">
                {jobs.unled.map((j) => <OpenJobCard key={j.id} job={j} me={access.userId} />)}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  );
}
