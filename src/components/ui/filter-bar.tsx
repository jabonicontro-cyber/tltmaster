import Link from "next/link";
import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { buttonClasses } from "./button";
import { Input } from "./form";

/**
 * Search + filter form using plain GET parameters, so filters are bookmarkable
 * and work without JavaScript.
 */
export function FilterBar({ action, query, placeholder = "Search…", children, clearHref }: { action: string; query?: string; placeholder?: string; children?: ReactNode; clearHref: string }) {
  return (
    <form action={action} method="get" role="search" className="space-y-3 border-b border-line/60 px-5 py-4 sm:px-6">
      {/* Search and the actions on one line; filters, when there are any, on a quiet line below. */}
      {/* Phones: the search gets the whole line, the actions sit below it. */}
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1">
          <label htmlFor="q" className="sr-only">
            Search
          </label>
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input id="q" name="q" type="search" defaultValue={query} placeholder={placeholder} className="rounded-full border-transparent bg-surface pl-10 shadow-none" />
        </div>
        <button type="submit" className={buttonClasses("secondary", "md")}>
          Apply
        </button>
        <Link href={clearHref} className={buttonClasses("ghost", "md")}>
          Clear
        </Link>
      </div>
      {children ? <div className="grid grid-cols-2 items-end gap-x-3 gap-y-2 sm:flex sm:flex-wrap">{children}</div> : null}
    </form>
  );
}

export function FilterSelect({ name, label, value, options }: { name: string; label: string; value?: string; options: Array<{ value: string; label: string }> }) {
  return (
    // A long option (a customer's full name) must never widen the page: the select shrinks to the space it has.
    <div className="min-w-0 max-w-full">
      <label htmlFor={`f-${name}`} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>
      <select
        id={`f-${name}`}
        name={name}
        defaultValue={value ?? ""}
        className="h-10 w-full max-w-full rounded-control border border-line bg-card px-3 sm:w-auto text-[15px] focus:border-brand focus:ring-4 focus:ring-brand/12 focus:outline-none sm:max-w-xs"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
