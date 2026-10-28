"use client";

import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { saveCommandCenterLayout } from "@/app/(app)/command-center/actions";
import { cn } from "@/lib/cn";

export type SectionId = "outlook" | "weather" | "my_work" | "attention" | "operations" | "speed" | "sales" | "activity";

export interface Section {
  id: SectionId;
  title: string;
  /** One line shown while the section is collapsed (e.g. "3 urgent"); never hides the pinned status strip. */
  collapsedSummary?: ReactNode;
  content: ReactNode;
  /**
   * Where the section sits on wide screens (owner 2026-10-28: less choppy, important first): "main" beside a narrow
   * "rail" at the top, "full" width below. Phones show one column in that same order.
   */
  place?: "main" | "rail" | "full";
}

/**
 * The Command Center's sections in the person's own order, each collapsible.
 * Layout only: what a section contains is decided on the server by permission;
 * arranging sections never shows or grants anything more.
 */
export function SectionLayout({ sections, initial }: { sections: Section[]; initial: { order: string[]; collapsed: string[] } | null }) {
  const ids = sections.map((s) => s.id);
  const start = [...(initial?.order ?? []).filter((id): id is SectionId => ids.includes(id as SectionId)), ...ids.filter((id) => !(initial?.order ?? []).includes(id))];
  const [order, setOrder] = useState<SectionId[]>(start);
  const [collapsed, setCollapsed] = useState<SectionId[]>((initial?.collapsed ?? []).filter((id): id is SectionId => ids.includes(id as SectionId)));
  const [customizing, setCustomizing] = useState(false);

  const save = async (o: SectionId[], c: SectionId[]) => {
    const r = await saveCommandCenterLayout({ order: o, collapsed: c });
    if (!r.ok) toast.error(`${r.error} Your layout is kept on this page only.`);
  };
  const move = (id: SectionId, dir: -1 | 1) => {
    const i = order.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
    void save(next, collapsed);
  };
  const toggle = (id: SectionId) => {
    const next = collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id];
    setCollapsed(next);
    void save(order, next);
  };
  const byId = new Map(sections.map((s) => [s.id, s]));

  const render = (id: SectionId) => {
    const s = byId.get(id);
    if (!s) return null;
    const index = visible.indexOf(id);
    const isCollapsed = collapsed.includes(id);
    return (
      <section key={id} id={id === "attention" ? "attention" : undefined} aria-labelledby={`section-${id}`} className="scroll-mt-20">
        <div className="mb-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => toggle(id)}
            aria-expanded={!isCollapsed}
            aria-controls={`section-body-${id}`}
            className="group flex min-w-0 items-center gap-2 rounded-full text-left"
          >
            <h2 id={`section-${id}`} className="text-lg font-semibold tracking-[-0.015em] text-ink">{s.title}</h2>
            {isCollapsed ? <ChevronRight className="size-4 shrink-0 text-muted transition-colors group-hover:text-ink" aria-hidden /> : <ChevronDown className="size-4 shrink-0 text-muted transition-colors group-hover:text-ink" aria-hidden />}
          </button>
          {isCollapsed && s.collapsedSummary && <span className="truncate text-sm text-muted">{s.collapsedSummary}</span>}
          <span className="ml-auto flex items-center gap-1">
            {customizing && (
              <>
                <Button size="sm" variant="secondary" aria-label={`Move ${s.title} up`} disabled={order.indexOf(id) === 0} onClick={() => move(id, -1)} icon={<ArrowUp className="size-4" />}>Up</Button>
                <Button size="sm" variant="secondary" aria-label={`Move ${s.title} down`} disabled={order.indexOf(id) === order.length - 1} onClick={() => move(id, 1)} icon={<ArrowDown className="size-4" />}>Down</Button>
              </>
            )}
            {/* Arranging lives on the first section's line instead of a row of its own. */}
            {index === 0 && (
              <Button size="sm" variant={customizing ? "dark" : "ghost"} icon={<SlidersHorizontal className="size-4" />} aria-pressed={customizing} onClick={() => setCustomizing((c) => !c)}>
                {customizing ? "Done arranging" : "Arrange sections"}
              </Button>
            )}
          </span>
        </div>
        <div id={`section-body-${id}`} className={cn(isCollapsed && "hidden")}>{s.content}</div>
      </section>
    );
  };

  // The person's order decides the order inside each area; the area itself comes from the section.
  const placed = (p: NonNullable<Section["place"]>) => order.filter((id) => (byId.get(id)?.place ?? "full") === p);
  const main = placed("main");
  const rail = placed("rail");
  const full = placed("full");
  const visible = [...main, ...rail, ...full];

  return (
    <div className="space-y-9">
      {(main.length > 0 || rail.length > 0) && (
        <div className={cn("grid grid-cols-1 gap-9", main.length > 0 && rail.length > 0 && "xl:grid-cols-[minmax(0,1fr)_23rem] xl:gap-6")}>
          {main.length > 0 && <div className="min-w-0 space-y-9">{main.map(render)}</div>}
          {rail.length > 0 && <div className="min-w-0 space-y-9">{rail.map(render)}</div>}
        </div>
      )}
      {full.map(render)}
    </div>
  );
}
