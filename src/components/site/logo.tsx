import { cn } from "@/lib/cn";
import { TavironEmblem } from "@/components/layout/brand";

export { TavironEmblem };

/** The Taviron logo on the public website (shared emblem with first-party app screens). */
export function TavironLogo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <TavironEmblem />
      <span className="text-[15px] font-semibold tracking-[0.22em] text-cloud">TAVIRON</span>
    </span>
  );
}
