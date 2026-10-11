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

type Search = { q?: string; type?: string; status?: string; page?: string };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("customers.view");
  const sp = await searchParams;
  const page = pageParam(sp.page);
  const { rows, total } = await listCustomers({ q: sp.q, type: sp.type, status: sp.status, page });
  const filtered = Boolean(sp.q || sp.type || (sp.status && sp.status !== "active"));

  const hrefFor = (p: number) => {
    const params = new URLSearchParams();
    if (sp.q) params.set("q", sp.q);
    if (sp.type) params.set("type", sp.type);
    if (sp.status) params.set("status", sp.status);
    params.set("page", String(p));
    return `/customers?${params}`;
  };

  return (
    <>
      <PageHeader
        title="Customers"
        description="Commercial and residential customers, their contacts and job sites."
        actions={
          can(access, "customers.edit") && (
            <ButtonLink href="/customers/new" icon={<Plus className="size-4" />}>
              New customer
            </ButtonLink>
          )
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
        </FilterBar>
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
                          {c.po_required && <Badge tone="blue">PO required</Badge>}
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
