import { SETUP_STATUS_LABELS, TERMS, setupStatus, type SetupStatus } from "@/lib/terminology";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
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
}

type Search = { q?: string; status?: string; setup?: string; sort?: string };

/** Every customer company (demo companies are in Demo Management), with its setup gaps. No business records are shown. */
export default async function CompaniesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().toLowerCase().slice(0, 100);
  const status = sp.status === "active" || sp.status === "inactive" ? sp.status : "";
  // "open" = anything not yet complete (the Launchpad tile links here).
  const setup: SetupStatus | "open" | "" = sp.setup === "open" ? "open" : ((Object.keys(SETUP_STATUS_LABELS) as SetupStatus[]).find((k) => k === sp.setup) ?? "");
  const statusOf = (c: DirectoryRow) => setupStatus(c.missing, SETUP_CHECKS, c.imports_in_review);
  const sort = sp.sort === "name" ? "name" : "newest";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_company_directory");
  const all = (data ?? []) as DirectoryRow[];
  const rows = all
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.slug.includes(q))
    .filter((c) => !status || (status === "active") === c.active)
    .filter((c) => !setup || (setup === "open" ? statusOf(c) !== "complete" : statusOf(c) === setup))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b.created_at.localeCompare(a.created_at)));
  return (
    <>
      <PageHeader
        title="Companies"
        description="Customer companies on Taviron and how far their setup has got. Demo companies are under Demo Management."
        crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Companies" }]}
        actions={<Link href="/admin/onboarding" className="text-sm font-semibold text-brand-fg hover:underline">{TERMS.startOnboarding}</Link>}
      />
      <form className="mb-4 flex flex-wrap items-end gap-2" role="search" aria-label="Filter companies">
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Search</span><Input name="q" defaultValue={sp.q ?? ""} placeholder="Name" className="w-56" /></label>
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Status</span>
          <Select name="status" defaultValue={status}><option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option></Select>
        </label>
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Setup</span>
          <Select name="setup" defaultValue={setup}><option value="">All</option><option value="open">Not Yet Complete</option>{(Object.entries(SETUP_STATUS_LABELS) as [SetupStatus, string][]).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        </label>
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Sort</span>
          <Select name="sort" defaultValue={sort}><option value="newest">Newest first</option><option value="name">Name</option></Select>
        </label>
        <Button type="submit" variant="secondary">Apply</Button>
      </form>
      {error ? (
        <ErrorState
          title={error.code === "PGRST202" ? "The company directory needs a database update" : "Companies could not be loaded"}
          description={error.code === "PGRST202" ? "Apply migration 20261118000100 (owner step). Onboarding still lists companies." : "Try again in a moment."}
        />
      ) : rows.length === 0 ? (
        <EmptyState title={all.length ? "No company matches" : "No customer companies yet"} description={all.length ? "Change the filters to see more." : "Create the first one in Onboarding."} />
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Company</Th>
                <Th>Setup</Th>
                <Th align="right">Users</Th>
                <Th align="right">Customers</Th>
                <Th align="right">Trucks</Th>
                <Th align="right">Drivers</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <Tr key={c.id}>
                  <Td>
                    <Link href={`/admin/companies/${c.id}`} className="font-semibold hover:underline">{c.name}</Link>
                    {!c.active ? <Badge className="ml-2">Inactive</Badge> : null}
                    {c.imports_in_review > 0 ? <Badge tone="amber" className="ml-2">{c.imports_in_review} import{c.imports_in_review === 1 ? "" : "s"} to review</Badge> : null}
                  </Td>
                  <Td><SetupBadge status={statusOf(c)} detail={c.missing.length ? `Missing ${c.missing.join(", ")}` : ""} /></Td>
                  <Td align="right">{c.members}</Td>
                  <Td align="right">{c.customers}</Td>
                  <Td align="right">{c.trucks}</Td>
                  <Td align="right">{c.drivers}</Td>
                  <Td className="whitespace-nowrap">{formatDate(c.created_at.slice(0, 10))}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
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
