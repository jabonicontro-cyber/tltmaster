"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** A small button that copies a record's reference (ORD-1042) for a phone call, email or message. */
export function CopyReference({ value, label = "reference" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      className="inline-flex size-8 items-center justify-center rounded-xl text-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-strong"
      aria-label={copied ? `Copied ${value}` : `Copy ${label} ${value}`}
      title={copied ? "Copied" : `Copy ${value}`}
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
    </button>
  );
}
