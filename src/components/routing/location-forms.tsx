"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { locateSite, setSiteLocation, setYardLocation } from "@/app/(app)/route-planner/actions";
import type { ActionResult } from "@/lib/action-result";

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

/** A site without a location: look the address up (when routing is set up) or type the coordinates. */
export function SiteLocationForm({ siteId, label, canLookUp }: { siteId: string; label: string; canLookUp: boolean }) {
  const { pending, run } = useRun();
  const [value, setValue] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => setSiteLocation({ siteId, location: value }));
      }}
    >
      {canLookUp && (
        <Button type="button" size="sm" variant="secondary" loading={pending} onClick={() => run(() => locateSite({ siteId }))}>
          Find from address
        </Button>
      )}
      <Input aria-label={`Coordinates for ${label}`} placeholder="Latitude, longitude" value={value} onChange={(e) => setValue(e.target.value)} className="h-9 w-48" inputMode="decimal" />
      <Button type="submit" size="sm" variant="ghost" disabled={pending || !value.trim()}>Save</Button>
    </form>
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
