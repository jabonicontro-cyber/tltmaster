import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Wide tables scroll inside this box on narrow screens. `relative` makes it the containing block for absolutely
 * positioned children (sr-only column labels), which otherwise escape the scroll box and widen the whole page.
 */
export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("relative overflow-x-auto", className)}>{children}</div>;
}

export function Table({ className, ...props }: ComponentProps<"table">) {
  return <table className={cn("w-full border-collapse text-left text-[15px]", className)} {...props} />;
}

export function Th({ className, align, ...props }: ComponentProps<"th"> & { align?: "left" | "right" | "center" }) {
  return (
    <th
      scope="col"
      className={cn(
        "border-b border-line px-3 py-3 text-xs font-medium text-muted first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, align, ...props }: ComponentProps<"td"> & { align?: "left" | "right" | "center" }) {
  return (
    <td
      className={cn(
        "border-b border-line/60 px-3 py-3.5 align-top first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6",
        align === "right" && "text-right tabular",
        align === "center" && "text-center",
        className,
      )}
      {...props}
    />
  );
}

export function Tr({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("transition-colors hover:bg-surface/70 [&:last-child>td]:border-b-0", className)} {...props} />;
}
