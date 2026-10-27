import { AREAS, SEGMENTS } from "./areas";
import { publicHighlights } from "./releases";

// "What's new" is linked only once the owner has approved at least one highlight for publication (releases.ts).
const whatsNew = publicHighlights().length > 0;

// The public website's navigation and footer groups: one list, so the header, the phone menu and the footer agree.
// Every href is a public page (tests/unit/site-areas.test.ts). The Help Center is inside the app (signed in), so it is
// not linked here; Resources lists what exists publicly.

export interface NavLink {
  href: string;
  label: string;
  text?: string;
}

export interface NavGroup {
  label: string;
  /** A plain link (no menu). */
  href?: string;
  links?: NavLink[];
}

export const SITE_NAV: NavGroup[] = [
  {
    label: "Platform",
    links: [
      { href: "/platform", label: "Platform overview", text: "Every capability, with the real screens." },
      ...AREAS.map((a) => ({ href: `/platform/${a.slug}`, label: a.label, text: a.summary })),
    ],
  },
  {
    label: "Solutions",
    links: [
      { href: "/solutions", label: "All solutions", text: "By role and by size of operation." },
      ...SEGMENTS.map((s) => ({ href: `/solutions/${s.slug}`, label: s.label, text: s.summary })),
    ],
  },
  { label: "Pricing", href: "/pricing" },
  {
    label: "Resources",
    links: [
      { href: "/guides", label: "Guides", text: "Step by step through the everyday work." },
      { href: "/compare/spreadsheets", label: "Taviron vs spreadsheets", text: "What changes when the whiteboard and group texts go." },
      { href: "/compare/dispatch-only", label: "All-in-one vs dispatch-only", text: "Why the shop and time off belong with dispatch." },
      { href: "/calculator", label: "Paperwork calculator", text: "What ticket paperwork costs you, from your own numbers." },
      ...(whatsNew ? [{ href: "/whats-new", label: "What's new", text: "The latest release highlights." }] : []),
      { href: "/faq", label: "FAQ", text: "Plain answers about the product, pricing and going live." },
      { href: "/trust", label: "Trust & Security", text: "What protects your data — and what is not in place yet." },
    ],
  },
  {
    label: "Company",
    links: [
      { href: "/about", label: "About Taviron" },
      { href: "/contact", label: "Contact" },
    ],
  },
];

export const FOOTER_GROUPS: Array<{ title: string; links: NavLink[] }> = [
  { title: "Platform", links: [{ href: "/platform", label: "Overview" }, ...AREAS.map((a) => ({ href: `/platform/${a.slug}`, label: a.label }))] },
  { title: "Solutions", links: [...SEGMENTS.map((s) => ({ href: `/solutions/${s.slug}`, label: s.label })), { href: "/pricing", label: "Pricing" }] },
  { title: "Resources", links: [{ href: "/guides", label: "Guides" }, { href: "/compare/spreadsheets", label: "Vs spreadsheets" }, { href: "/compare/dispatch-only", label: "Vs dispatch-only" }, { href: "/calculator", label: "Paperwork calculator" }, ...(whatsNew ? [{ href: "/whats-new", label: "What's new" }] : []), { href: "/faq", label: "FAQ" }, { href: "/trust", label: "Trust & Security" }] },
  { title: "Company", links: [{ href: "/about", label: "About" }, { href: "/contact", label: "Contact" }, { href: "/demo", label: "Request a demo" }, { href: "/login", label: "Sign in" }] },
  { title: "Legal", links: [{ href: "/privacy", label: "Privacy" }, { href: "/terms", label: "Terms" }] },
];
