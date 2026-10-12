import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { Field, Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { buttonClasses } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import { draftKey, truckCapacity, truckExclusion } from "@/lib/dispatch/load-build";
import { trimNumber } from "@/lib/fleet/labels";
import { requirePagePermission } from "@/server/auth";
import { buildParams, draftFor, getLoadBuildContext } from "@/server/data/load-build";
import { ApproveLoadBuild } from "./approve-load-build";

export const metadata: Metadata = { title: "Build loads" };

const unitLabel = (u: string | null) => (u === "cu_yd" ? "yd³" : "t");

export default async function LoadBuildPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePagePermission("dispatch.edit");
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getLoadBuildContext(id);
  if (!ctx) notFound();
  const u = unitLabel(ctx.unit);
  const parsed = buildParams.safeParse({ payload: sp.payload || ctx.payloads[0] || undefined, perDay: sp.perDay || undefined, mode: sp.mode || undefined });
  const p = parsed.success ? parsed.data : { mode: "even" as const };
  const draft = parsed.success ? draftFor(ctx, parsed.data) : null;
  const left = Math.max(ctx.orderedQty - ctx.plannedQty, 0);
  const hasWindow = Boolean(ctx.order.window_start && ctx.order.window_end);
  const usable = ctx.unit ? ctx.trucks.filter((t) => truckExclusion(t, ctx.unit!) === null) : [];
  const excluded = ctx.unit ? ctx.trucks.length - usable.length : 0;

  return (
    <>
      <PageHeader
        title="Build loads"
        crumbs={[{ label: "Orders", href: "/orders" }, { label: ctx.order.order_number, href: `/orders/${ctx.order.id}` }, { label: "Build loads" }]}
        description="Split what is left of this order into loads that in-service trucks can carry, spread over its scheduled days. You review the draft; nothing is added until you approve it, and no truck or driver is assigned."
      />

      {ctx.unavailable ? (
        <Notice tone="warning" title="Loads can't be built for this order">
          {ctx.unavailable} <Link href={`/orders/${ctx.order.id}`} className="font-semibold underline">Back to the order</Link>
        </Notice>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="space-y-5">
            <Card>
              <CardHeader title="What is left to plan" />
              <CardBody>
                <DescriptionList
                  items={[
                    { label: "Customer", value: ctx.order.customer_name },
                    { label: "Material", value: ctx.material },
                    { label: "Ordered", value: `${trimNumber(ctx.orderedQty)} ${u}` },
                    { label: "On planned loads", value: `${trimNumber(ctx.plannedQty)} ${u}` },
                    { label: "Left to plan", value: <strong className="tabular">{trimNumber(left)} {u}</strong> },
                    { label: "Scheduled days from today", value: ctx.days.length ? `${ctx.days.length} (${formatDate(ctx.days[0])} – ${formatDate(ctx.days[ctx.days.length - 1])})` : "None" },
                    { label: "Daily time window", value: hasWindow ? `${ctx.order.window_start?.slice(0, 5)}–${ctx.order.window_end?.slice(0, 5)}` : "Not set on the order" },
                  ]}
                />
                {ctx.loadsWithoutQuantity > 0 && (
                  <p className="mt-3 text-sm text-muted">{ctx.loadsWithoutQuantity} planned load{ctx.loadsWithoutQuantity === 1 ? " has" : "s have"} no quantity and {ctx.loadsWithoutQuantity === 1 ? "is" : "are"} not counted.</p>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Draft settings" description={`${usable.length} truck${usable.length === 1 ? "" : "s"} can carry this material${excluded ? `; ${excluded} not counted (out of service, open safety report or no recorded capacity in ${ctx.unit === "ton" ? "tons" : "cubic yards"})` : ""}.`} />
              <CardBody>
                <form method="get" className="space-y-4">
                  <Field label={`Quantity per load (${u})`} htmlFor="payload" hint={ctx.payloads.length ? `Recorded truck capacities: ${ctx.payloads.map((c) => trimNumber(c)).join(", ")} ${u}. A load can go only on a truck that holds at least this much.` : undefined}>
                    <Input id="payload" name="payload" type="number" inputMode="decimal" step="0.001" min="0.001" defaultValue={p.payload ?? ""} required className="tabular" />
                  </Field>
                  <Field label="Loads per day" htmlFor="perDay" hint="How many loads your crew can run on one of these days. Trip times are not calculated yet, so this comes from you.">
                    <Input id="perDay" name="perDay" type="number" inputMode="numeric" min="1" max="200" step="1" defaultValue={p.perDay ?? ""} required className="tabular" />
                  </Field>
                  <Field label="Spread" htmlFor="mode">
                    <Select id="mode" name="mode" defaultValue={p.mode}>
                      <option value="even">Evenly across the scheduled days</option>
                      <option value="earliest">As early as possible</option>
                    </Select>
                  </Field>
                  {!hasWindow && (
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Start time" htmlFor="start">
                        <Input id="start" name="start" type="time" defaultValue={sp.start ?? "07:00"} required />
                      </Field>
                      <Field label="End time" htmlFor="end">
                        <Input id="end" name="end" type="time" defaultValue={sp.end ?? "17:00"} required />
                      </Field>
                    </div>
                  )}
                  <button type="submit" className={buttonClasses("secondary")}>Show draft</button>
                </form>
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title="Draft loads" description="Planned loads only. Smart Dispatch proposes a truck and driver for each once they are on the board, and a dispatcher approves every assignment." />
            <CardBody>
              {!draft ? (
                <p className="text-sm text-muted">Enter the quantity per load and the loads per day, then show the draft.</p>
              ) : !draft.ok ? (
                <Notice tone="warning" title="No draft">
                  <ul className="list-disc space-y-1 pl-5">{draft.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                </Notice>
              ) : (
                <div className="space-y-4">
                  {draft.warnings.length > 0 && (
                    <Notice tone="warning" title="Check before approving">
                      <ul className="list-disc space-y-1 pl-5">{draft.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                    </Notice>
                  )}
                  <TableWrap>
                    <Table aria-label="Draft loads">
                      <thead>
                        <tr>
                          <Th>Load</Th>
                          <Th>Date</Th>
                          <Th align="right">Quantity</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {draft.loads.map((l, i) => (
                          <Tr key={i}>
                            <Td>{i + 1} of {draft.loads.length}</Td>
                            <Td>{formatDate(l.date)}</Td>
                            <Td align="right">{trimNumber(l.quantity)} {u}</Td>
                          </Tr>
                        ))}
                        <tr>
                          <Td className="font-semibold">Total</Td>
                          <Td className="text-sm text-muted">{draft.eligibleTrucks} truck{draft.eligibleTrucks === 1 ? "" : "s"} can carry {trimNumber(p.payload ?? 0)} {u}</Td>
                          <Td align="right" className="font-semibold">{trimNumber(draft.loads.reduce((a, l) => a + l.quantity, 0))} {u}</Td>
                        </tr>
                      </tbody>
                    </Table>
                  </TableWrap>
                  <ApproveLoadBuild
                    orderId={ctx.order.id}
                    payload={p.payload!}
                    perDay={p.perDay!}
                    mode={p.mode}
                    startTime={hasWindow ? undefined : sp.start ?? "07:00"}
                    endTime={hasWindow ? undefined : sp.end ?? "17:00"}
                    reviewed={draftKey(draft.loads)}
                    count={draft.loads.length}
                  />
                </div>
              )}
              {ctx.unit && usable.length > 0 && (
                <details className="mt-4 text-sm">
                  <summary className="cursor-pointer text-muted">Trucks considered ({usable.length})</summary>
                  <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                    {usable.map((t) => (
                      <li key={t.id} className="tabular">{t.unit_number} · {trimNumber(truckCapacity(t, ctx.unit!)!)} {u}{t.capacity_verified_at ? "" : " (unverified)"}</li>
                    ))}
                  </ul>
                </details>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
