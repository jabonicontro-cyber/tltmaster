"use client";

import { usePathname } from "next/navigation";
import { useRef } from "react";
import Link from "next/link";
import { PREVIEW_LABELS, PREVIEW_ROLES } from "@/lib/platform/preview";
import { setDemoPreview, setPresentationMode } from "@/app/(app)/demo-actions";

/** Shown in a demo company: fictional data, nothing leaves Taviron, and the role preview switcher. */
export function DemoBar({ preview, platformAdmin }: { preview: string | null; platformAdmin: boolean }) {
  const pathname = usePathname();
  const form = useRef<HTMLFormElement>(null);
  return (
    <div className="force-light no-print flex flex-wrap items-center justify-between gap-2 bg-amber-300 px-3 py-1.5 text-sm text-gray-950 lg:px-6" role="region" aria-label="Demo company">
      <p>
        <strong>Demo company</strong> · fictional data · nothing is sent outside Taviron
        {preview ? <> · previewing as <strong>{PREVIEW_LABELS[preview as keyof typeof PREVIEW_LABELS] ?? preview}</strong> (presentation only)</> : null}
      </p>
      <div className="flex items-center gap-3">
        <form ref={form} action={setDemoPreview} className="flex items-center gap-2">
          <input type="hidden" name="next" value={pathname} />
          <label htmlFor="demo-preview" className="font-semibold">View as</label>
          <select id="demo-preview" name="role" defaultValue={preview ?? ""} onChange={() => form.current?.requestSubmit()} className="h-8 rounded border border-gray-950/25 bg-white px-2 text-sm">
            <option value="">Myself</option>
            {PREVIEW_ROLES.map((r) => (
              <option key={r} value={r}>{PREVIEW_LABELS[r]}</option>
            ))}
          </select>
          <noscript>
            <button className="rounded bg-gray-950 px-2 py-1 text-white">Apply</button>
          </noscript>
        </form>
        <form action={setPresentationMode}>
          <input type="hidden" name="on" value="1" />
          <input type="hidden" name="next" value={pathname} />
          <button className="font-semibold underline" title="Hide this bar for screenshots or a live demo; bring it back from your user menu.">Presentation mode</button>
        </form>
        {platformAdmin ? (
          <Link href="/admin/demo" className="font-semibold underline">Platform</Link>
        ) : null}
      </div>
    </div>
  );
}
