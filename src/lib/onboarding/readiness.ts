// Company setup readiness (master plan §12 B11; docs/ONBOARDING.md): what a company administrator still has to set up
// or complete before Taviron's checks, Smart Dispatch and the optimizer can rely on the data. Pure: the server counts
// records with the person's own access (RLS) and this decides what is complete, incomplete or missing — it never
// fills in anything and never treats missing data as fine.

export type ReadinessStatus = "done" | "incomplete" | "missing";

export interface ReadinessCounts {
  company: { name: string; timezone: string; addressComplete: boolean; contactComplete: boolean; hasLogo: boolean };
  users: { active: number; roles: string[] };
  customers: { active: number; withoutBillingAddress: number; withoutEmail: number };
  materials: { active: number; withoutStandardRate: number };
  trucks: { active: number; capacityUnknown: number; capacityUnverified: number; outOfService: number };
  trailers: { active: number; capacityUnknown: number; compatibilityUnknown: number } | null;
  tractors: number;
  drivers: { active: number; withoutValidCdl: number; withoutValidMedical: number; unverified: number; withoutLogin: number };
}

export interface ReadinessItem {
  id: string;
  title: string;
  status: ReadinessStatus;
  /** What is done or what is missing, in plain words. */
  detail: string;
  /** Where to fix it. */
  href: string;
  /** Why it matters for daily work. */
  why: string;
}

export interface Readiness {
  items: ReadinessItem[];
  done: number;
  total: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function assessReadiness(c: ReadinessCounts): Readiness {
  const items: ReadinessItem[] = [];
  const add = (i: ReadinessItem) => items.push(i);

  const companyGaps = [
    !c.company.addressComplete && "address",
    !c.company.contactComplete && "phone or email",
    !c.company.timezone && "time zone",
  ].filter(Boolean) as string[];
  add({
    id: "company", title: "Company profile", href: "/settings?tab=company",
    status: companyGaps.length ? "incomplete" : "done",
    detail: companyGaps.length ? `Missing: ${companyGaps.join(", ")}.` : `${c.company.name} · ${c.company.timezone}${c.company.hasLogo ? " · logo set" : ""}.`,
    why: "Quotes, PDFs and the operating day (what counts as today) use these details.",
  });

  const roles = new Set(c.users.roles);
  const missingRoles = ["dispatcher", "office"].filter((r) => !roles.has(r) && !roles.has("owner"));
  add({
    id: "users", title: "People and roles", href: "/settings?tab=users",
    status: c.users.active <= 1 ? "missing" : missingRoles.length ? "incomplete" : "done",
    detail: c.users.active <= 1 ? "Only one person has access. Invite the people who dispatch, review tickets and bill." : `${plural(c.users.active, "person", "people")} with access (${[...roles].sort().join(", ")}).`,
    why: "Each person sees what their role allows; work is assigned to people, not shared logins.",
  });

  add({
    id: "customers", title: "Customers", href: "/customers",
    status: c.customers.active === 0 ? "missing" : c.customers.withoutBillingAddress ? "incomplete" : "done",
    detail: c.customers.active === 0
      ? "No customers yet. Add them or have your onboarding team import them."
      : `${plural(c.customers.active, "customer")}${c.customers.withoutBillingAddress ? ` · ${c.customers.withoutBillingAddress} without a billing address` : ""}${c.customers.withoutEmail ? ` · ${c.customers.withoutEmail} without an email` : ""}.`,
    why: "Quotes, orders and billing start from the customer record.",
  });

  add({
    id: "materials", title: "Materials and rates", href: "/materials",
    status: c.materials.active === 0 ? "missing" : c.materials.withoutStandardRate ? "incomplete" : "done",
    detail: c.materials.active === 0 ? "No materials yet." : `${plural(c.materials.active, "material")}${c.materials.withoutStandardRate ? ` · ${c.materials.withoutStandardRate} without a standard rate` : ""}.`,
    why: "Rates price quotes and give the optimizer its revenue estimates; a material without a rate has none.",
  });

  add({
    id: "trucks", title: "Trucks and capacity", href: "/fleet/trucks",
    status: c.trucks.active === 0 ? "missing" : c.trucks.capacityUnknown || c.trucks.capacityUnverified ? "incomplete" : "done",
    detail: c.trucks.active === 0
      ? "No trucks yet."
      : `${plural(c.trucks.active, "truck")}${c.trucks.capacityUnknown ? ` · ${c.trucks.capacityUnknown} without a recorded capacity` : ""}${c.trucks.capacityUnverified ? ` · ${c.trucks.capacityUnverified} with unverified capacity` : ""}${c.trucks.outOfService ? ` · ${c.trucks.outOfService} out of service` : ""}.`,
    why: "Dispatch refuses loads above recorded capacity; unknown or unverified capacity makes every plan \"Needs review\".",
  });

  if (c.tractors > 0 || (c.trailers && c.trailers.active > 0)) {
    const t = c.trailers ?? { active: 0, capacityUnknown: 0, compatibilityUnknown: 0 };
    add({
      id: "trailers", title: "Trailers", href: "/fleet/trailers",
      status: c.tractors > 0 && t.active === 0 ? "missing" : t.capacityUnknown || t.compatibilityUnknown ? "incomplete" : "done",
      detail: c.tractors > 0 && t.active === 0
        ? `${plural(c.tractors, "tractor")} but no trailers: a tractor can only be dispatched with a trailer.`
        : `${plural(t.active, "trailer")}${t.capacityUnknown ? ` · ${t.capacityUnknown} without a recorded capacity` : ""}${t.compatibilityUnknown ? ` · ${t.compatibilityUnknown} without compatible truck types` : ""}.`,
      why: "Tractors are planned with a trailer; capacity and compatibility decide which trailer fits.",
    });
  }

  const d = c.drivers;
  const driverGaps = [
    d.withoutValidCdl && `${d.withoutValidCdl} without a valid CDL`,
    d.withoutValidMedical && `${d.withoutValidMedical} without a valid medical card`,
    d.unverified && `${d.unverified} with unverified qualifications`,
  ].filter(Boolean) as string[];
  add({
    id: "drivers", title: "Drivers and qualifications", href: "/fleet/drivers",
    status: d.active === 0 ? "missing" : driverGaps.length ? "incomplete" : "done",
    detail: d.active === 0 ? "No drivers yet." : `${plural(d.active, "driver")}${driverGaps.length ? ` · ${driverGaps.join(" · ")}` : ""}${d.withoutLogin ? ` · ${d.withoutLogin} without a login (no My Day)` : ""}.`,
    why: "A driver without a valid, verified CDL and medical card is never dispatched.",
  });

  return { items, done: items.filter((i) => i.status === "done").length, total: items.length };
}
