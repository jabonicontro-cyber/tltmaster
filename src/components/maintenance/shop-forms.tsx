"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { saveShop, saveSkills, setEstimate } from "@/app/(app)/maintenance/crew-actions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import type { ActionResult } from "@/lib/action-result";
import { WO_CATEGORIES } from "@/lib/maintenance";

const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]] as const;

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return {
    pending,
    run: (p: () => Promise<ActionResult>) => start(async () => {
      const r = await p();
      if (r.ok) { toast.success(r.message ?? "Saved."); router.refresh(); } else toast.error(r.error);
    }),
  };
}

export function ShopSettingsForm({ initial }: { initial: { bays: number; shiftStart: string; shiftEnd: string; workDays: number[] } | null }) {
  const { pending, run } = useRun();
  const [v, setV] = useState(initial ?? { bays: 2, shiftStart: "07:00", shiftEnd: "15:30", workDays: [1, 2, 3, 4, 5] });
  return (
    <form className="space-y-4" aria-label="Shop settings" onSubmit={(e) => { e.preventDefault(); run(() => saveShop(v)); }}>
      <Field label="Service bays" htmlFor="shop-bays" hint="Jobs that fit at once">
        <Input id="shop-bays" type="number" min={1} max={100} value={v.bays} onChange={(e) => setV({ ...v, bays: Number(e.target.value) })} className="max-w-32" />
      </Field>
      {/* Two columns so the time fields have room for AM/PM. */}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Shift starts" htmlFor="shop-start"><Input id="shop-start" type="time" value={v.shiftStart} onChange={(e) => setV({ ...v, shiftStart: e.target.value })} /></Field>
        <Field label="Shift ends" htmlFor="shop-end"><Input id="shop-end" type="time" value={v.shiftEnd} onChange={(e) => setV({ ...v, shiftEnd: e.target.value })} /></Field>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-ink">Working days</legend>
        <div className="flex flex-wrap gap-2">
          {DAYS.map(([d, label]) => {
            const on = v.workDays.includes(d);
            return (
              <button key={d} type="button" aria-pressed={on} onClick={() => setV({ ...v, workDays: on ? v.workDays.filter((x) => x !== d) : [...v.workDays, d].sort() })}
                className={`min-h-9 rounded-xl border px-3 text-sm font-medium ${on ? "border-strong bg-strong text-white" : "border-line bg-card text-ink hover:bg-surface"}`}>
                {label}
              </button>
            );
          })}
        </div>
      </fieldset>
      <Button type="submit" disabled={pending}>{initial ? "Save shop settings" : "Set up the shop"}</Button>
    </form>
  );
}

export function SkillsRow({ userId, name, skills, canManage }: { userId: string; name: string; skills: string[]; canManage: boolean }) {
  const { pending, run } = useRun();
  const [sel, setSel] = useState(skills);
  const dirty = sel.slice().sort().join() !== skills.slice().sort().join();
  return (
    <li className="space-y-2 px-5 py-3 sm:px-6">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-ink">{name}</span>
        {canManage && dirty && <Button size="sm" disabled={pending} onClick={() => run(() => saveSkills({ userId, categories: sel }))}>Save</Button>}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${name}'s skills`}>
        {Object.entries(WO_CATEGORIES).map(([k, label]) => {
          const on = sel.includes(k);
          return (
            <button key={k} type="button" disabled={!canManage} aria-pressed={on} onClick={() => setSel(on ? sel.filter((x) => x !== k) : [...sel, k])}
              className={`min-h-8 rounded-full border px-2.5 text-xs font-medium ${on ? "border-strong bg-strong text-white" : "border-line bg-card text-muted hover:text-ink"} disabled:cursor-default`}>
              {label}
            </button>
          );
        })}
      </div>
    </li>
  );
}

export function EstimateForm({ workOrderId, hours }: { workOrderId: string; hours: number | null }) {
  const { pending, run } = useRun();
  const [v, setV] = useState(hours === null ? "" : String(hours));
  return (
    <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); run(() => setEstimate({ workOrderId, hours: v })); }}>
      <Field label="Estimated hours" htmlFor="wo-estimate" hint="The shop's own estimate, used for capacity planning">
        <Input id="wo-estimate" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="Not estimated" className="w-36" />
      </Field>
      <Button type="submit" size="sm" variant="secondary" disabled={pending || v === (hours === null ? "" : String(hours))}>Save</Button>
    </form>
  );
}
