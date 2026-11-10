"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { QR_REDEEM_PATH, qrRefusalMessage, tokenFromFragment } from "@/lib/signin-qr";

type State = { kind: "working" } | { kind: "done" } | { kind: "refused"; message: string };

/** Reads the token from the fragment once, removes it from the address bar and history, then posts it. */
export function QrSignIn() {
  const [state, setState] = useState<State>({ kind: "working" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = tokenFromFragment(window.location.hash);
    // The token never stays in the address bar, the history or a bookmark.
    window.history.replaceState(null, "", window.location.pathname);
    const run = async () => {
      if (!token) {
        setState({ kind: "refused", message: qrRefusalMessage("invalid") });
        return;
      }
      try {
        const res = await fetch(QR_REDEEM_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
          credentials: "same-origin",
          cache: "no-store",
        });
        const body = (await res.json().catch(() => null)) as { ok?: boolean; reason?: string; next?: string } | null;
        if (body?.ok && body.next) {
          setState({ kind: "done" });
          window.location.replace(body.next);
          return;
        }
        setState({ kind: "refused", message: qrRefusalMessage(body?.reason ?? "invalid") });
      } catch {
        setState({ kind: "refused", message: "No connection. Check the phone's signal, then scan the code again." });
      }
    };
    void run();
  }, []);

  if (state.kind === "refused") {
    return (
      <div className="space-y-4" data-testid="qr-refused">
        <h1 className="text-xl font-bold text-ink">This code did not sign you in</h1>
        <p role="alert" className="text-sm text-ink">{state.message}</p>
        <Link href="/login" className={buttonClasses("secondary", "lg", "w-full")}>Sign in another way</Link>
      </div>
    );
  }
  return (
    <div className="space-y-3 text-center" role="status" aria-live="polite">
      <Loader2 className="mx-auto size-8 animate-spin text-muted" aria-hidden />
      <h1 className="text-xl font-bold text-ink">{state.kind === "done" ? "Signed in. Opening My Day…" : "Signing you in…"}</h1>
      <p className="text-sm text-muted">Keep this page open for a moment.</p>
    </div>
  );
}
