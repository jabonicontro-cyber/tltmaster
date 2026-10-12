"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Select } from "@/components/ui/form";
import type { Presence } from "@/lib/communications";
import { setPresence } from "@/app/(app)/communications/actions";

/** Choose Available / Busy / Away, or Automatic (Available while active, Away after inactivity). */
export function PresencePicker({ value }: { value: Presence | null }) {
  const [v, setV] = useState<string>(value ?? "");
  return (
    <label className="inline-flex items-center gap-2 text-sm text-muted">
      <span className="whitespace-nowrap">My status</span>
      <Select
        aria-label="My status"
        className="h-9 w-40"
        value={v}
        onChange={async (e) => {
          const next = e.target.value;
          const prev = v;
          setV(next);
          const r = await setPresence(next === "" ? null : (next as Presence));
          if (!r.ok) { setV(prev); toast.error(r.error); }
        }}
      >
        <option value="">Automatic</option>
        <option value="available">Available</option>
        <option value="busy">Busy</option>
        <option value="away">Away</option>
      </Select>
    </label>
  );
}
