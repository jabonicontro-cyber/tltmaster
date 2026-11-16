"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { MODULES, PRESETS, PRESET_KEYS, moduleInfo, presetOf, toggleModule, type ModuleKey } from "@/lib/modules";
import { saveModules } from "@/app/(app)/settings/actions";

/**
 * What you use (MOD1, docs/MODULES.md): the company owner switches workflow modules on or off, from a starting point.
 * Switching off hides an area for everyone; nothing is deleted and no permission changes.
 */
export function ModulesForm({ off: savedOff, canEdit }: { off: ModuleKey[]; canEdit: boolean }) {
  const router = useRouter();
  const [off, setOff] = useState<ModuleKey[]>(savedOff);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const preset = presetOf(off);
  const changed = [...off].sort().join() !== [...savedOff].sort().join();

  const toggle = (key: ModuleKey, on: boolean) => {
    const r = toggleModule(off, key, on);
    setOff(r.off);
    const label = moduleInfo(key).label;
    setNote(r.alsoChanged.length ? `${on ? "Also switched on" : "Also switched off"}: ${r.alsoChanged.map((k) => moduleInfo(k).label).join(", ")} (${on ? `${label} needs ${r.alsoChanged.length === 1 ? "it" : "them"}` : `${r.alsoChanged.length === 1 ? "it needs" : "they need"} ${label}`}).` : "");
  };

  const save = () => {
    setError("");
    start(async () => {
      const r = await saveModules(off);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setNote("");
      toast.success(r.message ?? "Saved.");
      router.refresh();
    });
  };

  return (
    <section className="space-y-5 p-5 sm:p-6" aria-labelledby="modules-title">
      <div>
        <h2 id="modules-title" className="text-base font-semibold text-ink">What you use</h2>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Switch off what your company doesn&apos;t use and it disappears for everyone: the menu, the pages and the steps that lead there. Nothing is deleted. Switch it back on any time and everything is there again.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-ink">Start from</h3>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Starting points">
          {PRESET_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              disabled={!canEdit}
              aria-pressed={preset === k}
              onClick={() => { setOff([...PRESETS[k].off]); setNote(""); }}
              className={cn(
                "rounded-xl border p-3 text-left transition-colors disabled:cursor-default",
                preset === k ? "border-strong bg-strong/[0.06]" : "border-line hover:border-strong/60",
              )}
            >
              <span className="block text-sm font-semibold text-ink">{PRESETS[k].label}</span>
              <span className="mt-0.5 block text-xs text-muted">{PRESETS[k].hint}</span>
            </button>
          ))}
        </div>
        {preset === null && <p className="mt-2 text-xs text-muted">Your own choice: adjusted from a starting point.</p>}
      </div>

      <fieldset disabled={!canEdit}>
        <legend className="text-sm font-semibold text-ink">Areas</legend>
        <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => {
            const on = !off.includes(m.key);
            return (
              <li key={m.key}>
                <label className={cn("flex h-full cursor-pointer items-start gap-3 rounded-xl border p-3", on ? "border-strong" : "border-line")}>
                  <input type="checkbox" checked={on} onChange={(e) => toggle(m.key, e.target.checked)} className="mt-0.5 size-4" aria-label={`Use ${m.label}`} />
                  <span>
                    <span className="block text-sm font-semibold text-ink">{m.label}</span>
                    <span className="block text-xs text-muted">{m.hint}</span>
                    {m.needs.length > 0 && <span className="mt-1 block text-xs text-muted">Needs {m.needs.map((n) => moduleInfo(n).label).join(" and ")}.</span>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <p className="text-xs text-muted">Always on: Safety, Driver Reports and Communications (safety comes first), and Customers, Fleet, People and Settings.</p>
      {note && <p className="text-sm text-ink" role="status">{note}</p>}
      <FormError message={error} />
      {canEdit ? (
        <Button onClick={save} loading={pending} disabled={!changed}>Save</Button>
      ) : (
        <p className="text-sm text-muted">Only someone who manages the company&apos;s settings can change this.</p>
      )}
    </section>
  );
}
