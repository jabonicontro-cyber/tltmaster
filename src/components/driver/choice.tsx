"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A large tap target that behaves like a radio button. */
export function Choice({ name, value, checked, onChange, children, hint }: { name: string; value: string; checked: boolean; onChange: (v: string) => void; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className={cn("flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border-2 px-4 py-3 text-base", checked ? "border-charcoal bg-charcoal text-white" : "border-line bg-white text-ink")}>
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} className="size-5 accent-brand" />
      <span className="min-w-0">
        <span className="block font-semibold">{children}</span>
        {hint && <span className={cn("block text-sm", checked ? "text-white/80" : "text-muted")}>{hint}</span>}
      </span>
    </label>
  );
}
