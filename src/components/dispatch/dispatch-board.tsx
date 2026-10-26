"use client";

import Link from "next/link";
import type { BaseOption } from "@/components/bases/base-field";
import { DateInput } from "@/components/ui/date-input";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Clock, CopyCheck, GripVertical, Keyboard, MapPin, Navigation, Pencil, Plus, Truck, XCircle } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import type { Face } from "@/server/data/faces";
import { toast } from "sonner";
import { Badge, OrderStatusBadge, SampleBadge, UrgentPill } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/dates";
import { bookingsFor, combinationCheck, driverState, proposePreviousCrews, shiftDate, trailerState, truckState, type ActiveAssignment, type Interval, type ResourceState } from "@/lib/dispatch/board";
import { BulkAssignDialog, CopyCrewsDialog, ShortcutsDialog } from "./fast-dispatch";
import { OrderRoutePanel } from "./order-route-panel";
import { driverChecks, eligibilityMessage } from "@/lib/fleet/eligibility";
import { TRAILER_TYPE_LABELS, TRUCK_TYPE_LABELS, trimNumber } from "@/lib/fleet/labels";
import { formatTime } from "@/lib/orders/schedule";
import type { AssignmentRow, DispatchDay, OrderLoadRow } from "@/server/data/dispatch";
import type { OrderListRow } from "@/server/data/types";
import { TicketStatusBadge } from "@/components/tickets/ticket-badge";
import { assignLoad, cancelAssignment, cancelLoad, saveLoad } from "@/app/(app)/dispatch/actions";

const DISPATCHABLE = ["scheduled", "dispatched", "in_progress", "partially_completed"];
/** Drag payload type for drivers and trucks dragged onto a load (B85). */
const DRAG_TYPE = "application/x-taviron-resource";

interface Lookup {
  loads: Map<string, OrderLoadRow>;
  orders: Map<string, OrderListRow>;
  trucks: Map<string, DispatchDay["trucks"][number]>;
  trailers: Map<string, DispatchDay["trailers"][number]>;
  drivers: Map<string, DispatchDay["drivers"][number]>;
  /** Driver pictures by driver id (initials when missing). */
  faces: Record<string, Face>;
}

const timeRange = (l: Pick<OrderLoadRow, "start_time" | "end_time">) => `${formatTime(l.start_time)} – ${formatTime(l.end_time)}`;

function describeBooking(a: ActiveAssignment, lk: Lookup) {
  const load = lk.loads.get(a.load_id);
  const order = load ? lk.orders.get(load.order_id) : undefined;
  return load ? `${timeRange(load)} · ${order?.order_number ?? "order"} load ${load.load_number}` : "another load";
}

