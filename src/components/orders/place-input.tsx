"use client";

import { useId, useMemo, useState } from "react";
import { MapPin } from "lucide-react";
import { Input } from "@/components/ui/form";
import { matchPlaces, type StopPlace } from "@/lib/orders/stop-checks";
import { cn } from "@/lib/cn";

/**
 * The stop's place name with suggestions (owner 2026-11-16/17, WK3): typing shows the customer's job sites first, then
 * the company's saved places; choosing one fills the name and address. Typing anything else always works (the
 * suggestions only help). Keyboard: ↓/↑ to move, Enter to choose, Escape to close.
 */
export function PlaceInput({ id, value, places, onType, onPick }: {
  id: string;
  value: string;
  places: ReadonlyArray<StopPlace>;
  onType: (name: string) => void;
  onPick: (place: StopPlace) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const hits = useMemo(() => (places.length ? matchPlaces(places, value) : []), [places, value]);
  const show = open && hits.length > 0;

  const choose = (p: StopPlace) => {
    onPick(p);
    setOpen(false);
  };

  if (!places.length) {
    return <Input id={id} value={value} maxLength={160} onChange={(e) => onType(e.target.value)} autoComplete="off" />;
  }
  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={show && hits[active] ? `${listId}-${active}` : undefined}
        value={value}
        maxLength={160}
        autoComplete="off"
        placeholder="Type a name or pick a saved place"
        onFocus={() => { setOpen(true); setActive(0); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { onType(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, hits.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && show && hits[active]) { e.preventDefault(); choose(hits[active]); }
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {show && (
        <ul id={listId} role="listbox" aria-label="Saved places" className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-2xl border border-line/70 bg-card p-1 shadow-float">
          {hits.map((p, i) => {
            const address = [p.address_line1, p.city, [p.state, p.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
            const groupStart = i === 0 || hits[i - 1].group !== p.group;
            return (
              <li key={p.key} role="presentation">
                {groupStart && <p className="px-3 pt-2 pb-1 text-xs font-semibold text-muted" aria-hidden>{p.group === "site" ? "This customer's job sites" : "Your saved places"}</p>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => { e.preventDefault(); choose(p); }}
                  onMouseEnter={() => setActive(i)}
                  className={cn("flex cursor-pointer items-start gap-2 rounded-xl px-3 py-2 text-[15px]", i === active && "bg-surface")}
                >
                  <MapPin className="mt-1 size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{p.name}</span>
                    <span className="block text-sm text-muted">{[p.label, address].filter(Boolean).join(" · ")}</span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
