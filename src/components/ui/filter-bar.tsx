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
    <form action={action} method="get" role="search" className="flex flex-wrap items-end gap-2 border-b border-line px-4 py-3 sm:px-5">
      <div className="relative min-w-[14rem] flex-1">
        <label htmlFor="q" className="sr-only">
          Search
        </label>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input id="q" name="q" type="search" defaultValue={query} placeholder={placeholder} className="pl-9" />
      </div>
      {children}
      <button type="submit" className={buttonClasses("secondary", "md")}>
        Apply
      </button>
      <Link href={clearHref} className={buttonClasses("ghost", "md")}>
        Clear
      </Link>
    </form>
  );
}

export function FilterSelect({ name, label, value, options }: { name: string; label: string; value?: string; options: Array<{ value: string; label: string }> }) {
  return (
    <div>
      <label htmlFor={`f-${name}`} className="mb-1 block text-xs font-semibold text-muted uppercase">
        {label}
      </label>
      <select
        id={`f-${name}`}
        name={name}
        defaultValue={value ?? ""}
        className="h-10 rounded-md border border-line bg-card px-3 text-[15px] focus:border-strong focus:outline-none"
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
