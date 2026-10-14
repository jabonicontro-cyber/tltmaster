import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function DescriptionList({ items, className }: { items: Array<{ label: string; value: ReactNode; wide?: boolean }>; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2", className)}>
      {items.map((item) => (
        <div key={item.label} className={item.wide ? "sm:col-span-2" : undefined}>
          <dt className="text-sm text-muted">{item.label}</dt>
          <dd className="mt-0.5 text-[15px] break-words whitespace-pre-line text-ink">
            {item.value === "" || item.value === null || item.value === undefined ? <span className="text-muted">—</span> : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
