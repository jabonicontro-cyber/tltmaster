import Link from "next/link";
import { buttonClasses } from "./button";

export function Pagination({ page, pageSize, total, hrefFor }: { page: number; pageSize: number; total: number; hrefFor: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm text-muted sm:px-5">
      <span>
        Showing {from}–{to} of {total}
      </span>
      {pages > 1 && (
        <div className="flex gap-2">
          {page > 1 ? (
            <Link href={hrefFor(page - 1)} className={buttonClasses("secondary", "sm")}>
              Previous
            </Link>
          ) : (
            <span aria-disabled="true" className={buttonClasses("secondary", "sm", "pointer-events-none opacity-50")}>Previous</span>
          )}
          {page < pages ? (
            <Link href={hrefFor(page + 1)} className={buttonClasses("secondary", "sm")}>
              Next
            </Link>
          ) : (
            <span aria-disabled="true" className={buttonClasses("secondary", "sm", "pointer-events-none opacity-50")}>Next</span>
          )}
        </div>
      )}
    </div>
  );
}
