import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { FlashToast } from "@/components/ui/flash-toast";
import { Field, Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState, Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { TRUCK_TYPES, TRUCK_TYPE_LABELS } from "@/lib/fleet/labels";
import { DOC_KINDS, DOC_LABELS, OFFER_STATUS, RATE_UNIT_LABELS, RATE_UNITS, documentStatus, offerPay, readyForOffers } from "@/lib/hired-trucks";
import { formatCents } from "@/lib/money";
import { formatTime } from "@/lib/orders/schedule";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { loadHiredTrucks } from "@/server/data/hired-trucks";
import { businessToday } from "@/server/data/settings";
import { addHaulerDriver, addHaulerTruck, confirmOffer, recordAnswer, recordHaulerDocument, saveHauler, sendOffer, withdrawOffer } from "./actions";

export const metadata = { title: "Hired trucks" };

const SAVED = {
  hauler: { text: "Hauler saved." },
  truck: { text: "Truck added to the hauler." },
  driver: { text: "Driver added. Record their CDL and medical card on their driver page before offering them a load." },
  document: { text: "Document recorded." },
  offer: { text: "Offer sent. The hauler's driver answers on My Day." },
  answered: { text: "Answer recorded." },
  confirmed: { text: "Confirmed: the load is assigned to the hired truck." },
  withdrawn: { text: "Offer withdrawn." },
};

/**
 * Hired trucks (B83): owner-operators and subcontracted haulers. Offers go out only when the hauler's documents are on
 * file and current; an accepted offer becomes an assignment only when dispatch confirms it (assign_load). Pay is
 * computed from accepted tickets at the offered rate and is a statement only: nothing is paid or exported.
 */
export default async function HiredTrucksPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const access = await requirePagePermission("dispatch.view");
  const sp = await searchParams;
  const { today } = await businessToday();
  const data = await loadHiredTrucks(today);
  const header = <PageHeader title="Hired trucks" description="Owner-operators and subcontracted haulers: their documents, the loads offered to them and what they earned." />;
  if (!data) return <>{header}<ErrorState title="Hired trucks need a database update" description="Apply migration 20261120003700 (owner step). Dispatch keeps working as before." /></>;
  if (!data.enabled) {
    return (
      <>
        {header}
        <Notice title="Not switched on for this company">Hired trucks is an add-on. The Taviron team switches it on for your company; ask us if you work with owner-operators or subcontracted haulers.</Notice>
      </>
    );
  }
  const fleetEdit = can(access, "fleet.edit");
  const dispatchEdit = can(access, "dispatch.edit");
  const seePay = can(access, "payroll.manage") || can(access, "billing.view");
  const crews = data.haulers.filter((h) => h.active).flatMap((h) => {
    const status = documentStatus(h.docs, h.trucks.map((t) => t.id), today);
    return h.trucks.flatMap((t) => h.drivers.map((d) => ({ value: `${t.id}:${d.id}`, label: `${h.name} · Truck ${t.unit_number} · ${d.name}${readyForOffers(status, t.id) ? "" : " (documents missing or expired)"}`, ready: readyForOffers(status, t.id) })));
  });
  const open = data.offers.filter((o) => o.status === "offered" || o.status === "accepted");
  const confirmed = data.offers.filter((o) => o.status === "confirmed");
  const closed = data.offers.filter((o) => o.status === "declined" || o.status === "withdrawn").slice(0, 10);
  const haulerName = new Map(data.haulers.map((h) => [h.id, h.name]));
  const truckName = new Map(data.haulers.flatMap((h) => h.trucks.map((t) => [t.id, t.unit_number] as const)));
  const driverName = new Map(data.haulers.flatMap((h) => h.drivers.map((d) => [d.id, d.name] as const)));
  const when = (o: (typeof data.offers)[number]) => `${formatDate(o.load.load_date)} ${formatTime(o.load.start_time)}`;

  return (
    <>
      <FlashToast messages={SAVED} />
      {header}
      {sp.error && <div className="mb-4"><Notice tone="warning" title="Not saved">{sp.error}</Notice></div>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Open offers" description="Waiting for the hauler, or accepted and waiting for you to confirm. Confirming assigns the load with every dispatch check." />
          {open.length === 0 ? (
            <EmptyState title="No open offers" description="Offer a load to a hired truck on the right." className="py-8" />
          ) : (
            <ul className="divide-y divide-line" aria-label="Open offers">
              {open.map((o) => (
                <li key={o.id} className="space-y-2 px-5 py-3 sm:px-6" aria-label={`Offer for ${o.load.order_number} load ${o.load.load_number}`}>
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{o.load.order_number} load {o.load.load_number} · {when(o)}</p>
                    <p className="text-sm text-muted">{haulerName.get(o.hauler_id)} · Truck {truckName.get(o.truck_id)} · {driverName.get(o.driver_id)} · {formatCents(o.rate_cents)} {RATE_UNIT_LABELS[o.rate_unit]}{o.load.site ? ` · ${o.load.site}` : ""}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={OFFER_STATUS[o.status].tone}>{OFFER_STATUS[o.status].label}</Badge>
                  {dispatchEdit && (
                    <div className="flex flex-wrap gap-2">
                      {o.status === "accepted" && (
                        <form action={confirmOffer}><input type="hidden" name="offer_id" value={o.id} /><SubmitButton size="sm">Confirm and assign</SubmitButton></form>
                      )}
                      {o.status === "offered" && (
                        <form action={recordAnswer} className="flex gap-1">
                          <input type="hidden" name="offer_id" value={o.id} />
                          <SubmitButton size="sm" variant="secondary" name="answer" value="accept">Accepted by phone</SubmitButton>
                          <SubmitButton size="sm" variant="secondary" name="answer" value="decline">Declined by phone</SubmitButton>
                        </form>
                      )}
                      <form action={withdrawOffer}><input type="hidden" name="offer_id" value={o.id} /><SubmitButton size="sm" variant="ghost">Withdraw</SubmitButton></form>
                    </div>
                  )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {closed.length > 0 && (
            <p className="border-t border-line px-5 py-3 text-xs text-muted sm:px-6">
              Recently closed: {closed.map((o) => `${o.load.order_number} load ${o.load.load_number} (${OFFER_STATUS[o.status].label.toLowerCase()}${o.by_phone ? ", by phone" : ""})`).join(" · ")}
            </p>
          )}
        </Card>

        {dispatchEdit && (
          <Card>
            <CardHeader title="Offer a load" description="Only haulers whose documents are on file and current can be offered a load; Taviron checks again when you send." />
            <CardBody>
              {crews.length === 0 ? (
                <p className="text-sm text-muted">Add a hauler with a truck and a driver below first.</p>
              ) : data.openLoads.length === 0 ? (
                <p className="text-sm text-muted">No open loads in the next two weeks.</p>
              ) : (
                <form action={sendOffer} className="space-y-3" aria-label="Offer a load">
                  <Field label="Load" htmlFor="load_id">
                    <Select id="load_id" name="load_id" required>{data.openLoads.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</Select>
                  </Field>
                  <Field label="Hired truck and driver" htmlFor="crew">
                    <Select id="crew" name="crew" required>{crews.map((c) => <option key={c.value} value={c.value} disabled={!c.ready}>{c.label}</option>)}</Select>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Rate ($)" htmlFor="rate"><Input id="rate" name="rate" inputMode="decimal" placeholder="95.00" required /></Field>
                    <Field label="Paid" htmlFor="rate_unit">
                      <Select id="rate_unit" name="rate_unit">{RATE_UNITS.map((u) => <option key={u} value={u}>{RATE_UNIT_LABELS[u]}</option>)}</Select>
                    </Field>
                  </div>
                  <Field label="Note for the hauler (optional)" htmlFor="note"><Input id="note" name="note" maxLength={500} /></Field>
                  <SubmitButton pendingLabel="Sending…">Send the offer</SubmitButton>
                  <p className="text-xs text-muted">No text message is sent yet: the hauler&apos;s driver sees the offer on My Day, or you record their answer by phone.</p>
                </form>
              )}
            </CardBody>
          </Card>
        )}
      </div>

      <h2 className="mt-9 mb-3 text-lg font-semibold text-ink">Haulers</h2>
      {data.haulers.length === 0 && <EmptyState title="No haulers yet" description={fleetEdit ? "Add the first hauler below." : "Ask someone who manages the fleet to add your haulers."} />}
      <div className="space-y-5">
        {data.haulers.map((h) => {
          const status = documentStatus(h.docs, h.trucks.map((t) => t.id), today);
          const blocking = status.filter((s) => s.state !== "current");
          return (
            <section key={h.id} aria-label={`Hauler ${h.name}`}>
            <Card>
              <CardHeader
                title={<span className="flex items-center gap-2">{h.name}{!h.active && <Badge tone="gray">Inactive</Badge>}</span>}
                description={[h.contact_name, h.phone, h.email].filter(Boolean).join(" · ") || "No contact recorded"}
                actions={blocking.length ? <Badge tone="amber">{blocking.length} document{blocking.length === 1 ? "" : "s"} to fix</Badge> : <Badge tone="green">Ready for offers</Badge>}
              />
              <CardBody className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <section aria-label={`${h.name} documents`}>
                  <h3 className="mb-2 text-sm font-semibold text-ink">Documents</h3>
                  <ul className="space-y-1.5 text-sm">
                    {status.map((s) => (
                      <li key={`${s.kind}-${s.truckId ?? ""}`} className="flex items-center justify-between gap-2">
                        <span>{DOC_LABELS[s.kind]}{s.truckId ? ` · Truck ${truckName.get(s.truckId)}` : ""}</span>
                        <Badge tone={s.state === "current" ? "green" : "amber"}>{s.state === "missing" ? "Missing" : s.state === "expired" ? `Expired ${formatDate(s.expiresOn)}` : s.expiresOn ? `Until ${formatDate(s.expiresOn)}` : "On file"}</Badge>
                      </li>
                    ))}
                  </ul>
                  {fleetEdit && (
                    <form action={recordHaulerDocument} className="mt-3 grid grid-cols-2 gap-2" aria-label={`Record a document for ${h.name}`}>
                      <input type="hidden" name="hauler_id" value={h.id} />
                      <Select name="kind" aria-label="Document">{DOC_KINDS.map((k) => <option key={k} value={k}>{DOC_LABELS[k]}</option>)}</Select>
                      <Select name="truck_id" aria-label="Truck (registration and inspection)"><option value="">Whole hauler</option>{h.trucks.map((t) => <option key={t.id} value={t.id}>Truck {t.unit_number}</option>)}</Select>
                      <Input name="reference" placeholder="Policy or document number" aria-label="Reference" maxLength={120} />
                      <DateInput name="expires_on" aria-label="Expires on" />
                      <div className="col-span-2"><SubmitButton size="sm" variant="secondary">Record document</SubmitButton></div>
                    </form>
                  )}
                </section>
                <section aria-label={`${h.name} trucks and drivers`} className="space-y-4">
                  <div>
                    <h3 className="mb-2 text-sm font-semibold text-ink">Trucks</h3>
                    {h.trucks.length === 0 ? <p className="text-sm text-muted">No trucks yet.</p> : (
                      <ul className="text-sm">{h.trucks.map((t) => <li key={t.id}><Link href={`/fleet/trucks/${t.id}`} className="font-semibold hover:underline">Truck {t.unit_number}</Link> <span className="text-muted">· {TRUCK_TYPE_LABELS[t.truck_type as keyof typeof TRUCK_TYPE_LABELS] ?? t.truck_type}</span></li>)}</ul>
                    )}
                    {fleetEdit && (
                      <form action={addHaulerTruck} className="mt-2 flex flex-wrap gap-2" aria-label={`Add a truck for ${h.name}`}>
                        <input type="hidden" name="hauler_id" value={h.id} />
                        <Input name="unit_number" placeholder="Unit" aria-label="Unit number" className="w-24" required maxLength={20} />
                        <Select name="truck_type" aria-label="Truck type" className="w-44">{TRUCK_TYPES.map((t) => <option key={t} value={t}>{TRUCK_TYPE_LABELS[t]}</option>)}</Select>
                        <Input name="plate" placeholder="Plate" aria-label="License plate" className="w-28" maxLength={15} />
                        <SubmitButton size="sm" variant="secondary">Add truck</SubmitButton>
                      </form>
                    )}
                  </div>
                  <div>
                    <h3 className="mb-2 text-sm font-semibold text-ink">Drivers</h3>
                    {h.drivers.length === 0 ? <p className="text-sm text-muted">No drivers yet.</p> : (
                      <ul className="text-sm">
                        {h.drivers.map((d) => (
                          <li key={d.id}>
                            <Link href={`/fleet/drivers/${d.id}`} className="font-semibold hover:underline">{d.name}</Link>
                            <span className="text-muted"> · {d.linked ? "signs in to answer offers" : "no sign-in yet: offers are answered by phone"}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {fleetEdit && (
                      <form action={addHaulerDriver} className="mt-2 flex flex-wrap gap-2" aria-label={`Add a driver for ${h.name}`}>
                        <input type="hidden" name="hauler_id" value={h.id} />
                        <Input name="name" placeholder="Driver name" aria-label="Driver name" className="w-44" required maxLength={120} />
                        <Input name="phone" placeholder="Phone" aria-label="Driver phone" className="w-36" maxLength={40} />
                        <SubmitButton size="sm" variant="secondary">Add driver</SubmitButton>
                      </form>
                    )}
                  </div>
                </section>
              </CardBody>
            </Card>
            </section>
          );
        })}
        {fleetEdit && (
          <Card>
            <CardHeader title="Add a hauler" description="An owner-operator or subcontracting company you hire trucks from." />
            <CardBody>
              <form action={saveHauler} className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Add a hauler">
                <Field label="Name" htmlFor="h-name"><Input id="h-name" name="name" required maxLength={120} /></Field>
                <Field label="Contact" htmlFor="h-contact"><Input id="h-contact" name="contact_name" maxLength={120} /></Field>
                <Field label="Phone" htmlFor="h-phone"><Input id="h-phone" name="phone" maxLength={40} /></Field>
                <Field label="Email" htmlFor="h-email"><Input id="h-email" name="email" type="email" maxLength={200} /></Field>
                <div className="sm:col-span-2"><SubmitButton>Add hauler</SubmitButton></div>
              </form>
            </CardBody>
          </Card>
        )}
      </div>

      {seePay && (
        <>
          <h2 className="mt-9 mb-3 text-lg font-semibold text-ink">Hauler pay</h2>
          <Card>
            <CardHeader title="Confirmed jobs" description="Accepted tickets times the offered rate, unit for unit. A statement to review — nothing is paid or exported." />
            {confirmed.length === 0 ? (
              <EmptyState title="No confirmed jobs yet" className="py-8" />
            ) : (
              <TableWrap className="rounded-none border-0">
                <Table aria-label="Hauler pay">
                  <thead><tr><Th>Load</Th><Th>Hauler</Th><Th>Rate</Th><Th align="right">Verified</Th><Th align="right">Amount</Th></tr></thead>
                  <tbody>
                    {confirmed.map((o) => {
                      const p = offerPay(o.rate_cents, o.rate_unit, data.pay.get(o.assignment_id ?? "") ?? []);
                      return (
                        <Tr key={o.id}>
                          <Td>{o.load.order_number} load {o.load.load_number}<span className="block text-xs text-muted">{formatDate(o.load.load_date)}</span></Td>
                          <Td>{haulerName.get(o.hauler_id)}<span className="block text-xs text-muted">Truck {truckName.get(o.truck_id)} · {driverName.get(o.driver_id)}</span></Td>
                          <Td className="tabular">{formatCents(o.rate_cents)} {RATE_UNIT_LABELS[o.rate_unit]}</Td>
                          <Td align="right" className="tabular">{p.quantity === null ? "—" : `${p.quantity} ${o.rate_unit}${p.quantity === 1 ? "" : "s"}`}</Td>
                          <Td align="right" className="tabular">{p.amountCents === null ? <span className="text-xs text-muted">{p.note}</span> : formatCents(p.amountCents)}</Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </Card>
        </>
      )}
    </>
  );
}
