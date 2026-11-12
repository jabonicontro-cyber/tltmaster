import { Search } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * The console's search box (PC1): a plain form to /staff/search, so it works for both staff levels and without
 * JavaScript. The console header can mount it as is (compact) or a page can show it full width.
 */
export function ConsoleSearchBox({ defaultValue = "", compact = false, className }: { defaultValue?: string; compact?: boolean; className?: string }) {
  return (
    <form method="get" action="/staff/search" role="search" aria-label="Search the console" className={cn("flex items-center gap-2", className)}>
      <label className="relative min-w-0 flex-1">
        <span className="sr-only">Search companies, leads, outreach, support requests and the team</span>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input
          type="search"
          name="q"
          defaultValue={defaultValue}
          maxLength={80}
          placeholder={compact ? "Search" : "Company, lead, outreach company, request or person"}
          className={cn("w-full rounded-control border border-line bg-card pl-9 pr-3 text-sm text-ink placeholder:text-muted", compact ? "h-9" : "h-10")}
        />
      </label>
      {!compact && <button type="submit" className={buttonClasses("secondary")}>Search</button>}
    </form>
  );
}
