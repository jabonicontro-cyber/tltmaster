import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { returnTarget } from "@/lib/safe-redirect";

/** "Back to …" — returns to the exact queue, filter and page the record was opened from. */
export function ReturnLink({ back }: { back?: string | string[] }) {
  const t = returnTarget(back);
  if (!t) return null;
  return (
    <Link href={t.href} className="mb-2 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink hover:underline">
      <ArrowLeft className="size-4" aria-hidden /> {t.label}
    </Link>
  );
}
