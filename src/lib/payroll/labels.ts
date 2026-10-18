export const PERIOD_STATUS: Record<string, { label: string; tone: "gray" | "blue" | "green" | "amber" | "dark" }> = {
  open: { label: "Open", tone: "blue" },
  in_review: { label: "In review", tone: "amber" },
  approved: { label: "Approved", tone: "dark" },
  exported: { label: "Exported", tone: "dark" },
  reconciled: { label: "Reconciled", tone: "green" },
};

export const RULE_STATUS: Record<string, { label: string; tone: "gray" | "green" | "amber" }> = {
  draft: { label: "Draft — not used", tone: "amber" },
  active: { label: "Active", tone: "green" },
  retired: { label: "Retired", tone: "gray" },
};
