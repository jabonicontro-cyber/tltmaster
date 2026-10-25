"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MapPin } from "lucide-react";
import { toast } from "sonner";
import { saveLocation, setLocationActive, setYardFromLocation } from "@/app/(app)/route-planner/builder-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import type { Point } from "@/lib/routing/route";
import { LOCATION_KINDS, type CompanyLocation, type LocationKind } from "@/lib/routing/locations";
import { AddressSearch } from "./address-search";
import { RouteMap } from "./route-map";

type Draft = {
  id?: string;
  kind: LocationKind;
  name: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  notes: string;
  point: Point | null;
  source: "manual" | "geocoded" | null;
  geocodeLabel: string;
};

const empty: Draft = { kind: "quarry", name: "", line1: "", city: "", state: "", postalCode: "", notes: "", point: null, source: null, geocodeLabel: "" };

const SOURCE: Record<string, string> = { manual: "Coordinates entered by a person", geocoded: "Found from the address and confirmed", "": "No location yet" };

/** Saved places other than customer sites: yards, terminals, quarries, plants and other pickups. */
export function LocationsPanel({ locations, canEdit, canSetYard, routingReady, tiles, yard }: {
  locations: CompanyLocation[];
  canEdit: boolean;
  canSetYard: boolean;
  routingReady: boolean;
  tiles: boolean;
  yard: Point | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, start] = useTransition();
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const run = (p: () => Promise<{ ok: boolean; error?: string; message?: string }>, after?: () => void) =>
    start(async () => {
      const r = await p();
      if (r.ok) {
        toast.success(r.message ?? "Saved.");
        after?.();
        router.refresh();
      } else toast.error(r.error ?? "Something went wrong.");
    });

  const located = locations.filter((l) => l.point);
  const mapNumber = new Map(located.map((l, i) => [l.id, i + 1]));
  return (
    <div className="space-y-5">
      {located.length > 0 && <RouteMap stops={located.map((l) => ({ point: l.point!, label: l.name }))} tiles={tiles} title="Saved locations" connect={false} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{locations.length ? `${locations.length} saved location${locations.length === 1 ? "" : "s"}. Customer job sites are kept with each customer.` : "No saved locations yet. Add the yard and the quarries or plants trucks load at."}</p>
        {canEdit && !draft && <Button onClick={() => setDraft({ ...empty })}>Add a location</Button>}
      </div>

      {draft && (
        <form
          className="space-y-4 rounded-lg border border-line bg-card p-4"
          aria-label={draft.id ? "Edit location" : "New location"}
          onSubmit={(e) => {
            e.preventDefault();
            run(() => saveLocation({ ...draft, point: draft.point, source: draft.source }), () => setDraft(null));
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kind" htmlFor="loc-kind">
              <Select id="loc-kind" value={draft.kind} onChange={(e) => set({ kind: e.target.value as LocationKind })}>
                {Object.entries(LOCATION_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Name" htmlFor="loc-name" required>
              <Input id="loc-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} placeholder="e.g. Kankakee Valley Quarry" />
            </Field>
            <Field label="Street" htmlFor="loc-line1"><Input id="loc-line1" value={draft.line1} onChange={(e) => set({ line1: e.target.value })} maxLength={160} /></Field>
            <div className="grid grid-cols-[1fr_5rem_6rem] gap-2">
              <Field label="Town" htmlFor="loc-city"><Input id="loc-city" value={draft.city} onChange={(e) => set({ city: e.target.value })} maxLength={80} /></Field>
              <Field label="State" htmlFor="loc-state"><Input id="loc-state" value={draft.state} onChange={(e) => set({ state: e.target.value })} maxLength={40} /></Field>
              <Field label="ZIP" htmlFor="loc-zip"><Input id="loc-zip" value={draft.postalCode} onChange={(e) => set({ postalCode: e.target.value })} maxLength={20} /></Field>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-semibold text-ink">Location on the map</p>
            {draft.point ? (
              <div className="space-y-2">
                <RouteMap stops={[{ point: draft.point, label: draft.name || "Location" }]} tiles={tiles} title="Location" />
                <p className="text-sm text-muted">{draft.point.lat}, {draft.point.lng} · {SOURCE[draft.source ?? ""]}{draft.geocodeLabel ? ` (${draft.geocodeLabel})` : ""}</p>
                <Button size="sm" variant="ghost" onClick={() => set({ point: null, source: null, geocodeLabel: "" })}>Change the location</Button>
              </div>
            ) : (
              <AddressSearch
                routingReady={routingReady}
                tiles={tiles}
                initialAddress={[draft.line1, draft.city, draft.state, draft.postalCode].filter(Boolean).join(", ")}
                pickLabel="This is the place"
                onPick={(p) => set({ point: p.point, source: p.source, geocodeLabel: p.source === "geocoded" ? p.label : "" })}
              />
            )}
          </div>
          <Field label="Notes for drivers" htmlFor="loc-notes" hint="Gate codes, scale-house hours, where to queue.">
            <Textarea id="loc-notes" value={draft.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={1000} rows={2} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={pending} disabled={!draft.name.trim()}>{draft.id ? "Save changes" : "Save location"}</Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </form>
      )}

      <ul className="divide-y divide-line rounded-lg border border-line bg-card" aria-label="Saved locations">
        {locations.map((l) => {
          const isYard = Boolean(yard && l.point && Math.abs(yard.lat - l.point.lat) < 1e-6 && Math.abs(yard.lng - l.point.lng) < 1e-6);
          return (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <MapPin className={`mt-0.5 size-4 shrink-0 ${l.point ? "text-ink" : "text-critical"}`} aria-hidden />
                <div className="min-w-0">
                  <p className="font-medium text-ink">{mapNumber.has(l.id) && <span className="mr-1.5 tabular text-muted">{mapNumber.get(l.id)}.</span>}{l.name} <Badge tone="gray" className="ml-1">{LOCATION_KINDS[l.kind]}</Badge>{isYard && <Badge tone="blue" className="ml-1">Daily routes start here</Badge>}</p>
                  <p className="truncate text-xs text-muted">{l.address || "No address"} · {l.point ? `${l.point.lat}, ${l.point.lng}` : "no location yet"} · {SOURCE[l.source]}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {canSetYard && l.kind === "yard" && l.point && !isYard && <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => setYardFromLocation({ id: l.id }))}>Start daily routes here</Button>}
                {canEdit && <Button size="sm" variant="ghost" onClick={() => setDraft({ id: l.id, kind: l.kind, name: l.name, line1: l.addressParts.line1, city: l.addressParts.city, state: l.addressParts.state, postalCode: l.addressParts.postalCode, notes: l.notes, point: l.point, source: l.source || null, geocodeLabel: l.geocodeLabel })}>Edit</Button>}
                {canEdit && <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setLocationActive({ id: l.id, active: false }))}>Archive</Button>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
