import Link from "next/link";
import { MaintenanceTabs } from "@/components/maintenance/tabs";
import { ShareBar } from "@/components/reports/charts";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/dates";
import { WO_CATEGORIES } from "@/lib/maintenance";
import { learnedEstimate, MIN_JOBS, performanceBy, type Performance } from "@/lib/maintenance-estimate";
import { requirePagePermission } from "@/server/auth";
import { listAssignees } from "@/server/data/maintenance";
import { completedJobs } from "@/server/data/maintenance-estimates";

export const metadata = { title: "Time estimates" };

const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`);

/** Over or under, in words, without judging a single job: within 10% counts as on estimate. */
function Verdict({ v }: { v: number | null }) {
  if (v === null) return <span className="text-muted">—</span>;
  const label = Math.abs(v) <= 0.1 ? "On estimate" : v > 0 ? "Over" : "Under";
  return <span className={cn("font-semibold tabular", Math.abs(v) <= 0.1 ? "text-green-700" : v > 0 ? "text-amber-800" : "text-ink")}>{label} {Math.abs(v) > 0.1 ? `${Math.round(Math.abs(v) * 100)}%` : ""}</span>;
}

function PerfTable({ rows, label, name }: { rows: Performance[]; label: string; name: (k: string) => string }) {
  return (
    rows.length === 0 ? <CardBody><p className="text-sm text-muted">No completed jobs with an estimate yet.</p></CardBody> : (
      <TableWrap>
        <Table aria-label={label}>
          <thead><tr><Th>{label}</Th><Th align="right">Jobs</Th><Th align="right">Estimated</Th><Th align="right">Actual</Th><Th align="right">Result</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.key}>
                <Td className="font-medium">{name(r.key)}</Td>
                <Td align="right" className="tabular">{r.jobs}</Td>
                <Td align="right" className="tabular">{r.estimated} h</Td>
                <Td align="right" className="tabular">{r.actual} h</Td>
                <Td align="right"><Verdict v={r.variance} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
    )
  );
}

/**
 * Maintenance time estimates that learn (B91, owner 2026-10-26): what each kind of job takes from the company's own
 * recorded labor, and the shop's estimates against what the jobs actually took, per kind of job and per lead mechanic.
 * People with cost access only (owner, office). Learning comes only from recorded, completed jobs.
 */
export default async function EstimatesPage() {
  await requirePagePermission("maintenance.costs");
  const [{ installed, jobs }, assignees] = await Promise.all([completedJobs(), listAssignees()]);
  const names = new Map(assignees.map((a) => [a.id, a.name]));
  const byKind = performanceBy(jobs, (j) => j.category);
  const byMechanic = performanceBy(jobs, (j) => j.lead);
  const withEstimate = jobs.filter((j) => j.estimated !== null);
  // What each kind of job takes now, learned from all completed jobs of that category.
  const kinds = [...new Set(jobs.map((j) => j.category))].map((category) => ({
    category,
    learned: learnedEstimate({ category, equipment: null, title: "" }, jobs),
    jobs: jobs.filter((j) => j.category === category).length,
  })).sort((a, b) => b.jobs - a.jobs);
  const maxHours = Math.max(1, ...kinds.map((k) => k.learned?.high ?? 0));

  return (
    <>
      <PageHeader title="Maintenance" description="Shop work, preventive maintenance and returning trucks to service." />
      <MaintenanceTabs active="estimates" />
      {!installed ? (
        <Notice title="Not available yet">Time estimates need the maintenance crew update, which has not been installed yet.</Notice>
      ) : (
        <div className="space-y-5">
          <p className="max-w-3xl text-sm text-muted">
            Learned from the labor your crew recorded on {jobs.length} completed job{jobs.length === 1 ? "" : "s"} in the last 12 months.
            A kind of job needs {MIN_JOBS} completed jobs before Taviron shows a learned time; unusual jobs are left out. Nothing here changes
            an estimate on its own, and nothing comes from AI.
          </p>

          <Card>
            <CardHeader title="What each kind of job takes" description="Typical time (the middle half of jobs) from your own completed work." />
            {kinds.length === 0 ? (
              <CardBody><p className="text-sm text-muted">No completed jobs with recorded labor yet.</p></CardBody>
            ) : (
              <ul className="space-y-4 px-5 pb-5 sm:px-6" aria-label="Learned times">
                {kinds.map((k) => (
                  <li key={k.category} className="grid grid-cols-[10rem_minmax(0,1fr)_13rem] items-center gap-4 text-sm">
                    <span className="font-medium text-ink">{WO_CATEGORIES[k.category as keyof typeof WO_CATEGORIES] ?? k.category}</span>
                    {k.learned ? <ShareBar value={k.learned.hours} max={maxHours} /> : <span className="text-xs text-muted">Needs {MIN_JOBS} completed jobs ({k.jobs} so far)</span>}
                    <span className="text-right tabular">{k.learned ? <><strong>{k.learned.hours} h</strong> <span className="text-muted">({k.learned.low}–{k.learned.high}) · {k.learned.jobs} jobs</span></> : "—"}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader title="Estimate against actual by kind of job" description="Jobs where the shop recorded an estimate before finishing." />
              <PerfTable rows={byKind} label="Kind of job" name={(k) => WO_CATEGORIES[k as keyof typeof WO_CATEGORIES] ?? k} />
            </Card>
            <Card>
              <CardHeader title="Estimate against actual by mechanic" description="By the lead mechanic on each job. Over means the job took longer than estimated." />
              <PerfTable rows={byMechanic} label="Mechanic" name={(k) => names.get(k) ?? "Former member"} />
            </Card>
          </div>

          <Card>
            <CardHeader title="Recent jobs" description={`${withEstimate.length} of ${jobs.length} completed jobs had an estimate.`} />
            {jobs.length === 0 ? (
              <CardBody><p className="text-sm text-muted">No completed jobs with recorded labor yet.</p></CardBody>
            ) : (
              <TableWrap>
                <Table aria-label="Recent jobs">
                  <thead><tr><Th>Job</Th><Th className="hidden md:table-cell">Mechanic</Th><Th className="hidden sm:table-cell">Finished</Th><Th align="right">Estimated</Th><Th align="right">Actual</Th><Th align="right">Result</Th></tr></thead>
                  <tbody>
                    {jobs.slice(0, 25).map((j) => (
                      <Tr key={j.id}>
                        <Td><Link href={`/maintenance/work-orders/${j.id}`} className="font-medium text-ink hover:underline">{j.title}</Link><div className="text-xs text-muted">{WO_CATEGORIES[j.category as keyof typeof WO_CATEGORIES] ?? j.category}</div></Td>
                        <Td className="hidden md:table-cell">{j.lead ? names.get(j.lead) ?? "Former member" : "—"}</Td>
                        <Td className="hidden whitespace-nowrap sm:table-cell">{j.completedAt ? formatDate(j.completedAt.slice(0, 10)) : "—"}</Td>
                        <Td align="right" className="tabular">{j.estimated !== null ? `${j.estimated} h` : "—"}</Td>
                        <Td align="right" className="tabular">{Math.round(j.hours * 10) / 10} h</Td>
                        <Td align="right">{j.estimated !== null ? <Verdict v={(j.hours - j.estimated) / j.estimated} /> : <span className="text-xs text-muted">No estimate</span>}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
