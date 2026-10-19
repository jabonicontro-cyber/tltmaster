import Link from "next/link";
import { Plus } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { ActiveBadge, Badge, SampleBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listCustomers } from "@/server/data/customers";
import { pageParam, PAGE_SIZE } from "@/server/data/search";

export const metadata = { title: "Customers" };

type Search = { q?: string; type?: string; status?: string; relationship?: string; tag?: string; sort?: string; page?: string };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("customers.view");
  const sp = await searchParams;
  const page = pageParam(sp.page);
  const { rows, total, crm } = await listCustomers({ q: sp.q, type: sp.type, status: sp.status, relationship: sp.relationship, tag: sp.tag, sort: sp.sort, page });
  const filtered = Boolean(sp.q || sp.type || sp.relationship || sp.tag || (sp.status && sp.status !== "active"));
  const exportParams = new URLSearchParams(Object.entries({ q: sp.q, type: sp.type, status: sp.status, relationship: sp.relationship, tag: sp.tag }).filter((e): e is [string, string] => Boolean(e[1])));

  const hrefFor = (p: number) => {
    const params = new URLSearchParams();
    if (sp.q) params.set("q", sp.q);
    if (sp.type) params.set("type", sp.type);
    if (sp.status) params.set("status", sp.status);
    if (sp.relationship) params.set("relationship", sp.relationship);
    if (sp.tag) params.set("tag", sp.tag);
    if (sp.sort) params.set("sort", sp.sort);
    params.set("page", String(p));
    return `/customers?${params}`;
  };

  return (
    <>
      <PageHeader
        title="Customers"
        description="Customers and prospects, their contacts, job sites, activity and follow-ups."
        actions={
          <>
            {crm && <ButtonLink href="/customers/pipeline" variant="secondary">Pipeline</ButtonLink>}
            <ButtonLink href={`/customers/export${exportParams.size ? `?${exportParams}` : ""}`} variant="secondary">Export CSV</ButtonLink>
            {can(access, "customers.edit") && (
              <ButtonLink href="/customers/new" icon={<Plus className="size-4" />}>
                New customer
              </ButtonLink>
            )}
          </>
        }
      />
      <Card>
        <FilterBar action="/customers" query={sp.q} placeholder="Search name, number, email, phone, city…" clearHref="/customers">
          <FilterSelect
            name="type"
            label="Type"
            value={sp.type}
            options={[
              { value: "", label: "All types" },
              { value: "commercial", label: "Commercial" },
              { value: "residential", label: "Residential" },
            ]}
          />
          <FilterSelect
            name="status"
            label="Status"
            value={sp.status ?? "active"}
            options={[
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
              { value: "all", label: "All" },
            ]}
          />
          {crm && (
            <FilterSelect
              name="relationship"
              label="Relationship"
              value={sp.relationship}
              options={[
                { value: "", label: "Customers and prospects" },
                { value: "customer", label: "Customers" },
                { value: "prospect", label: "Prospects" },
              ]}
            />
          )}
          <FilterSelect
            name="sort"
            label="Sort"
            value={sp.sort}
            options={[
              { value: "", label: "Name" },
              { value: "number", label: "Customer number" },
              { value: "newest", label: "Newest first" },
              { value: "updated", label: "Recently updated" },
            ]}
          />
          {sp.tag && <input type="hidden" name="tag" value={sp.tag} />}
        </FilterBar>
        {sp.tag && <p className="px-4 pb-2 text-sm text-muted sm:px-5">Tagged “{sp.tag}” · <Link href="/customers" className="font-semibold text-brand-fg hover:underline">clear</Link></p>}
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? "No customers match these filters" : "No customers yet"}
            description={filtered ? "Try a different search or clear the filters." : "Add your first customer to start quoting."}
            action={
              !filtered && can(access, "customers.edit") ? <ButtonLink href="/customers/new">New customer</ButtonLink> : undefined
            }
          />
        ) : (
          <>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Customer</Th>
                    <Th className="hidden md:table-cell">Type</Th>
                    <Th className="hidden lg:table-cell">Phone</Th>
                    <Th className="hidden lg:table-cell">Email</Th>
                    <Th className="hidden sm:table-cell">City</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <Tr key={c.id}>
                      <Td>
                        <Link href={`/customers/${c.id}`} className="font-semibold text-ink hover:text-brand-fg hover:underline">
                          {c.name}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-muted">
                          <span className="tabular">{c.customer_number}</span>
                          {c.relationship === "prospect" && <Badge tone="amber">Prospect</Badge>}
                          {c.po_required && <Badge tone="blue">PO required</Badge>}
                          {c.tags?.slice(0, 3).map((t) => <Link key={t} href={`/customers?tag=${encodeURIComponent(t)}`} className="rounded bg-surface px-1.5 text-xs hover:underline">{t}</Link>)}
                          <SampleBadge show={c.is_sample} />
                        </div>
                      </Td>
                      <Td className="hidden capitalize md:table-cell">{c.customer_type}</Td>
                      <Td className="hidden whitespace-nowrap lg:table-cell">{c.phone}</Td>
                      <Td className="hidden lg:table-cell">{c.email}</Td>
                      <Td className="hidden sm:table-cell">{[c.billing_city, c.billing_state].filter(Boolean).join(", ")}</Td>
                      <Td>
                        <ActiveBadge active={c.active} />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} hrefFor={hrefFor} />
          </>
        )}
      </Card>
    </>
  );
}
