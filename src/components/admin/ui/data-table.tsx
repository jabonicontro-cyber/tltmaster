import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A console table that never scrolls sideways on a phone: from 768px it is an ordinary table in a hairline panel;
 * below that each row becomes a card, the first cell (`primary`) its title and every other cell a "label: value" line
 * from its `label` (globals.css `.console-table`). One DOM for both, so links, rows and names stay the same everywhere.
 *
 *   <DataTable aria-label="Leads" head={<><DataHead>Name</DataHead><DataHead align="right">Trucks</DataHead></>}>
 *     <DataRow key={id}><DataCell primary>…</DataCell><DataCell label="Trucks" align="right">12</DataCell></DataRow>
 *   </DataTable>
 *
 * `empty` on a cell hides it on phones when it has nothing to say (e.g. no owner yet), instead of a bare dash.
 * Wide tables still scroll inside the panel between 768px and their natural width.
 */
export function DataTable({ head, children, className, frame = true, ...props }: Omit<ComponentProps<"table">, "children"> & {
  head: ReactNode;
  children: ReactNode;
  /** false: no panel around it (when it already sits inside a Panel). */
  frame?: boolean;
}) {
  const table = (
    <table className="console-table w-full border-collapse text-left text-[15px]" {...props}>
      <thead>
        <tr>{head}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
  // `className` styles the outer box (e.g. "self-start" in a grid), not the table.
  return <div className={cn("min-w-0 overflow-x-auto", frame && "rounded-xl border border-line bg-card shadow-[0_1px_2px_rgb(12_26_43/0.04)]", className)}>{table}</div>;
}

export function DataHead({ className, align, ...props }: ComponentProps<"th"> & { align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={cn(
        "border-b border-line bg-surface/50 px-3 py-2.5 text-xs font-medium whitespace-nowrap text-muted first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6",
        align === "right" && "text-right",
        className,
      )}
      {...props}
    />
  );
}

export function DataRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("transition-colors duration-150 md:hover:bg-surface/60 [&:last-child>td]:border-b-0", className)} {...props} />;
}

export function DataCell({ className, align, label, primary, empty, ...props }: ComponentProps<"td"> & {
  align?: "left" | "right";
  /** The column name, shown before the value on phones. */
  label?: string;
  /** The row's title cell (usually the first): full width on phones, no label. */
  primary?: boolean;
  /** Nothing to show: hidden on phones. */
  empty?: boolean;
}) {
  return (
    <td
      data-label={label}
      data-primary={primary ? "" : undefined}
      data-empty={empty ? "" : undefined}
      className={cn(
        "border-b border-line/70 px-3 py-3.5 align-top first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6",
        align === "right" && "text-right tabular",
        className,
      )}
      {...props}
    />
  );
}
