import { AREAS, SEGMENTS } from "./areas";

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
  { title: "Resources", links: [{ href: "/faq", label: "FAQ" }, { href: "/trust", label: "Trust & Security" }, { href: "/demo", label: "Request a demo" }] },
  { title: "Company", links: [{ href: "/about", label: "About" }, { href: "/contact", label: "Contact" }, { href: "/login", label: "Sign in" }] },
  { title: "Legal", links: [{ href: "/privacy", label: "Privacy" }, { href: "/terms", label: "Terms" }] },
];
