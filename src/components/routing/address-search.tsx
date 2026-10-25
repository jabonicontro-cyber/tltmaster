"use client";

import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { searchAddress } from "@/app/(app)/route-planner/builder-actions";
import { parsePoint, type GeocodeCandidate, type Point } from "@/lib/routing/route";
import { RouteMap } from "./route-map";

/** Enter runs the field's own action instead of submitting a surrounding form (this search sits inside other forms). */
const onEnter = (fn: () => unknown) => (e: React.KeyboardEvent) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  fn();
};

/**
 * Find a place by address (the provider's matches, shown on a map for a person to pick) or by typed coordinates.
 * Nothing is chosen automatically: an ambiguous address shows every match, and no match says so.
 */
export function AddressSearch({
  routingReady, tiles, onPick, pickLabel = "Use this place", initialAddress = "",
}: {
  routingReady: boolean;
  tiles: boolean;
  onPick: (p: { point: Point; label: string; source: "geocoded" | "manual" }) => void;
  pickLabel?: string;
  initialAddress?: string;
}) {
  const [address, setAddress] = useState(initialAddress);
  const [coords, setCoords] = useState("");
  const [candidates, setCandidates] = useState<GeocodeCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const search = () =>
    start(async () => {
      setError(null);
      setCandidates([]);
      const r = await searchAddress({ address });
      if (r.ok) setCandidates(r.data);
      else setError(r.error);
    });

  const applyCoords = () => {
    const p = parsePoint(coords);
    if (!p) {
      setError("Enter latitude and longitude, for example 40.9367, -87.1509.");
      return;
    }
    setError(null);
    onPick({ point: p, label: `${p.lat}, ${p.lng}`, source: "manual" });
    setCoords("");
  };

  return (
    <div className="space-y-3">
      {routingReady ? (
        <div className="flex flex-wrap gap-2">
          <Input aria-label="Address" placeholder="Street, town, state" value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={onEnter(() => address.trim().length >= 4 && search())} className="h-10 min-w-0 flex-1 basis-60" />
          <Button variant="secondary" loading={pending} disabled={address.trim().length < 4} onClick={search}>
            <Search className="size-4" aria-hidden /> Find address
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted">Address search needs truck routing (the owner adds a HERE key). Enter coordinates instead; any map shows them.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Coordinates" placeholder="Latitude, longitude" value={coords} onChange={(e) => setCoords(e.target.value)} onKeyDown={onEnter(() => coords.trim() && applyCoords())} className="h-10 w-56" inputMode="decimal" />
        <Button variant="ghost" disabled={!coords.trim()} onClick={applyCoords}>Use coordinates</Button>
      </div>
      {error && <p role="alert" className="text-sm text-critical">{error}</p>}
      {candidates.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            {candidates.length === 1 ? "One match." : `${candidates.length} matches: pick the right one.`} Matches are the provider&apos;s estimate of the address; check the pin before using it.
          </p>
          <RouteMap stops={candidates.map((c) => ({ point: c.point, label: c.label }))} tiles={tiles} title="Address matches" connect={false} />
          <ol className="divide-y divide-line rounded-panel border border-line/70 bg-card shadow-card">
            {candidates.map((c, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink"><span className="mr-2 tabular text-muted">{i + 1}.</span>{c.label}</p>
                  <p className="text-xs text-muted">
                    {c.point.lat}, {c.point.lng}
                    {c.precision ? ` · matched to ${c.precision.replace(/([A-Z])/g, " $1").toLowerCase()}` : ""}
                    {c.score !== null ? ` · match ${Math.round(c.score * 100)}%` : ""}
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => { onPick({ point: c.point, label: c.label, source: "geocoded" }); setCandidates([]); }}>{pickLabel}</Button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
