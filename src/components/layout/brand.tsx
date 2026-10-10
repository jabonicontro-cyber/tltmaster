import { cn } from "@/lib/cn";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/lib/product";

export function BrandMark({ className, tone = "light" }: { className?: string; tone?: "light" | "dark" }) {
  return (
    <span className={cn("inline-flex items-center gap-2 leading-none", className)}>
      <span className="h-7 w-1.5 rounded-sm bg-brand" aria-hidden />
      <span className="flex flex-col">
        <span className={cn("text-lg font-black tracking-tight", tone === "light" ? "text-white" : "text-ink")}>
          {PRODUCT_NAME.toUpperCase()}
        </span>
        <span className={cn("text-[10px] font-bold tracking-[0.25em]", tone === "light" ? "text-white/70" : "text-muted")}>
          {PRODUCT_TAGLINE.toUpperCase()}
        </span>
      </span>
    </span>
  );
}
