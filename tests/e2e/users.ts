export const PASSWORD = process.env.E2E_PASSWORD ?? "E2E-Test-Passw0rd!";

/** Top Line Trucking (company #1, owns the seed data). */
export const TOP_LINE_SLUG = "top-line-trucking";
/** A second, fictional company used only to prove isolation. */
export const OTHER_COMPANY = { slug: "e2e-brookside-aggregates", name: "Brookside Aggregates (e2e test)" };

export const USERS = {
  owner: { email: "e2e-owner@toplinetest.example", name: "Erin Owner", role: "owner", company: TOP_LINE_SLUG },
  office: { email: "e2e-office@toplinetest.example", name: "Omar Office", role: "office", company: TOP_LINE_SLUG },
  dispatcher: { email: "e2e-dispatch@toplinetest.example", name: "Dana Dispatch", role: "dispatcher", company: TOP_LINE_SLUG },
  mechanic: { email: "e2e-mechanic@toplinetest.example", name: "Max Mechanic", role: "mechanic", company: TOP_LINE_SLUG },
  driver: { email: "e2e-driver@toplinetest.example", name: "Drew Driver", role: "driver", company: TOP_LINE_SLUG },
  pending: { email: "e2e-pending@toplinetest.example", name: "Pat Pending", role: null, company: TOP_LINE_SLUG },
  otherOwner: { email: "e2e-brookside-owner@brooksidetest.example", name: "Bea Brookside", role: "owner", company: OTHER_COMPANY.slug },
} as const;

export type UserKey = keyof typeof USERS;

/** A member of the Taviron platform team: no company of their own; platform role granted by the operator function. */
export const PLATFORM_USER = { email: "e2e-platform@tavirontest.example", name: "Pia Platform" } as const;
