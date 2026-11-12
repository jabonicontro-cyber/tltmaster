import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Search and filters above a list: a GET form (the filters live in the URL, so a filtered list can be shared and the
 * back button works). Fields sit in one row on wide screens and stack on phones; the submit button goes last.
 *
 *   <FilterBar aria-label="Filter leads">
 *     <FilterField label="Search" grow><Input name="q" /></FilterField>
 *     <Button type="submit" variant="secondary">Search</Button>
 *   </FilterBar>
 */
export function FilterBar({ className, children, ...props }: ComponentProps<"form">) {
  return (
    <form role="search" className={cn("mb-5 flex flex-wrap items-end gap-x-3 gap-y-3", className)} {...props}>
      {children}
    </form>
  );
}

/**
 * One labelled field. `grow` lets it take the free width (search boxes); other fields get `width` from the small-screen
 * breakpoint up (default "sm:w-40", so six filters and a button fit one row), and share a row two by two on phones.
 */
export function FilterField({ label, children, grow, width = "sm:w-40", className }: { label: ReactNode; children: ReactNode; grow?: boolean; width?: string; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5 text-[13px] font-medium text-muted", grow ? "min-w-[min(100%,14rem)] flex-1" : cn("max-sm:min-w-[calc(50%-0.375rem)] max-sm:flex-1", width), className)}>
      {label}
      {children}
    </label>
  );
}
