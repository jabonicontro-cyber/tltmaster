"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
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

  // `pair`: the section's row and column beside its partner on wide screens (main i ↔ rail i), so the two columns
  // line up and each pair ends at the same height (owner 2026-11-01: "make these tiles even with each other").
  const render = (id: SectionId, pair?: { row: number; col: 1 | 2 }) => {
    const s = byId.get(id);
    if (!s) return null;
    const index = visible.indexOf(id);
    const isCollapsed = collapsed.includes(id);
    return (
      <section
        key={id}
        id={id === "attention" ? "attention" : undefined}
        aria-labelledby={`section-${id}`}
        style={pair ? ({ "--row": pair.row } as CSSProperties) : undefined}
        className={cn("flex min-w-0 scroll-mt-20 flex-col", pair && "xl:[grid-row:var(--row)]", pair?.col === 1 && "xl:col-start-1", pair?.col === 2 && "xl:col-start-2")}
      >
        <div className="mb-3 flex min-h-9 items-center gap-2">
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
        <div id={`section-body-${id}`} className={cn("flex flex-1 flex-col [&>*]:flex-1", isCollapsed && "hidden")}>{s.content}</div>
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
        main.length > 0 && rail.length > 0 ? (
          // Phones and tablets: the main sections, then the rail. Wide screens: side by side, row by row.
          <div className="grid grid-cols-1 gap-9 xl:grid-cols-[minmax(0,1fr)_23rem] xl:gap-x-6">
            {main.map((id, i) => render(id, { row: i + 1, col: 1 }))}
            {rail.map((id, i) => render(id, { row: i + 1, col: 2 }))}
          </div>
        ) : (
          <div className="min-w-0 space-y-9">{[...main, ...rail].map((id) => render(id))}</div>
        )
      )}
      {full.map((id) => render(id))}
    </div>
  );
}
