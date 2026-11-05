"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { saveMyAccessibility } from "@/app/accessibility-actions";
import { A11Y_DEFAULTS, TEXT_SIZES, applyAccessibility, type AccessibilitySettings, type TextSize } from "@/lib/accessibility";
import { cn } from "@/lib/cn";

/**
 * Accessibility mode (owner 2026-11-05): each change applies at once and is saved with the person's account, so it
 * follows them to every device. Nothing here changes what anyone else sees.
 */
export function AccessibilityForm({ initial }: { initial: AccessibilitySettings | null }) {
  const [s, setS] = useState<AccessibilitySettings>(initial ?? A11Y_DEFAULTS);
  const [pending, start] = useTransition();
  const change = (next: AccessibilitySettings) => {
    const before = s;
    setS(next);
    applyAccessibility(next);
    start(async () => {
      const r = await saveMyAccessibility(next);
      if (r.ok) toast.success(r.message ?? "Saved.");
      else {
        toast.error(r.error);
        setS(before);
        applyAccessibility(before);
      }
    });
  };
  const toggles: Array<{ key: "highContrast" | "reduceMotion" | "readableFont"; label: string; hint: string }> = [
    { key: "highContrast", label: "High contrast", hint: "Darker secondary text, clearer borders and thicker focus outlines." },
    { key: "reduceMotion", label: "Reduce motion", hint: "No animations or sliding panels, even if your device allows them." },
    { key: "readableFont", label: "Easier-to-read font", hint: "A font designed for legibility, with a little more space between letters." },
  ];
  return (
    <div className="space-y-5 px-5 pb-5 sm:px-6" aria-busy={pending}>
      <fieldset>
        <legend className="text-sm font-semibold text-ink">Text size</legend>
        <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Text size">
          {TEXT_SIZES.map((t) => (
            <label key={t.value} className={cn("inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-control border px-3.5 text-sm", s.textSize === t.value ? "border-strong bg-strong/5 font-semibold text-ink" : "border-line text-ink")}>
              <input type="radio" name="text-size" value={t.value} checked={s.textSize === t.value} onChange={() => change({ ...s, textSize: t.value as TextSize })} className="size-4 accent-brand" />
              {t.label} <span className="text-muted">({t.value}%)</span>
            </label>
          ))}
        </div>
      </fieldset>
      <ul className="space-y-3">
        {toggles.map((t) => (
          <li key={t.key}>
            <label className="flex min-h-11 cursor-pointer items-start gap-3">
              <input type="checkbox" checked={s[t.key]} onChange={(e) => change({ ...s, [t.key]: e.target.checked })} className="mt-1 size-4 shrink-0 accent-brand" />
              <span>
                <span className="block text-sm font-semibold text-ink">{t.label}</span>
                <span className="block text-sm text-muted">{t.hint}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">Saved with your account, so these settings follow you to every phone and computer you sign in on. Your browser&apos;s own zoom still works too.</p>
    </div>
  );
}
