import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { ROLE_LABELS, type AppRole } from "@/lib/permissions";
import { createBase, makeDefaultBase, setBaseActive, setCrossBaseDispatch, setPersonBases, updateBase } from "@/app/(app)/settings/bases-actions";
import { BASE_TIMEZONES, type BaseSummary, type DispatchBase } from "@/server/data/bases";

type Person = { id: string; full_name: string; email: string; role: AppRole | null; active: boolean };

/**
 * Settings → Dispatch Bases: the company's bases with live counts, the plan's limit, and (users.manage) who works at
 * which base. Plain forms posting to server actions; the database enforces the limit and the default-base rules.
 */
export function BasesPanel({
  bases,
  summary,
  allowance,
  people,
  access,
  canEdit,
  canManagePeople,
  crossBase,
}: {
  bases: DispatchBase[];
  summary: BaseSummary[];
  allowance: { limit: number | null; active: number } | null;
  people: Person[];
  access: Map<string, string[]> | null;
  canEdit: boolean;
  canManagePeople: boolean;
  /** Smart Dispatch may propose trucks and drivers from another base (null = setting not installed). */
  crossBase: boolean | null;
}) {
  const counts = new Map(summary.map((s) => [s.id, s]));
  const atLimit = allowance?.limit != null && allowance.active >= allowance.limit;
  const active = bases.filter((b) => b.active);
  return (
    <>
      <CardHeader
        title="Dispatch Bases"
        description="The yards or terminals your trucks and drivers work from. Every truck, driver and order belongs to one base, so per-base counts add up to the company total. Deactivating a base keeps its records."
      />
      <CardBody className="space-y-6">
        {allowance ? (
          <p className="text-sm text-muted" aria-label="Plan allowance">
            {allowance.limit == null
              ? `${allowance.active} active base${allowance.active === 1 ? "" : "s"}. Your plan has no base limit.`
              : `${allowance.active} of ${allowance.limit} active base${allowance.limit === 1 ? "" : "s"} included in your plan.`}
          </p>
        ) : null}

        <TableWrap>
          <Table aria-label="Dispatch bases">
            <thead>
              <tr>
                <Th>Base</Th>
                <Th>Location</Th>
                <Th>Time zone</Th>
                <Th align="right">Trucks</Th>
                <Th align="right">Drivers</Th>
                <Th>Status</Th>
                {canEdit ? <Th><span className="sr-only">Actions</span></Th> : null}
              </tr>
            </thead>
            <tbody>
              {bases.map((b) => {
                const c = counts.get(b.id);
                return (
                  <Tr key={b.id}>
                    <Td>
                      <span className="font-semibold">{b.name}</span> <span className="text-xs text-muted">{b.code}</span>
                    </Td>
                    <Td>{[b.city, b.state].filter(Boolean).join(", ") || <span className="text-muted">Not set</span>}</Td>
                    <Td className="whitespace-nowrap">{b.timezone.replace("America/", "").replace("_", " ")}</Td>
                    <Td align="right">{c?.trucks ?? 0}</Td>
                    <Td align="right">{c?.drivers ?? 0}</Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {b.is_default ? <Badge tone="blue">Default</Badge> : null}
                        {b.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}
                      </span>
                    </Td>
                    {canEdit ? (
                      <Td>
                        <div className="flex flex-wrap items-center justify-end gap-2 xl:flex-nowrap">
                          {!b.is_default && b.active ? (
                            <form action={makeDefaultBase}>
                              <input type="hidden" name="id" value={b.id} />
                              <Button type="submit" variant="secondary" size="sm">Make Default</Button>
                            </form>
                          ) : null}
                          {!b.is_default ? (
                            <form action={setBaseActive}>
                              <input type="hidden" name="id" value={b.id} />
                              <input type="hidden" name="active" value={b.active ? "false" : "true"} />
                              <Button type="submit" variant="secondary" size="sm" disabled={!b.active && atLimit} title={!b.active && atLimit ? "Your plan's base limit is reached" : undefined}>
                                {b.active ? "Deactivate" : "Reactivate"}
                              </Button>
                            </form>
                          ) : null}
                          <details className="group">
                            <summary className={buttonClasses("ghost", "sm", "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>Edit</summary>
                            <form action={updateBase} className="mt-2 w-[min(32rem,calc(100vw-4rem))] space-y-3 rounded-xl border border-line bg-surface p-3">
                              <input type="hidden" name="id" value={b.id} />
                              <BaseFields base={b} idPrefix={`edit-${b.code}`} />
                              <Button type="submit" size="sm">Save Base</Button>
                            </form>
                          </details>
                        </div>
                      </Td>
                    ) : null}
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>

        {canEdit ? (
          atLimit ? (
            <Notice title="Base limit reached">
              Your plan includes {allowance!.limit} active base{allowance!.limit === 1 ? "" : "s"}. Deactivate a base to add another, or ask Taviron about a plan with more bases.
            </Notice>
          ) : (
            <details className="rounded-control border border-line bg-card">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Add a Base</summary>
              <form action={createBase} className="space-y-3 border-t border-line p-4">
                <BaseFields idPrefix="new" />
                <Button type="submit">Add Base</Button>
              </form>
            </details>
          )
        ) : null}

        {active.length > 1 && crossBase !== null ? (
          <section aria-labelledby="cross-base-heading" className="space-y-2 border-t border-line pt-6">
            <h3 id="cross-base-heading" className="text-base font-semibold">Cross-Base Dispatch</h3>
            <p className="text-sm text-muted">
              {crossBase
                ? "On: Smart Dispatch may propose a truck or driver from another base, marked with a warning and ranked after the order's own base."
                : "Off: Smart Dispatch proposes only trucks and drivers at the order's base, and says why others were left out."}
            </p>
            {canEdit ? (
              <form action={setCrossBaseDispatch} className="flex flex-wrap items-center gap-3">
                <label className="flex min-h-9 items-center gap-2 text-sm">
                  <input type="checkbox" name="cross_base" defaultChecked={crossBase} className="size-4 accent-brand" />
                  Allow trucks and drivers from other bases
                </label>
                <Button type="submit" variant="secondary" size="sm">Save</Button>
              </form>
            ) : null}
          </section>
        ) : null}

        {canManagePeople && active.length > 1 && access && !people.some((p) => p.active && p.role && p.role !== "owner") ? (
          <p className="border-t border-line pt-6 text-sm text-muted">Once you add people on the People page, you can limit any of them (except owners) to some of your bases here.</p>
        ) : null}
        {canManagePeople && active.length > 1 && access && people.some((p) => p.active && p.role && p.role !== "owner") ? (
          <section aria-labelledby="base-access-heading" className="space-y-3 border-t border-line pt-6">
            <div>
              <h3 id="base-access-heading" className="text-base font-semibold">Who Works Where</h3>
              <p className="text-sm text-muted">
                By default everyone works with every base. Limit a person to some bases and they only see and change those bases&apos; trucks, drivers and orders — the database applies it to every page. Owners always see every base.
              </p>
            </div>
            <TableWrap>
              <Table aria-label="Base access">
                <thead>
                  <tr>
                    <Th>Person</Th>
                    <Th>Bases</Th>
                  </tr>
                </thead>
                <tbody>
                  {people.filter((p) => p.active && p.role && p.role !== "owner").map((p) => {
                    const mine = access.get(p.id) ?? [];
                    return (
                      <Tr key={p.id}>
                        <Td>
                          <span className="font-semibold">{p.full_name || p.email}</span>
                          <span className="block text-xs text-muted">{p.role ? ROLE_LABELS[p.role] : ""}</span>
                        </Td>
                        <Td>
                          <form action={setPersonBases} className="flex flex-wrap items-center gap-x-4 gap-y-2" aria-label={`Bases for ${p.full_name || p.email}`}>
                            <input type="hidden" name="user" value={p.id} />
                            <input type="hidden" name="all_count" value={active.length} />
                            {active.map((b) => (
                              <label key={b.id} className="flex min-h-9 items-center gap-2 text-sm">
                                <input type="checkbox" name="bases" value={b.id} defaultChecked={mine.length === 0 || mine.includes(b.id)} className="size-4 accent-brand" />
                                {b.name}
                              </label>
                            ))}
                            <Button type="submit" variant="secondary" size="sm">Save</Button>
                            {mine.length ? <Badge tone="amber">Limited</Badge> : <span className="text-xs text-muted">Every base</span>}
                          </form>
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
          </section>
        ) : null}
      </CardBody>
    </>
  );
}

function BaseFields({ base, idPrefix }: { base?: DispatchBase; idPrefix: string }) {
  const id = (k: string) => `${idPrefix}-${k}`;
  const zones = base && !BASE_TIMEZONES.includes(base.timezone) ? [base.timezone, ...BASE_TIMEZONES] : BASE_TIMEZONES;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name" htmlFor={id("name")} required><Input id={id("name")} name="name" defaultValue={base?.name} required maxLength={80} /></Field>
      <Field label="Code" htmlFor={id("code")} required hint="Short, e.g. NORTH"><Input id={id("code")} name="code" defaultValue={base?.code} required maxLength={10} pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,9}" className="uppercase" /></Field>
      <Field label="Street address" htmlFor={id("address")} className="sm:col-span-2"><Input id={id("address")} name="address_line1" defaultValue={base?.address_line1} maxLength={160} /></Field>
      <Field label="City" htmlFor={id("city")}><Input id={id("city")} name="city" defaultValue={base?.city} maxLength={80} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="State" htmlFor={id("state")}><Input id={id("state")} name="state" defaultValue={base?.state} maxLength={40} /></Field>
        <Field label="ZIP" htmlFor={id("zip")}><Input id={id("zip")} name="postal_code" defaultValue={base?.postal_code} maxLength={20} /></Field>
      </div>
      <Field label="Time zone" htmlFor={id("tz")}>
        <Select id={id("tz")} name="timezone" defaultValue={base?.timezone ?? "America/Chicago"}>
          {zones.map((z) => <option key={z} value={z}>{z.replace("_", " ")}</option>)}
        </Select>
      </Field>
      <Field label="Contact" htmlFor={id("contact")}><Input id={id("contact")} name="contact_name" defaultValue={base?.contact_name} maxLength={120} /></Field>
      <Field label="Contact phone" htmlFor={id("phone")}><Input id={id("phone")} name="contact_phone" type="tel" defaultValue={base?.contact_phone} maxLength={40} /></Field>
    </div>
  );
}
