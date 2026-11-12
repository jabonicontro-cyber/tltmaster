import { COMPANY_CLASS_LABELS, SETUP_STATUS_LABELS, TERMS, setupStatus, type CompanyClass, type SetupStatus } from "@/lib/terminology";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/form";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState, ErrorState, Notice } from "@/components/ui/states";
import { ConsolePageHeader, DataCell, DataHead, DataRow, DataTable, FilterBar, FilterField, groupOf } from "@/components/admin/ui";
import { formatDate } from "@/lib/dates";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Companies" };

interface DirectoryRow {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  created_at: string;
  members: number;
  customers: number;
  trucks: number;
  drivers: number;
  owner_login: boolean;
  imports_in_review: number;
  missing: string[];
  /** 20261120000500; absent before that update (every company is then a production customer). */
  classification?: CompanyClass;
  archived_at?: string | null;
}

type Search = { q?: string; status?: string; setup?: string; sort?: string; type?: string; archived?: string; deleted?: string };

/** Every customer company (demo companies are in Demo Management), with its setup gaps. No business records are shown. */
export default async function CompaniesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().toLowerCase().slice(0, 100);
  const status = sp.status === "active" || sp.status === "inactive" ? sp.status : "";
  // "open" = anything not yet complete (the Launchpad tile links here).
  const setup: SetupStatus | "open" | "" = sp.setup === "open" ? "open" : ((Object.keys(SETUP_STATUS_LABELS) as SetupStatus[]).find((k) => k === sp.setup) ?? "");
  const statusOf = (c: DirectoryRow) => setupStatus(c.missing, SETUP_CHECKS, c.imports_in_review);
  const sort = sp.sort === "name" ? "name" : "newest";
  const type = sp.type === "production" || sp.type === "practice" ? sp.type : "";
  const archived = sp.archived === "include" || sp.archived === "only" ? sp.archived : "";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_company_directory");
  const all = (data ?? []) as DirectoryRow[];
  const rows = all
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.slug.includes(q))
    .filter((c) => !status || (status === "active") === c.active)
    .filter((c) => !setup || (setup === "open" ? statusOf(c) !== "complete" : statusOf(c) === setup))
    // Archived companies are hidden unless asked for; Type narrows to production or practice companies.
    .filter((c) => (archived === "only" ? Boolean(c.archived_at) : archived === "include" ? true : !c.archived_at))
    .filter((c) => !type || (c.classification ?? "production") === type)
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b.created_at.localeCompare(a.created_at)));
  return (
    <>
      <ConsolePageHeader
        eyebrow={groupOf("/admin/companies")}
        title="Companies"
        description={`Customer companies on Taviron and how far their setup has got. Demo companies are under ${TERMS.demoManagement}.`}
        actions={<ButtonLink href="/admin/onboarding">{TERMS.startOnboarding}</ButtonLink>}
      />
      {sp.deleted ? <div className="mb-5"><Notice title="Company permanently deleted">{Number(sp.deleted) || 0} records were removed. The deletion and its counts are kept in the platform audit.</Notice></div> : null}
      <FilterBar aria-label="Filter companies">
        <FilterField label="Search" grow><Input name="q" defaultValue={sp.q ?? ""} placeholder="Company name" /></FilterField>
        <FilterField label="Status">
          <Select name="status" defaultValue={status}><option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option></Select>
        </FilterField>
        <FilterField label="Setup">
          <Select name="setup" defaultValue={setup}><option value="">All</option><option value="open">Not Yet Complete</option>{(Object.entries(SETUP_STATUS_LABELS) as [SetupStatus, string][]).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        </FilterField>
        <FilterField label="Type">
          <Select name="type" defaultValue={type}><option value="">All</option>{(Object.entries(COMPANY_CLASS_LABELS) as Array<[CompanyClass, string]>).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        </FilterField>
        <FilterField label="Archived">
          <Select name="archived" defaultValue={archived}><option value="">Hidden</option><option value="include">Shown</option><option value="only">Only archived</option></Select>
        </FilterField>
        <FilterField label="Sort">
          <Select name="sort" defaultValue={sort}><option value="newest">Newest first</option><option value="name">Name</option></Select>
        </FilterField>
        <Button type="submit" variant="secondary">Apply</Button>
      </FilterBar>
      {error ? (
        <ErrorState
          title={error.code === "PGRST202" ? "The company directory needs a database update" : "Companies could not be loaded"}
          description={error.code === "PGRST202" ? "A Taviron Admin installs it. Onboarding still lists companies." : "Try again in a moment."}
        />
      ) : rows.length === 0 ? (
        <EmptyState title={all.length ? "No company matches" : "No customer companies yet"} description={all.length ? "Change the filters to see more." : "Create the first one in Onboarding."} className="rounded-xl border border-line bg-card" />
      ) : (
        <DataTable aria-label="Customer companies" head={<><DataHead>Company</DataHead><DataHead>Setup</DataHead><DataHead align="right">Users</DataHead><DataHead align="right">Customers</DataHead><DataHead align="right">Trucks</DataHead><DataHead align="right">Drivers</DataHead><DataHead>Created</DataHead></>}>
          {rows.map((c) => (
            <DataRow key={c.id}>
              <DataCell primary>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link href={`/admin/companies/${c.id}`} className="font-semibold text-ink hover:text-brand-fg hover:underline">{c.name}</Link>
                  {c.archived_at ? <Badge>Archived</Badge> : !c.active ? <Badge>Inactive</Badge> : null}
                  {c.classification === "practice" ? <Badge tone="blue">{COMPANY_CLASS_LABELS.practice}</Badge> : null}
                  {c.imports_in_review > 0 ? <Badge tone="amber">{c.imports_in_review} import{c.imports_in_review === 1 ? "" : "s"} to review</Badge> : null}
                </span>
              </DataCell>
              <DataCell label="Setup"><SetupBadge status={statusOf(c)} detail={c.missing.length ? `Missing ${c.missing.join(", ")}` : ""} /></DataCell>
              <DataCell label="Users" align="right">{c.members}</DataCell>
              <DataCell label="Customers" align="right">{c.customers}</DataCell>
              <DataCell label="Trucks" align="right">{c.trucks}</DataCell>
              <DataCell label="Drivers" align="right">{c.drivers}</DataCell>
              <DataCell label="Created" className="whitespace-nowrap text-muted tabular">{formatDate(c.created_at.slice(0, 10))}</DataCell>
            </DataRow>
          ))}
        </DataTable>
      )}
      <p className="mt-3 text-xs text-muted">{rows.length} of {all.length} companies. Setup is complete when the company has an owner login, customers, trucks and drivers.</p>
    </>
  );
}

/** Setup is complete when these four exist: an owner login, customers, trucks and drivers (platform_company_directory). */
const SETUP_CHECKS = 4;

/** The concise status, with what is missing beside it in small text (and as the badge's title). */
function SetupBadge({ status, detail }: { status: SetupStatus; detail: string }) {
  const tone = status === "complete" ? "green" : status === "action_required" ? "amber" : status === "in_progress" ? "blue" : "gray";
  return (
    <span className="flex flex-col items-start gap-0.5">
      <Badge tone={tone}>{SETUP_STATUS_LABELS[status]}</Badge>
      {detail ? <span className="text-xs text-muted">{detail}</span> : null}
    </span>
  );
}