export function DispatchBoard({ day, canEdit, canEnterTickets = false, focusLoadId = null, bases = [], faces = {}, urgentOrderIds = [] }: { day: DispatchDay; canEdit: boolean; canEnterTickets?: boolean; focusLoadId?: string | null; /** Active bases; the base filter shows only with two or more. */ bases?: BaseOption[]; faces?: Record<string, Face>; /** Orders with an open urgent flag: their cards get the red edge. */ urgentOrderIds?: string[] }) {
  const router = useRouter();
  // Opened from the command center: bring the affected load into view.
  useEffect(() => {
    if (focusLoadId) document.getElementById(`load-${focusLoadId}`)?.scrollIntoView({ block: "center" });
  }, [focusLoadId]);
  const [loadDialog, setLoadDialog] = useState<{ order: OrderListRow; load: OrderLoadRow | null } | null>(null);
  const [assignDialog, setAssignDialog] = useState<{ load: OrderLoadRow; current: AssignmentRow | null; initial?: { truckId?: string; trailerId?: string; driverId?: string } } | null>(null);
  // Faster dispatching (B85): selected open loads, the batch dialogs and the shortcuts list.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // The order whose route shows beside the board (owner 2026-10-26: Dispatch and the Route Planner on one page).
  const [routeOrder, setRouteOrder] = useState<string | null>(null);
  const closeRoute = useCallback(() => setRouteOrder(null), []);
  const [cancelTarget, setCancelTarget] = useState<{ kind: "assignment" | "load"; id: string; orderId: string; title: string } | null>(null);
  const [reason, setReason] = useState("");

  const lk: Lookup = useMemo(
    () => ({
      loads: new Map(day.loads.map((l) => [l.id, l])),
      orders: new Map(day.orders.map((o) => [o.id, o])),
      trucks: new Map(day.trucks.map((t) => [t.id, t])),
      trailers: new Map(day.trailers.map((t) => [t.id, t])),
      drivers: new Map(day.drivers.map((d) => [d.id, d])),
      faces,
    }),
    [day, faces],
  );
  const active = day.assignments.filter((a) => a.status === "active");
  const activeByLoad = new Map(active.map((a) => [a.load_id, a]));
  const plannedLoads = day.loads.filter((l) => l.status === "planned");
  const unassigned = plannedLoads.filter((l) => !activeByLoad.has(l.id)).length;
  const refresh = () => router.refresh();
  // Day links keep the chosen base.
  const dayHref = (date: string) => `/dispatch?date=${date}${day.base ? `&base=${day.base}` : ""}`;

  // Open loads (planned, no active assignment, on an order that can be dispatched): what batches work on.
  const openLoads = plannedLoads.filter((l) => !activeByLoad.has(l.id) && DISPATCHABLE.includes(lk.orders.get(l.order_id)?.status ?? ""));
  const proposals = useMemo(() => proposePreviousCrews(openLoads, day.pastCrews ?? []), [openLoads, day.pastCrews]);
  const selectedLoads = openLoads.filter((l) => selected.has(l.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // Dropping a driver or truck on a load opens the assign dialog with that crew filled in (the driver's usual truck,
  // the truck's usual driver, and the trailer usually paired with the truck); the dispatcher confirms.
  const onDropResource = (load: OrderLoadRow, r: { kind: "driver" | "truck"; id: string }) => {
    const truckId = r.kind === "truck" ? r.id : day.drivers.find((d) => d.id === r.id)?.primary_truck_id ?? undefined;
    const driverId = r.kind === "driver" ? r.id : day.drivers.find((d) => d.primary_truck_id === r.id)?.id;
    const trailerId = truckId ? day.trailers.find((t) => t.default_truck_id === truckId)?.id : undefined;
    setAssignDialog({ load, current: activeByLoad.get(load.id) ?? null, initial: { truckId: truckId && lk.trucks.has(truckId) ? truckId : undefined, driverId, trailerId } });
  };

  // Keyboard shortcuts, only when no field or dialog has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true]") || t.closest("[role=dialog]"))) return;
      if (document.querySelector("[role=dialog]")) return;
      if (e.key === "ArrowLeft") router.push(dayHref(shiftDate(day.date, -1)));
      else if (e.key === "ArrowRight") router.push(dayHref(shiftDate(day.date, 1)));
      else if (e.key === "t" || e.key === "T") router.push(dayHref(day.today));
      else if (e.key === "?") setShortcutsOpen(true);
      else if ((e.key === "c" || e.key === "C") && canEdit && proposals.length) setCopyOpen(true);
      else if ((e.key === "a" || e.key === "A") && canEdit && selectedLoads.length) setBulkOpen(true);
      else if (e.key === "Escape") setSelected(new Set());
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="space-y-5">
      {/* Date navigation and summary */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-line/70 bg-card shadow-card px-4 py-3">
        <nav aria-label="Change day" className="flex flex-wrap items-center gap-2">
          <Link href={dayHref(shiftDate(day.date, -1))} className={buttonClasses("secondary", "sm")}>
            <ChevronLeft className="size-4" aria-hidden /> Prev<span className="sr-only">ious day</span>
          </Link>
          <Link href={dayHref(day.today)} className={buttonClasses(day.date === day.today ? "dark" : "secondary", "sm")}>
            Today
          </Link>
          <Link href={dayHref(shiftDate(day.date, 1))} className={buttonClasses("secondary", "sm")}>
            Next<span className="sr-only"> day</span> <ChevronRight className="size-4" aria-hidden />
          </Link>
          <form action="/dispatch" method="get" className="flex items-center gap-2">
            <label htmlFor="board-date" className="sr-only">Go to date</label>
            <DateInput id="board-date" name="date" defaultValue={day.date} className="h-9 w-40" />
            {bases.length > 1 && (
              <>
                <label htmlFor="board-base" className="sr-only">Dispatch base</label>
                <Select id="board-base" name="base" defaultValue={day.base ?? ""} className="h-9 w-auto">
                  <option value="">All bases</option>
                  {bases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              </>
            )}
            <button type="submit" className={buttonClasses("secondary", "sm", "h-9")}>Go</button>
          </form>
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && proposals.length > 0 && (
            <Button size="sm" variant="secondary" icon={<CopyCheck className="size-4" />} onClick={() => setCopyOpen(true)}>
              Copy previous crew ({proposals.length})
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Keyboard className="size-4" />} onClick={() => setShortcutsOpen(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" />
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <div><dt className="inline text-muted">Orders </dt><dd className="inline font-bold tabular">{day.orders.length}</dd></div>
          <div><dt className="inline text-muted">Loads </dt><dd className="inline font-bold tabular">{plannedLoads.length}</dd></div>
          <div><dt className="inline text-muted">Assigned </dt><dd className="inline font-bold tabular">{plannedLoads.length - unassigned}</dd></div>
          <div>
            <dt className="inline text-muted">Need a truck </dt>
            <dd className={cn("inline font-bold tabular", unassigned > 0 && "text-amber-800")}>{unassigned}</dd>
          </div>
        </dl>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        {/* Orders and loads */}
        <div className="space-y-4 xl:col-span-2">
          {day.orders.length === 0 ? (
            <Card>
              <EmptyState
                icon={<CalendarDays className="size-6" />}
                title="No orders scheduled for this day"
                description={
                  <>
                    Orders appear here when their scheduled dates include {formatDate(day.date)}. Schedule an order from its page, or browse{" "}
                    <Link href="/orders?when=unscheduled" className="underline">orders not scheduled yet</Link>.
                  </>
                }
              />
            </Card>
          ) : (
            day.orders.map((o) => (
              <OrderCard
                key={o.id}
                order={o}
                urgent={urgentOrderIds.includes(o.id)}
                routeOpen={routeOrder === o.id}
                onRoute={() => setRouteOrder((cur) => (cur === o.id ? null : o.id))}
                selected={selected}
                onToggle={toggle}
                onDropResource={onDropResource}
                date={day.date}
                loads={day.loads.filter((l) => l.order_id === o.id)}
                assignments={day.assignments}
                tickets={day.tickets}
                today={day.today}
                canEnterTickets={canEnterTickets}
                focusLoadId={focusLoadId}
                lk={lk}
                canEdit={canEdit}
                onAddLoad={() => setLoadDialog({ order: o, load: null })}
                onEditLoad={(load) => setLoadDialog({ order: o, load })}
                onAssign={(load) => setAssignDialog({ load, current: activeByLoad.get(load.id) ?? null })}
                onUnassign={(a, load) => {
                  setReason("");
                  setCancelTarget({ kind: "assignment", id: a.id, orderId: o.id, title: `Remove the assignment from ${o.order_number} load ${load.load_number}` });
                }}
                onCancelLoad={(load) => {
                  setReason("");
                  setCancelTarget({ kind: "load", id: load.id, orderId: o.id, title: `Cancel ${o.order_number} load ${load.load_number}` });
                }}
              />
            ))
          )}
        </div>

        {/* Resources for the day, or the selected order's route in their place */}
        {routeOrder ? (
          <div>
            <OrderRoutePanel orderId={routeOrder} date={day.date} onClose={closeRoute} inline />
          </div>
        ) : (
          <ResourcePanel day={day} active={active} lk={lk} canEdit={canEdit} />
        )}
      </div>

      {loadDialog && (
        <LoadDialog
          order={loadDialog.order}
          load={loadDialog.load}
          date={day.date}
          units={day.units}
          onClose={() => setLoadDialog(null)}
          onSaved={(m) => {
            setLoadDialog(null);
            toast.success(m);
            refresh();
          }}
        />
      )}
      {assignDialog && (
        <AssignDialog
          load={assignDialog.load}
          current={assignDialog.current}
          initial={assignDialog.initial}
          day={day}
          active={active}
          lk={lk}
          onClose={() => setAssignDialog(null)}
          onSaved={(m, warnings) => {
            setAssignDialog(null);
            toast.success(m);
            if (warnings.length) toast.warning(warnings.map(eligibilityMessage).join(" "));
            refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(cancelTarget)}
        onOpenChange={(o) => !o && setCancelTarget(null)}
        title={cancelTarget?.title ?? ""}
        description={
          cancelTarget?.kind === "load"
            ? "The load and its assignment are canceled. History is kept on the order."
            : "The truck, trailer and driver become free for this time. History is kept on the order."
        }
        confirmLabel={cancelTarget?.kind === "load" ? "Cancel load" : "Remove assignment"}
        tone="danger"
        onConfirm={async () => {
          if (!cancelTarget) return;
          const input = { id: cancelTarget.id, orderId: cancelTarget.orderId, reason };
          const r = cancelTarget.kind === "load" ? await cancelLoad(input) : await cancelAssignment(input);
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved");
          refresh();
        }}
      >
        <Field label="Reason" htmlFor="cancel-reason" required hint="Recorded in the order history.">
          <Input id="cancel-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer pushed to tomorrow" />
        </Field>
      </ConfirmDialog>

      {/* B85: the selection bar, the batch dialogs and the shortcuts list. */}
      {canEdit && selectedLoads.length > 0 && (
        <div role="region" aria-label="Selected loads" className="ui-pop fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full border border-line/70 bg-card/95 py-1.5 pr-1.5 pl-5 shadow-float backdrop-blur-md">
          <span className="text-sm font-semibold whitespace-nowrap">{selectedLoads.length} {selectedLoads.length === 1 ? "load" : "loads"} selected</span>
          <Button size="sm" icon={<Truck className="size-4" />} onClick={() => setBulkOpen(true)}>Assign selected</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}
      {bulkOpen && (
        <BulkAssignDialog
          loads={selectedLoads}
          active={active}
          lk={lk}
          onClose={() => setBulkOpen(false)}
          onDone={() => { setBulkOpen(false); setSelected(new Set()); refresh(); }}
        />
      )}
      {copyOpen && (
        <CopyCrewsDialog
          proposals={proposals}
          loads={lk.loads}
          active={active}
          lk={lk}
          onClose={() => setCopyOpen(false)}
          onDone={() => { setCopyOpen(false); refresh(); }}
        />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}

function OrderCard({
  order: o,
  urgent,
  routeOpen,
  onRoute,
  selected,
  onToggle,
  onDropResource,
  date,
  loads,
  assignments,
  tickets,
  today,
  canEnterTickets,
  focusLoadId,
  lk,
  canEdit,
  onAddLoad,
  onEditLoad,
  onAssign,
  onUnassign,
  onCancelLoad,
}: {
  order: OrderListRow;
  urgent: boolean;
  routeOpen: boolean;
  onRoute: () => void;
  selected: Set<string>;
  onToggle: (loadId: string) => void;
  onDropResource: (load: OrderLoadRow, r: { kind: "driver" | "truck"; id: string }) => void;
  date: string;
  loads: OrderLoadRow[];
  assignments: AssignmentRow[];
  tickets: DispatchDay["tickets"];
  today: string;
  canEnterTickets: boolean;
  focusLoadId: string | null;
  lk: Lookup;
  canEdit: boolean;
  onAddLoad: () => void;
  onEditLoad: (l: OrderLoadRow) => void;
  onAssign: (l: OrderLoadRow) => void;
  onUnassign: (a: AssignmentRow, l: OrderLoadRow) => void;
  onCancelLoad: (l: OrderLoadRow) => void;
}) {
  const dispatchable = DISPATCHABLE.includes(o.status);
  const outsideSchedule = !o.scheduled_start || o.scheduled_start > date || (o.scheduled_end ?? o.scheduled_start) < date;
  const site = [o.site_label || o.site_line1, o.site_city].filter(Boolean).join(", ");
  const window = o.window_start && o.window_end ? `${formatTime(o.window_start)} – ${formatTime(o.window_end)}` : null;
  // The load a driver or truck is being dragged over (B85 drag and drop).
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  return (
    <Card urgent={urgent} className={cn(routeOpen && !urgent && "ring-2 ring-strong")}>
      {/* Clicking the order (not its links or buttons) opens its route beside the board. */}
      <div
        className="flex cursor-pointer flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3 sm:px-6"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("a, button, input, select, label")) onRoute();
        }}
      >
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/orders/${o.id}`} className="text-lg font-black tabular hover:text-brand-fg hover:underline">{o.order_number}</Link>
            <OrderStatusBadge status={o.status} />
            {urgent && <UrgentPill />}
            <SampleBadge show={o.is_sample} />
            {outsideSchedule && <Badge tone="amber">Outside the order&apos;s scheduled dates</Badge>}
          </div>
          <p className="font-semibold">{o.customer_name}{o.project_name ? <span className="font-normal text-muted"> · {o.project_name}</span> : null}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
            {site && (
              <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" aria-hidden /> {site}</span>
            )}
            {window && (
              <span className="inline-flex items-center gap-1"><Clock className="size-3.5" aria-hidden /> Window {window}</span>
            )}
            {o.customer_po && <span>PO {o.customer_po}</span>}
            {o.contact_name && <span>{o.contact_name}</span>}
          </div>
          {o.material_summary && <p className="text-sm">{o.material_summary}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={routeOpen ? "dark" : "secondary"} icon={<Navigation className="size-4" />} onClick={onRoute} aria-pressed={routeOpen} aria-label={`Route for ${o.order_number}`}>
            Route
          </Button>
          {canEdit && dispatchable && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={onAddLoad}>
              Add load
            </Button>
          )}
        </div>
      </div>

      {!dispatchable && (
        <p className="border-b border-line bg-amber-50 px-5 py-2 text-sm text-amber-950 sm:px-6">
          {o.status === "confirmed"
            ? "This order is confirmed but not marked scheduled. Mark it scheduled on the order page to plan loads."
            : o.status === "on_hold"
              ? "On hold — loads cannot be assigned until the hold is released."
              : "Completed — shown for reference."}
        </p>
      )}

      {loads.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted sm:px-6">No loads planned for this day{canEdit && dispatchable ? " — add one to assign a truck." : "."}</p>
      ) : (
        <ol className="divide-y divide-line">
          {loads.map((l) => {
            const current = assignments.find((a) => a.load_id === l.id && a.status === "active") ?? null;
            const previous = assignments.filter((a) => a.load_id === l.id && a.status === "canceled");
            const canceled = l.status === "canceled";
            const droppable = canEdit && dispatchable && !canceled;
            const selectable = droppable && !current && l.status === "planned";
            return (
              <li
                key={l.id}
                id={`load-${l.id}`}
                aria-current={focusLoadId === l.id ? "true" : undefined}
                className={cn(
                  "grid grid-cols-1 gap-3 px-5 py-3 transition-colors sm:grid-cols-12 sm:px-6",
                  canceled && "bg-surface/60 text-muted",
                  focusLoadId === l.id && "bg-amber-50 ring-2 ring-amber-400 ring-inset",
                  selected.has(l.id) && "bg-strong/[0.04]",
                  dropTarget === l.id && "bg-strong/[0.06] ring-2 ring-strong/40 ring-inset",
                )}
                aria-label={`Load ${l.load_number}`}
                onDragOver={droppable ? (e) => {
                  if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  if (dropTarget !== l.id) setDropTarget(l.id);
                } : undefined}
                onDragLeave={droppable ? (e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
                } : undefined}
                onDrop={droppable ? (e) => {
                  setDropTarget(null);
                  const raw = e.dataTransfer.getData(DRAG_TYPE);
                  if (!raw) return;
                  e.preventDefault();
                  try {
                    const r = JSON.parse(raw) as { kind: "driver" | "truck"; id: string };
                    if ((r.kind === "driver" || r.kind === "truck") && typeof r.id === "string") onDropResource(l, r);
                  } catch {
                    // Not a Taviron drag: ignore.
                  }
                } : undefined}
              >
                <div className="flex gap-3 sm:col-span-3">
                  {selectable && (
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-[var(--color-strong)]"
                      aria-label={`Select load ${l.load_number} of ${o.order_number}`}
                      checked={selected.has(l.id)}
                      onChange={() => onToggle(l.id)}
                    />
                  )}
                  <div>
                  <p className="font-bold">Load {l.load_number}</p>
                  <p className="text-sm tabular">{timeRange(l)}</p>
                  {l.planned_quantity !== null && (
                    <p className="text-sm text-muted">
                      {trimNumber(l.planned_quantity)} {l.unit_code}
                    </p>
                  )}
                  {canceled && <Badge tone="gray">Canceled: {l.cancel_reason}</Badge>}
                  </div>
                </div>
                <div className="sm:col-span-6">
                  {current ? (
                    <AssignmentSummary a={current} lk={lk} />
                  ) : canceled ? null : (
                    <p className="flex items-center gap-1.5 font-semibold text-amber-800">
                      <AlertTriangle className="size-4" aria-hidden /> Needs a truck and driver
                    </p>
                  )}
                  {l.notes && <p className="mt-1 text-sm text-muted">{l.notes}</p>}
                  <LoadTickets
                    tickets={tickets.filter((t) => t.load_id === l.id)}
                    canEnter={canEnterTickets && Boolean(current) && !canceled && l.load_date <= today}
                    loadId={l.id}
                  />
                  {previous.length > 0 && (
                    <details className="mt-1 text-sm">
                      <summary className="cursor-pointer text-muted">History ({previous.length} earlier)</summary>
                      <ul className="mt-1 space-y-1">
                        {previous.map((a) => (
                          <li key={a.id}>
                            {assignmentText(a, lk)} — <span className="text-muted">{a.cancel_reason}{a.canceled_at ? `, ${formatDateTime(a.canceled_at)}` : ""}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
                {canEdit && !canceled && (
                  <div className="flex flex-wrap items-start gap-1.5 sm:col-span-3 sm:justify-end">
                    {dispatchable && (
                      <Button size="sm" variant={current ? "secondary" : "primary"} icon={<Truck className="size-4" />} onClick={() => onAssign(l)}>
                        {current ? "Reassign" : "Assign"}
                      </Button>
                    )}
                    {current && (
                      <Button size="sm" variant="ghost" aria-label={`Remove assignment from load ${l.load_number}`} onClick={() => onUnassign(current, l)}>
                        <XCircle className="size-4 text-red-700" />
                      </Button>
                    )}
                    {dispatchable && (
                      <Button size="sm" variant="ghost" aria-label={`Edit load ${l.load_number}`} onClick={() => onEditLoad(l)}>
                        <Pencil className="size-4" />
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => onCancelLoad(l)}>
                      Cancel load
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function assignmentText(a: Pick<AssignmentRow, "truck_id" | "trailer_id" | "driver_id">, lk: Lookup) {
  const truck = lk.trucks.get(a.truck_id)?.unit_number ?? "truck";
  const trailer = a.trailer_id ? lk.trailers.get(a.trailer_id)?.unit_number ?? "trailer" : null;
  const driver = lk.drivers.get(a.driver_id)?.display_name ?? "driver";
  return [`Truck ${truck}`, trailer && `trailer ${trailer}`, driver].filter(Boolean).join(" · ");
}

function AssignmentSummary({ a, lk }: { a: AssignmentRow; lk: Lookup }) {
  const truck = lk.trucks.get(a.truck_id);
  const trailer = a.trailer_id ? lk.trailers.get(a.trailer_id) : null;
  const driver = lk.drivers.get(a.driver_id);
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1 font-semibold"><Truck className="size-4" aria-hidden /> {truck?.unit_number ?? "Inactive truck"}</span>
        {a.trailer_id && <span className="font-semibold">+ {trailer?.unit_number ?? "inactive trailer"}</span>}
        <span className="inline-flex items-center gap-1.5"><Avatar name={driver?.display_name ?? "Driver"} size={22} {...lk.faces[a.driver_id]} /> {driver?.display_name ?? "Inactive driver"}</span>
        <Badge tone="green">Assigned</Badge>
      </p>
      {a.warnings.length > 0 && <p className="text-xs text-amber-900">{a.warnings.map(eligibilityMessage).join(" ")}</p>}
      {a.note && <p className="text-xs text-muted">Note: {a.note}</p>}
    </div>
  );
}

function stateLabel(s: ResourceState, lk: Lookup) {
  if (s.state === "unavailable") return `Unavailable — ${eligibilityMessage(s.reasons[0])}`;
  if (s.state === "busy") return `Already assigned ${describeBooking(s.with[0], lk)}`;
  return s.warnings.length ? `Available — ${eligibilityMessage(s.warnings[0])}` : "Available";
}

function ResourcePanel({ day, active, lk, canEdit }: { day: DispatchDay; active: AssignmentRow[]; lk: Lookup; canEdit: boolean }) {
  // Drivers and trucks can be dragged onto a load to assign them (B85); the Assign button stays the keyboard way.
  const drag = (kind: "driver" | "truck", id: string) =>
    canEdit
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind, id }));
            e.dataTransfer.effectAllowed = "copy";
          },
        }
      : {};
  return (
    <div className="space-y-4 self-start">
      <Card>
        <CardHeader title="Trucks today" description="Bookings on this board and service status." />
        {day.trucks.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted sm:px-6">No active trucks. <Link href="/fleet/trucks/new" className="underline">Add a truck</Link>.</p>
        ) : (
          <ul className="max-h-[32rem] divide-y divide-line overflow-y-auto" aria-label="Trucks today">
            {day.trucks.map((t) => {
              const bookings = bookingsFor(active, "truck", t.id);
              return (
                <li key={t.id} className={cn("group/drag relative px-5 py-2 sm:px-6", canEdit && t.service_status !== "out_of_service" && "cursor-grab active:cursor-grabbing")} {...(t.service_status !== "out_of_service" ? drag("truck", t.id) : {})}>
                  <div className="flex items-center justify-between gap-2">
                    {canEdit && t.service_status !== "out_of_service" && <GripVertical className="absolute top-3 left-1.5 size-3.5 text-muted/60 opacity-0 transition-opacity group-hover/drag:opacity-100" aria-hidden />}
                    <Link href={`/fleet/trucks/${t.id}`} draggable={false} className="min-w-0 font-semibold break-words hover:underline">{t.unit_number}</Link>
                    {t.service_status === "out_of_service" ? (
                      <Badge tone="red">Out of service</Badge>
                    ) : bookings.length ? (
                      <Badge tone="blue">{bookings.length} load{bookings.length === 1 ? "" : "s"}</Badge>
                    ) : (
                      <Badge tone="green">Free</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted">{TRUCK_TYPE_LABELS[t.truck_type]}{t.service_status === "out_of_service" && t.out_of_service_reason ? ` · ${t.out_of_service_reason}` : ""}</p>
                  {bookings.map((b) => (
                    <p key={b.id} className="text-xs tabular">{describeBooking(b, lk)}</p>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Drivers today" description="Eligibility on this date (class B or higher) and bookings." />
        {day.drivers.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted sm:px-6">No active drivers. <Link href="/fleet/drivers/new" className="underline">Add a driver</Link>.</p>
        ) : (
          <ul className="max-h-[32rem] divide-y divide-line overflow-y-auto" aria-label="Drivers today">
            {day.drivers.map((d) => {
              const r = driverChecks(d, false, day.date);
              const bookings = bookingsFor(active, "driver", d.id);
              return (
                <li key={d.id} className={cn("group/drag relative px-5 py-2 sm:px-6", canEdit && r.eligible && "cursor-grab active:cursor-grabbing")} {...(r.eligible ? drag("driver", d.id) : {})}>
                  <div className="flex items-center justify-between gap-2">
                    {canEdit && r.eligible && <GripVertical className="absolute top-3 left-1.5 size-3.5 text-muted/60 opacity-0 transition-opacity group-hover/drag:opacity-100" aria-hidden />}
                    <Link href={`/fleet/drivers/${d.id}`} draggable={false} className="flex min-w-0 items-center gap-2 font-semibold break-words hover:underline"><Avatar name={d.display_name} size={28} {...lk.faces[d.id]} />{d.display_name}</Link>
                    {!r.eligible ? (
                      <Badge tone="red">Not eligible</Badge>
                    ) : bookings.length ? (
                      <Badge tone="blue">{bookings.length} load{bookings.length === 1 ? "" : "s"}</Badge>
                    ) : (
                      <Badge tone="green">Free</Badge>
                    )}
                  </div>
                  {!r.eligible && <p className="text-xs text-red-800">{eligibilityMessage(r.blockers[0])}</p>}
                  {bookings.map((b) => (
                    <p key={b.id} className="text-xs tabular">{describeBooking(b, lk)}</p>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function LoadDialog({ order, load, date, units, onClose, onSaved }: { order: OrderListRow; load: OrderLoadRow | null; date: string; units: DispatchDay["units"]; onClose: () => void; onSaved: (m: string) => void }) {
  const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : "");
  const [values, setValues] = useState({
    loadDate: load?.load_date ?? date,
    startTime: hhmm(load?.start_time) || hhmm(order.window_start) || "07:00",
    endTime: hhmm(load?.end_time) || hhmm(order.window_end) || "08:00",
    plannedQuantity: load?.planned_quantity != null ? trimNumber(load.planned_quantity) : "",
    unitCode: load?.unit_code ?? "",
    notes: load?.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value }));

  async function submit() {
    setPending(true);
    setError(null);
    setFieldErrors({});
    const r = await saveLoad({ loadId: load?.id ?? null, orderId: order.id, ...values });
    setPending(false);
    if (!r.ok) {
      setError(r.error);
      setFieldErrors(r.fieldErrors ?? {});
      return;
    }
    onSaved(r.message ?? "Saved");
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={load ? `Edit ${order.order_number} load ${load.load_number}` : `Add a load to ${order.order_number}`}
      description="Start and end times are used to prevent double-booking trucks, trailers and drivers."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button onClick={submit} loading={pending}>{load ? "Save load" : "Add load"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Date" htmlFor="load-date" required error={fieldErrors.loadDate}>
            <DateInput id="load-date" value={values.loadDate} min={order.scheduled_start ?? undefined} max={order.scheduled_end ?? order.scheduled_start ?? undefined} onChange={set("loadDate")} />
          </Field>
          <Field label="Start" htmlFor="load-start" required error={fieldErrors.startTime}>
            <Input id="load-start" type="time" value={values.startTime} onChange={set("startTime")} />
          </Field>
          <Field label="End" htmlFor="load-end" required error={fieldErrors.endTime}>
            <Input id="load-end" type="time" value={values.endTime} onChange={set("endTime")} />
          </Field>
          <Field label="Planned quantity" htmlFor="load-qty" error={fieldErrors.plannedQuantity} hint="Optional">
            <Input id="load-qty" inputMode="decimal" value={values.plannedQuantity} onChange={set("plannedQuantity")} className="text-right tabular" />
          </Field>
          <Field label="Unit" htmlFor="load-unit" error={fieldErrors.unitCode}>
            <Select id="load-unit" value={values.unitCode} onChange={set("unitCode")}>
              <option value="">—</option>
              {units.map((u) => (
                <option key={u.code} value={u.code}>{u.label}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Notes for the driver" htmlFor="load-notes" error={fieldErrors.notes}>
          <Textarea id="load-notes" rows={2} maxLength={1000} value={values.notes} onChange={set("notes")} />
        </Field>
      </div>
    </Dialog>
  );
}

function AssignDialog({
  load,
  current,
  initial,
  day,
  active,
  lk,
  onClose,
  onSaved,
}: {
  load: OrderLoadRow;
  current: AssignmentRow | null;
  /** Prefill from a drag and drop (B85); the dispatcher still confirms. */
  initial?: { truckId?: string; trailerId?: string; driverId?: string };
  day: DispatchDay;
  active: AssignmentRow[];
  lk: Lookup;
  onClose: () => void;
  onSaved: (m: string, warnings: string[]) => void;
}) {
  const order = lk.orders.get(load.order_id);
  const [truckId, setTruckId] = useState(initial?.truckId ?? current?.truck_id ?? "");
  const [trailerId, setTrailerId] = useState(initial?.trailerId ?? current?.trailer_id ?? "");
  const [driverId, setDriverId] = useState(initial?.driverId ?? current?.driver_id ?? "");
  const [note, setNote] = useState("");
  // Set when the shift check refused the driver: the problem shown and the reason typed (20261120003300).
  const [offShift, setOffShift] = useState<string | null>(null);
  const [offShiftReason, setOffShiftReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const interval: Interval = { starts_at: load.starts_at, ends_at: load.ends_at };
  const except = current?.id ?? null;
  const on = load.load_date;

  const truck = truckId ? lk.trucks.get(truckId) ?? null : null;
  const trailer = trailerId ? lk.trailers.get(trailerId) ?? null : null;
  const driver = driverId ? lk.drivers.get(driverId) ?? null : null;
  const check = truck || trailer || driver ? combinationCheck({ truck, trailer, driver }, interval, active, on, except) : null;
  const unchanged = current && current.truck_id === truckId && (current.trailer_id ?? "") === trailerId && current.driver_id === driverId;

  // Group options: available, already assigned at this time, unavailable.
  function grouped<T extends { id: string }>(items: T[], state: (item: T) => ResourceState, label: (item: T) => string) {
    const groups: Record<ResourceState["state"], Array<{ item: T; s: ResourceState }>> = { available: [], busy: [], unavailable: [] };
    for (const item of items) {
      const s = state(item);
      groups[s.state].push({ item, s });
    }
    return (
      <>
        {(["available", "busy", "unavailable"] as const).map((g) =>
          groups[g].length ? (
            <optgroup key={g} label={g === "available" ? "Available" : g === "busy" ? "Already assigned at this time" : "Unavailable"}>
              {groups[g].map(({ item, s }) => (
                <option key={item.id} value={item.id}>
                  {label(item)} — {stateLabel(s, lk)}
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
      </>
    );
  }

  async function submit() {
    setPending(true);
    setError(null);
    const r = await assignLoad({ loadId: load.id, orderId: load.order_id, truckId, trailerId: trailerId || null, driverId, note, replaceAssignmentId: current?.id ?? null, offShiftReason: offShift ? offShiftReason : undefined });
    setPending(false);
    if (!r.ok) {
      // Outside the driver's shift: show why and ask for a reason; the next Assign sends it.
      if (r.fieldErrors?.offShift) {
        setOffShift(r.fieldErrors.offShift);
        return;
      }
      setError(r.error);
      return;
    }
    onSaved(r.message ?? "Saved", r.data.warnings);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`${current ? "Reassign" : "Assign"} ${order?.order_number ?? ""} load ${load.load_number}`}
      description={`${formatDate(load.load_date)}, ${timeRange(load)}${order ? ` · ${order.customer_name}` : ""}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button onClick={submit} loading={pending} disabled={!truckId || !driverId || Boolean(unchanged) || (check ? !check.eligible : true) || (Boolean(offShift) && offShiftReason.trim().length < 3)}>
            {offShift ? "Assign anyway" : current ? "Reassign" : "Assign"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        {offShift && (
          <div role="alert" className="space-y-2 rounded-xl border border-line bg-surface p-3">
            <p className="text-sm font-semibold text-ink">{offShift}</p>
            <p className="text-sm text-muted">The driver is scheduled off then. To assign anyway, say why; the reason is recorded with the assignment.</p>
            <Field label="Reason for working outside the shift" htmlFor="assign-off-shift" required>
              <Input id="assign-off-shift" value={offShiftReason} maxLength={500} onChange={(e) => setOffShiftReason(e.target.value)} placeholder="e.g. Plant opens early for this pour" />
            </Field>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Truck" htmlFor="assign-truck" required>
            <Select id="assign-truck" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
              <option value="">Choose a truck…</option>
              {grouped(day.trucks, (t) => truckState(t, interval, active, on, except), (t) => `${t.unit_number} (${TRUCK_TYPE_LABELS[t.truck_type]})`)}
            </Select>
          </Field>
          <Field label="Trailer" htmlFor="assign-trailer" hint={truck?.truck_type === "tractor" ? "Required for a tractor" : "Optional"}>
            <Select id="assign-trailer" value={trailerId} onChange={(e) => setTrailerId(e.target.value)}>
              <option value="">No trailer</option>
              {grouped(day.trailers, (t) => trailerState(t, interval, active, on, except), (t) => `${t.unit_number} (${TRAILER_TYPE_LABELS[t.trailer_type]})`)}
            </Select>
          </Field>
          <Field label="Driver" htmlFor="assign-driver" required hint={trailerId ? "Class A CDL needed with a trailer" : undefined}>
            <Select id="assign-driver" value={driverId} onChange={(e) => { setDriverId(e.target.value); setOffShift(null); }}>
              <option value="">Choose a driver…</option>
              {grouped(day.drivers, (d) => driverState(d, Boolean(trailerId), interval, active, on, except), (d) => d.display_name)}
            </Select>
          </Field>
        </div>
        <Field label="Note (optional)" htmlFor="assign-note" hint={current ? "Recorded as the reason for the reassignment." : undefined}>
          <Input id="assign-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        {check && (
          <div role="status" className={cn("rounded-xl border p-3 text-sm", check.eligible ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50")}>
            {check.eligible ? (
              <p className="font-semibold text-green-900">{unchanged ? "This is the current assignment." : "This combination can be assigned."}</p>
            ) : (
              <p className="font-semibold text-red-900">This combination cannot be assigned:</p>
            )}
            <ul className="mt-1 space-y-0.5">
              {check.blockers.map((b) => (
                <li key={b} className="text-red-900">Unavailable: {eligibilityMessage(b)}</li>
              ))}
              {check.conflicts.map((c) => (
                <li key={`${c.kind}-${c.with.id}`} className="text-red-900">
                  Already assigned: the {c.kind} is booked {describeBooking(c.with, lk)}.
                </li>
              ))}
              {check.warnings.map((w) => (
                <li key={w} className="text-amber-900">Note: {eligibilityMessage(w)}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted">The server checks eligibility and conflicts again when you save; another dispatcher may have booked a resource since this page loaded.</p>
      </div>
    </Dialog>
  );
}

/** Delivery tickets of a load: their status, or a link to enter one once the load's day has come. */
function LoadTickets({ tickets, canEnter, loadId }: { tickets: DispatchDay["tickets"]; canEnter: boolean; loadId: string }) {
  if (!tickets.length && !canEnter) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
      {tickets.map((t) => (
        <Link key={t.id} href={`/tickets/${t.id}`} className="inline-flex items-center gap-1.5 hover:underline">
          <span className="font-semibold tabular">{t.ticket_number}</span>
          <span className="tabular">{trimNumber(t.quantity)} {t.unit_code}</span>
          <TicketStatusBadge status={t.status} />
        </Link>
      ))}
      {!tickets.length && canEnter && (
        <Link href={`/tickets/new?load=${loadId}`} className="font-semibold text-brand-fg underline">
          Enter delivery ticket
        </Link>
      )}
    </div>
  );
}
