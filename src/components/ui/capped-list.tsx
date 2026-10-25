import type { ReactNode } from "react";

/**
 * A list that shows its first few rows and folds the rest behind "Show N more" (works without JavaScript). Keeps long
 * attention lists from pushing the rest of a page out of sight; nothing is hidden for good.
 */
export function CappedList({ items, first = 6, label, className = "divide-y divide-line" }: { items: ReactNode[]; first?: number; label?: string; className?: string }) {
  const head = items.slice(0, first);
  const rest = items.slice(first);
  return (
    <>
      <ul className={className} aria-label={label}>{head}</ul>
      {rest.length > 0 && (
        <details className="group border-t border-line">
          <summary className="cursor-pointer list-none px-5 py-2.5 text-center text-sm font-medium text-brand-fg hover:underline sm:px-6">
            <span className="group-open:hidden">Show {rest.length} more</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul className={className}>{rest}</ul>
        </details>
      )}
    </>
  );
}
