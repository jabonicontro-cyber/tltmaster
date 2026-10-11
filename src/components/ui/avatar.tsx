"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { initialsOf } from "@/lib/people/photo";

/**
 * A person's photo, or their initials when there is none (or it fails to
 * load). Decorative next to a visible name; pass `label` when it stands alone.
 */
export function Avatar({ name, src, size = 32, label, className }: { name: string; src?: string; size?: number; label?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.38)) };
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true };
  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a small private image served by our own route
      <img src={src} alt={label ?? ""} aria-hidden={label ? undefined : true} width={size} height={size} onError={() => setFailed(true)} style={style} className={cn("shrink-0 rounded-full bg-surface object-cover ring-1 ring-line", className)} />
    );
  }
  return (
    <span {...a11y} style={style} className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-strong font-semibold text-white ring-1 ring-line select-none", className)}>
      {initialsOf(name)}
    </span>
  );
}
