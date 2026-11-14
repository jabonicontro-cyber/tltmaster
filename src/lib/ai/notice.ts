// Ask Taviron's first-use notice (master plan §11a, docs/AI.md §15b). Each person reads it once per company before the
// assistant answers them; the server records the version they read (public.acknowledge_ai_notice) and the gate checks it
// (src/server/ai/gates.ts). Changing what the notice says means raising AI_NOTICE_VERSION, so everyone sees it again.

export const AI_NOTICE_VERSION = 1;

export const AI_NOTICE = {
  title: "Before you use Ask Taviron",
  points: [
    {
      heading: "What it does",
      text: "It answers questions about your company's work from the records you are allowed to see, with links to them. It only reads: it never assigns, sends, bills or changes anything.",
    },
    {
      heading: "What is sent",
      text: "Your question and the figures needed to answer it go to OpenAI, Taviron's AI provider. Before anything is sent, names of people and customers and order numbers are replaced with codes (like C1 or O2), and email addresses and phone numbers are removed.",
    },
    {
      heading: "What Taviron keeps",
      text: "Only how much was used (counts, to apply limits), never your questions or the answers.",
    },
    {
      heading: "Answers can be wrong",
      text: "Every answer is marked as AI-generated. Check the linked records before you act on it.",
    },
  ],
  privacyHref: "/privacy#ai",
  privacyLabel: "How your data is handled",
  accept: "I understand, continue",
} as const;

/** Whether a stored acknowledgement (user_preferences 'ai_notice' value) covers the current notice. */
export function noticeAccepted(value: unknown): boolean {
  const v = value && typeof value === "object" ? (value as { version?: unknown }).version : null;
  return typeof v === "number" && Number.isInteger(v) && v >= AI_NOTICE_VERSION;
}
