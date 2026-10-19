"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

/**
 * Shows a toast for ?param=1 after a redirect, then removes the param. Each redirect shows once; a later redirect to the
 * same page (a second save) shows again — the guard resets once the param is gone.
 */
export function FlashToast({ messages }: { messages: Record<string, { text: string; tone?: "success" | "warning" }> }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const shown = useRef<string | null>(null);

  useEffect(() => {
    const hits = Object.entries(messages).filter(([key]) => params.has(key));
    if (hits.length === 0) {
      shown.current = null;
      return;
    }
    const signature = hits.map(([key]) => `${key}=${params.get(key)}`).join("&");
    if (shown.current === signature) return;
    shown.current = signature;
    for (const [key, m] of hits) {
      const text = typeof m.text === "string" ? m.text : "";
      if (m.tone === "warning" || params.get(key) === "failed") toast.warning(text);
      else toast.success(text);
    }
    const next = new URLSearchParams(params);
    hits.forEach(([key]) => next.delete(key));
    router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false });
  }, [params, messages, router, pathname]);

  return null;
}
