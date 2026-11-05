"use client";

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Input } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { DEPARTMENTS } from "@/lib/employees";
import { personPhoto } from "@/lib/people/avatars";
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
      {/* A list of toggle buttons (pressed = chosen): buttons inside listbox options are not allowed (LR1 accessibility). */}
      <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line" aria-label="People">
        {shown.length === 0 && <li className="px-3 py-3 text-sm text-muted">Nobody matches.</li>}
        {shown.map((p) => {
          const on = selected.includes(p.user_id);
          return (
            <li key={p.user_id}>
              <button type="button" onClick={() => toggle(p.user_id)} aria-pressed={on}
                className={cn("flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface", on && "bg-strong/5")}>
                <span aria-hidden className={cn("grid size-4 shrink-0 place-items-center border", multiple ? "rounded" : "rounded-full", on ? "border-brand bg-brand text-white" : "border-ink/30 bg-card")}>
                  {on && <Check className="size-3" strokeWidth={3} />}
                </span>
                <span className="relative">
                  <Avatar name={p.name} size={32} {...personPhoto(p.user_id, p.photo_updated_at, p.avatar_key)} />
                  <PresenceDot presence={p.presence} className="absolute -right-0.5 -bottom-0.5" />
                </span>
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
