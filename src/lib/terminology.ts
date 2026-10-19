/**
 * One source for product terms and status labels that appear in several places (owner directive 2026-10-19,
 * "professionalism and consistent terminology"). Navigation items and major actions use Title Case; sentences and
 * helper text stay in sentence case. Change a term here, not in each page.
 */
export const TERMS = {
  /** The prospect-facing demo (public website, demo companies). */
  liveDemo: "Live Demo",
  /** The platform owner's page that runs the demo companies. */
  demoManagement: "Demo Management",
  startOnboarding: "Start Onboarding",
  plans: "Plans",
} as const;

export type SetupStatus = "complete" | "in_progress" | "incomplete" | "action_required";

export const SETUP_STATUS_LABELS: Record<SetupStatus, string> = {
  complete: "Setup Complete",
  in_progress: "Setup In Progress",
  incomplete: "Setup Incomplete",
  action_required: "Action Required",
};

/**
 * A company's setup status from its real records. `missing` lists what setup still lacks (owner login, customers,
 * trucks, drivers); `pendingReviews` counts imports waiting for Taviron's review, which outrank everything else
 * because the next step is ours. Nothing set up yet is Incomplete; some of it is In Progress.
 */
export function setupStatus(missing: readonly string[], totalChecks: number, pendingReviews = 0): SetupStatus {
  if (pendingReviews > 0) return "action_required";
  if (missing.length === 0) return "complete";
  return missing.length >= totalChecks ? "incomplete" : "in_progress";
}

/** Company classification (B67), set only by the platform owner. Managed demos are identified separately (is_demo). */
export type CompanyClass = "production" | "practice";
export const COMPANY_CLASS_LABELS: Record<CompanyClass, string> = { production: "Production Customer", practice: "Practice / Test" };
