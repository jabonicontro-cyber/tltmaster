"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { DEPARTMENTS } from "@/lib/employees";
import { ROLE_LABELS, type AppRole } from "@/lib/permissions";
import type { Person } from "@/server/data/communications";
import { PresenceDot, WorkStatusBadge } from "./status";

/** Search and choose coworkers. Shows presence and work status (never as availability). */
export function PeoplePicker({ people, selected, onChange, multiple = true, exclude = [] }: {
  people: Person[];
  selected: string[];
  onChange: (ids: string[]) => void;
  multiple?: boolean;
  exclude?: string[];
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return people.filter((p) => !exclude.includes(p.user_id) && (!t || p.name.toLowerCase().includes(t) || (p.department ?? "").includes(t) || p.role.includes(t)));
  }, [people, q, exclude]);
  const toggle = (id: string) => {
    if (!multiple) return onChange([id]);
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };
  return (
    <div className="space-y-2">
      <Input type="search" placeholder="Search people…" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line" role="listbox" aria-multiselectable={multiple}>
        {shown.length === 0 && <li className="px-3 py-3 text-sm text-muted">Nobody matches.</li>}
        {shown.map((p) => {
          const on = selected.includes(p.user_id);
          return (
            <li key={p.user_id} role="option" aria-selected={on}>
              <button type="button" onClick={() => toggle(p.user_id)}
                className={cn("flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface", on && "bg-strong/5")}>
                <input type={multiple ? "checkbox" : "radio"} readOnly checked={on} tabIndex={-1} aria-hidden className="size-4 accent-brand" />
                <PresenceDot presence={p.presence} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{p.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {ROLE_LABELS[p.role as AppRole] ?? p.role}{p.department ? ` · ${DEPARTMENTS[p.department as keyof typeof DEPARTMENTS] ?? p.department}` : ""}
                  </span>
                </span>
                <WorkStatusBadge status={p.work_status} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
