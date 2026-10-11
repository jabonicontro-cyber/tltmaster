"use client";

import { usePathname } from "next/navigation";
import { useRef } from "react";
import Link from "next/link";
import { PREVIEW_LABELS, PREVIEW_ROLES } from "@/lib/platform/preview";
import { setDemoPreview } from "@/app/(app)/demo-actions";

/** Shown in a demo company: fictional data, nothing leaves Taviron, and the role preview switcher. */
export function DemoBar({ preview, platformAdmin }: { preview: string | null; platformAdmin: boolean }) {
  const pathname = usePathname();
  const form = useRef<HTMLFormElement>(null);
  return (
    <div className="no-print flex flex-wrap items-center justify-between gap-2 bg-amber-400 px-3 py-1.5 text-sm text-charcoal lg:px-6" role="region" aria-label="Demo company">
      <p>
        <strong>Demo company</strong> · fictional data · nothing is sent outside Taviron
        {preview ? <> · previewing as <strong>{PREVIEW_LABELS[preview as keyof typeof PREVIEW_LABELS] ?? preview}</strong> (presentation only)</> : null}
      </p>
      <div className="flex items-center gap-3">
        <form ref={form} action={setDemoPreview} className="flex items-center gap-2">
          <input type="hidden" name="next" value={pathname} />
          <label htmlFor="demo-preview" className="font-semibold">View as</label>
          <select id="demo-preview" name="role" defaultValue={preview ?? ""} onChange={() => form.current?.requestSubmit()} className="h-8 rounded border border-charcoal/30 bg-white px-2 text-sm">
            <option value="">Myself</option>
            {PREVIEW_ROLES.map((r) => (
              <option key={r} value={r}>{PREVIEW_LABELS[r]}</option>
            ))}
          </select>
          <noscript>
            <button className="rounded bg-charcoal px-2 py-1 text-white">Apply</button>
          </noscript>
        </form>
        {platformAdmin ? (
          <Link href="/admin/demo" className="font-semibold underline">Platform</Link>
        ) : null}
      </div>
    </div>
  );
}
