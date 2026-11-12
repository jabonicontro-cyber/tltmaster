import { TERMS } from "@/lib/terminology";

/**
 * The platform console's navigation, grouped the way the team works (owner 2026-11-12): one list, so the desktop
 * menus, the section tabs under the header and the phone menu always agree. Every href is a real console page.
 * Labels name the page as its own heading does; `text` is one plain line for a first-day team member.
 */
export interface ConsoleLink {
  href: string;
  label: string;
  text: string;
  /** Other paths that belong to this page (e.g. the profile at /staff/profile). */
  also?: string[];
}

export interface ConsoleGroup {
  label: string;
  links: ConsoleLink[];
}

export const LAUNCHPAD: ConsoleLink = { href: "/admin", label: "Launchpad", text: "What needs the team today." };

export const CONSOLE_GROUPS: ConsoleGroup[] = [
  {
    label: "Sales",
    links: [
      { href: "/admin/leads", label: "Leads", text: "Demo requests and messages from the website." },
      { href: "/admin/outreach", label: "Outreach", text: "Find hauling companies and email them personally." },
    ],
  },
  {
    label: "Customers",
    links: [
      { href: "/admin/companies", label: "Companies", text: "Every customer company and how far its setup has got." },
      { href: "/admin/onboarding", label: "Onboarding", text: "Create a company and import its records." },
      { href: "/admin/plans", label: TERMS.plans, text: "Plan prices, kept as dated versions." },
    ],
  },
  {
    label: "Demos",
    links: [
      { href: "/admin/demo", label: TERMS.demoManagement, text: "Start, refresh and present the demo companies." },
      { href: "/admin/testing-lab", label: "Testing Lab", text: "Open each experience in a demo and record what you checked." },
    ],
  },
  {
    label: "Support",
    links: [
      { href: "/staff", label: "Company access", text: "Go into a customer's company with the owner's permission." },
      { href: "/admin/support", label: "Support", text: "Help requests from customers and gaps in the Help Center." },
      { href: "/staff/work", label: "My visits", text: "Your visits and the changes waiting for an owner's approval." },
    ],
  },
  {
    label: "Admin",
    links: [
      { href: "/admin/platform", label: "Administration", text: "The Taviron team, security and the record of sensitive actions." },
      { href: "/staff/search", label: "Search", text: "Find a company, lead, outreach company, request or team member." },
      { href: "/admin/profile", label: "My profile", text: "Your name and photo as customers see them.", also: ["/staff/profile"] },
    ],
  },
];

/** Support staff (SA1): the company access desk, the support inbox, their own visits and search (PC1); profile in the account menu. */
export const SUPPORT_LINKS: ConsoleLink[] = [
  { href: "/staff", label: "Company access", text: "Go into a customer's company with the owner's permission." },
  { href: "/staff/support", label: "Support inbox", text: "Help requests from customers." },
  { href: "/staff/work", label: "My visits", text: "Your visits and the changes waiting for an owner's approval." },
  { href: "/staff/search", label: "Search", text: "Find a company or a support request." },
];

const ALL = [LAUNCHPAD, ...CONSOLE_GROUPS.flatMap((g) => g.links)];

function matches(path: string, href: string) {
  return href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`);
}

/** The page the path belongs to: the longest matching link (so /staff/profile is My profile, not Company access). */
export function currentLink(path: string, links: ConsoleLink[] = ALL): ConsoleLink | null {
  let best: { link: ConsoleLink; len: number } | null = null;
  for (const l of links) {
    for (const p of [l.href, ...(l.also ?? [])]) {
      if (matches(path, p) && (!best || p.length > best.len)) best = { link: l, len: p.length };
    }
  }
  return best?.link ?? null;
}

/** The group the current page is in, or null on the Launchpad (and on pages outside the menu). */
export function currentGroup(path: string): ConsoleGroup | null {
  const link = currentLink(path);
  return link ? (CONSOLE_GROUPS.find((g) => g.links.includes(link)) ?? null) : null;
}

/** A page's group name, for the small label above its title (ConsolePageHeader `eyebrow`). */
export function groupOf(href: string): string | undefined {
  return CONSOLE_GROUPS.find((g) => g.links.some((l) => l.href === href))?.label;
}
