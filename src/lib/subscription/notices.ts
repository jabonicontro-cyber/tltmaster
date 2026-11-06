// Subscription notices (SUB1): the email for each event the daily run records (migration 20261120008800). Pure text so
// it is unit tested; nothing here sends. Wording follows the owner's policies in master plan §10 and the pricing FAQ:
// reminders before renewal, a 30-day grace when over the plan, and no plan change without notice.

export interface NoticeInput {
  kind: string;
  company: string;
  detail: Record<string, unknown>;
}

export interface NoticeMessage {
  subject: string;
  heading: string;
  paragraphs: string[];
}

const day = (iso: unknown) => {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const money = (cents: unknown) =>
  typeof cents === "number" ? `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "";
const limits = (d: Record<string, unknown>) => {
  const parts: string[] = [];
  if (typeof d.limit_trucks === "number") parts.push(`${d.trucks} trucks (your plan covers ${d.limit_trucks})`);
  if (typeof d.limit_bases === "number") parts.push(`${d.bases} dispatch ${d.bases === 1 ? "base" : "bases"} (your plan covers ${d.limit_bases})`);
  return parts.join(" and ");
};

/** The message for one event, or null for events the customer is not emailed about. */
export function noticeMessage(n: NoticeInput): NoticeMessage | null {
  const d = n.detail ?? {};
  switch (n.kind) {
    case "renewal_reminder":
      return {
        subject: `Your Taviron subscription renews on ${day(d.renews_on)}`,
        heading: "Your subscription renews soon",
        paragraphs: [
          `${n.company}'s annual Taviron subscription${d.plan ? ` (${d.plan})` : ""} renews for another 12 months on ${day(d.renews_on)}.`,
          "Nothing needs doing if you want to continue. To turn renewal off or change your plan, reply to this email before that date.",
        ],
      };
    case "over_limit":
      return {
        subject: `${n.company} is over its Taviron plan`,
        heading: "You have grown past your plan",
        paragraphs: [
          `${n.company} now has ${limits(d)}.`,
          `A 30-day grace period started today and ends on ${day(d.grace_ends_on)}. If you are back within your plan by then, nothing changes. If not, we will tell you which plan fits and from which date, before anything changes.`,
        ],
      };
    case "grace_ending":
      return {
        subject: `Your grace period ends on ${day(d.grace_ends_on)}`,
        heading: "Your grace period ends soon",
        paragraphs: [
          `${n.company} still has ${limits(d)}.`,
          `The grace period ends on ${day(d.grace_ends_on)}. After that we will propose the plan that fits and tell you the date and price before anything changes. Reply to this email with any questions.`,
        ],
      };
    case "back_within_limits":
      return {
        subject: `${n.company} is back within its Taviron plan`,
        heading: "You are back within your plan",
        paragraphs: [`${n.company} is back within its plan. The grace period has ended and nothing changes.`],
      };
    case "tier_change_scheduled":
      return {
        subject: `Your Taviron plan changes on ${day(d.effective_on)}`,
        heading: "Your plan is changing",
        paragraphs: [
          `${n.company} moves to the ${d.plan} plan from ${day(d.effective_on)}, at ${money(d.agreed_monthly_cents)} per month.`,
          typeof d.reason === "string" && d.reason ? `Why: ${d.reason}` : "",
          "Reply to this email if you have questions before that date.",
        ].filter(Boolean),
      };
    case "tier_change_applied":
      return {
        subject: "Your Taviron plan has changed",
        heading: "Your plan has changed",
        paragraphs: [`As announced, ${n.company}'s plan changed on ${day(d.effective_on)}, at ${money(d.agreed_monthly_cents)} per month.`],
      };
    default:
      return null;
  }
}
