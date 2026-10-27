// Product release highlights for the public website (master plan §12 B4; docs/DEVELOPMENT_WORKFLOW.md §6). One entry
// per feature worth announcing. Only entries with status "published" AND an approval appear on the website; drafts
// are prepared by the release workflow (Claude may draft one when a feature is verified) and wait for the owner's
// content approval. Internal fixes, unfinished features and anything not ready for a public claim never get an
// entry. Every published claim must also be listed as available in capabilities.ts, and its evidence pages must
// exist (tests/unit/site-releases.test.ts).

export type ReleaseStatus = "draft" | "approved" | "published";

export interface ReleaseHighlight {
  id: string;
  title: string;
  summary: string;
  /** Plain statements of what works today; no performance figures or promises. */
  benefits: string[];
  /** What it does not do yet. Shown with the highlight. */
  limitations: string[];
  /** ISO date the feature reached Production. */
  releasedOn: string;
  /** App pages (under src/app/(app)) where it can be seen. */
  evidence: string[];
  /** Screenshot under public/site (demo company, fictional data), or null. */
  image: { src: string; alt: string } | null;
  status: ReleaseStatus;
  /** Who approved publication and when; required for "approved" and "published". */
  approval: { by: string; on: string } | null;
}

export const RELEASES: ReleaseHighlight[] = [
  {
    id: "speed-metrics",
    title: "Speed, measured",
    summary: "The Command Center now measures how fast the office really works, from what people record.",
    benefits: [
      "Time to plan tomorrow, from the assignments made the day before",
      "Days from delivery to billing-ready, from delivery to ticket acceptance",
      "Ticket review pace, per minute of review time",
    ],
    limitations: ["Shows nothing until enough has been recorded (\u201cnot enough measured yet\u201d)"],
    releasedOn: "2026-10-26",
    evidence: ["/command-center"],
    image: { src: "/site/speed-metrics.png", alt: "Speed measured on the Command Center of the demo company" },
    status: "draft",
    approval: null,
  },
  {
    id: "maintenance-estimates",
    title: "Shop time estimates that learn",
    summary: "Work orders show how long a job usually takes, learned from the time your mechanics actually log.",
    benefits: [
      "Typical hours for each kind of job, from logged labor",
      "The learned range shown on each new work order",
      "Estimate against actual, by kind of job and by mechanic",
    ],
    limitations: ["Needs at least three completed jobs of a kind before it shows a learned time"],
    releasedOn: "2026-10-26",
    evidence: ["/maintenance/estimates"],
    image: { src: "/site/maintenance-estimates.png", alt: "Learned shop time estimates in the demo company" },
    status: "draft",
    approval: null,
  },
  {
    id: "faster-dispatching",
    title: "Faster dispatching",
    summary: "Give each open load the crew that worked its order last time, assign several loads at once, and drag a truck or driver onto a load.",
    benefits: [
      "Copy the previous crew: each open load gets the crew that worked the same order on its last day, for you to review",
      "Assign several loads at once after a pre-check",
      "Drag and drop and keyboard shortcuts on the board",
    ],
    limitations: ["Every assignment is still checked on its own; a load that fails a check is left open with the reason"],
    releasedOn: "2026-10-26",
    evidence: ["/dispatch"],
    image: { src: "/site/dispatch.png", alt: "The dispatch board of the demo company" },
    status: "draft",
    approval: null,
  },
  {
    id: "plan-the-day",
    title: "Plan the day",
    summary: "Every unassigned load planned across the whole fleet at once, ranked by the priorities you choose.",
    benefits: [
      "Safety, qualification, capacity, maintenance and time-off rules are checked before any option is ranked",
      "Compare plans for service, revenue, utilization and workload balance, with the trade-offs spelled out",
      "Nothing is assigned until a dispatcher approves; each approval is re-checked against current data",
    ],
    limitations: [
      "Distances, drive times and hours of service are not calculated yet — each plan says so",
      "Margin is not evaluated until operating costs are recorded",
    ],
    releasedOn: "2026-10-13",
    evidence: ["/dispatch/plan"],
    image: null,
    status: "draft",
    approval: null,
  },
];

/** The highlights the public website may show: published and approved only, newest first. */
export function publicHighlights(all: ReleaseHighlight[] = RELEASES): ReleaseHighlight[] {
  return all.filter((r) => r.status === "published" && r.approval !== null).sort((a, b) => b.releasedOn.localeCompare(a.releasedOn));
}
