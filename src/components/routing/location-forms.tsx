"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { confirmSiteLocation, locateSite, setSiteLocation, setYardLocation } from "@/app/(app)/route-planner/actions";
import type { ActionResult } from "@/lib/action-result";
import type { GeocodeCandidate } from "@/lib/routing/route";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (p: () => Promise<ActionResult<unknown>>) =>
    start(async () => {
      const r = await p();
      if (r.ok) {
        toast.success(r.message ?? "Saved.");
        router.refresh();
      } else toast.error(r.error);
    });
  return { pending, run };
}

/**
 * A site without a location: look the address up (when routing is set up) and pick the right match, or type the
 * coordinates. A match is saved only after a person picks it.
 */
export function SiteLocationForm({ siteId, label, canLookUp }: { siteId: string; label: string; canLookUp: boolean }) {
  const { pending, run } = useRun();
  const [value, setValue] = useState("");
  const [matches, setMatches] = useState<GeocodeCandidate[] | null>(null);
  const [looking, startLook] = useTransition();
  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => setSiteLocation({ siteId, location: value }));
        }}
      >
        {canLookUp && (
          <Button type="button" size="sm" variant="secondary" loading={looking} onClick={() => startLook(async () => {
            const r = await locateSite({ siteId });
            if (r.ok) setMatches(r.data);
            else toast.error(r.error);
          })}>
            Find from address
          </Button>
        )}
        <Input aria-label={`Coordinates for ${label}`} placeholder="Latitude, longitude" value={value} onChange={(e) => setValue(e.target.value)} className="h-9 w-48" inputMode="decimal" />
        <Button type="submit" size="sm" variant="ghost" disabled={pending || !value.trim()}>Save</Button>
      </form>
      {matches && (
        <ul className="rounded-xl border border-line bg-surface text-sm" aria-label={`Address matches for ${label}`}>
          {matches.map((m, i) => (
            <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 text-ink">{m.label} <span className="text-xs text-muted">({m.point.lat}, {m.point.lng}{m.precision ? `, ${m.precision}` : ""})</span></span>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => confirmSiteLocation({ siteId, lat: m.point.lat, lng: m.point.lng }))}>This is the site</Button>
            </li>
          ))}
          <li className="px-3 py-2"><Button size="sm" variant="ghost" onClick={() => setMatches(null)}>None of these</Button></li>
        </ul>
      )}
    </div>
  );
}

/** The yard (start and end of every route). */
export function YardLocationForm({ current, canLookUp }: { current: string; canLookUp: boolean }) {
  const { pending, run } = useRun();
  const [value, setValue] = useState(current);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => setYardLocation({ location: value }));
      }}
    >
      <Input aria-label="Yard coordinates" placeholder="Latitude, longitude" value={value} onChange={(e) => setValue(e.target.value)} className="h-9 w-52" inputMode="decimal" />
      <Button type="submit" size="sm" loading={pending}>Save yard</Button>
      {canLookUp && (
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => run(() => setYardLocation({ location: "", fromAddress: true }))}>
          Use the company address
        </Button>
      )}
    </form>
  );
}
