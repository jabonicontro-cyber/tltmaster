"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Fingerprint } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { credentialToJson, creationOptionsFromJson, passkeyErrorMessage, requestOptionsFromJson, type CreationOptionsJson, type RequestOptionsJson } from "@/lib/passkeys";
import { passkeyRegisterFinish, passkeyRegisterStart, passkeySignInFinish, passkeySignInStart } from "@/app/(auth)/passkey-actions";

// Face or fingerprint sign-in (passkeys, master plan DS1). The wording fits iPhone (Face ID, Touch ID) and Android
// (face unlock, fingerprint): the phone shows its own prompt. Shown only when the server offers passkeys and this
// browser can use them; otherwise nothing appears and the password works as always.

type Ceremony = Parameters<typeof credentialToJson>[0];

const noSubscription = () => () => undefined;

function webAuthnSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && Boolean(navigator.credentials);
}

/** "Sign in with face or fingerprint" on the sign-in page. */
export function PasskeySignInButton() {
  // false while rendering on the server, then what this browser can do.
  const supported = useSyncExternalStore(noSubscription, webAuthnSupported, () => false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!supported) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const start = await passkeySignInStart();
      if (!start.ok) return setError(start.error);
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.get({ publicKey: requestOptionsFromJson(start.data.options as unknown as RequestOptionsJson) });
      } catch (e) {
        return setError(passkeyErrorMessage((e as { name?: string }).name));
      }
      if (!credential) return setError(passkeyErrorMessage(undefined));
      const done = await passkeySignInFinish(start.data.challengeId, credentialToJson(credential as unknown as Ceremony));
      if (!done.ok) return setError(done.error);
      window.location.assign(done.data.next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {error ? <p role="alert" className="text-sm text-critical">{error}</p> : null}
      <Button type="button" variant="secondary" size="lg" className="w-full" onClick={run} loading={busy} icon={<Fingerprint className="size-5" />} data-testid="passkey-sign-in">
        Sign in with face or fingerprint
      </Button>
    </div>
  );
}

const OFFER_KEY = "taviron-passkey-offer";
const LATER_DAYS = 30;

function offerState(userId: string): "done" | "later" | null {
  try {
    const raw = window.localStorage.getItem(`${OFFER_KEY}:${userId}`);
    if (!raw) return null;
    if (raw === "done") return "done";
    const at = Number(raw.replace(/^later:/, ""));
    return Number.isFinite(at) && Date.now() - at < LATER_DAYS * 86_400_000 ? "later" : null;
  } catch {
    return null;
  }
}

function remember(userId: string, value: string) {
  try {
    window.localStorage.setItem(`${OFFER_KEY}:${userId}`, value);
  } catch {
    // Private browsing: the offer may show again next time, nothing else changes.
  }
}

/**
 * "Sign in with your face or fingerprint next time": offered on My Day after signing in on a phone that has face or
 * fingerprint unlock. Once set up (or "Not now", for 30 days) it is not offered again on that phone.
 */
export function PasskeyOffer({ userId }: { userId: string }) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!webAuthnSupported() || offerState(userId)) return;
    let alive = true;
    void PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      .then((ok) => { if (alive && ok) setShow(true); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [userId]);
  if (!show) return null;

  const setUp = async () => {
    setBusy(true);
    setError(null);
    try {
      const start = await passkeyRegisterStart();
      if (!start.ok) return setError(start.error);
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.create({ publicKey: creationOptionsFromJson(start.data.options as unknown as CreationOptionsJson) });
      } catch (e) {
        return setError(passkeyErrorMessage((e as { name?: string }).name));
      }
      if (!credential) return setError(passkeyErrorMessage(undefined));
      const done = await passkeyRegisterFinish(start.data.challengeId, credentialToJson(credential as unknown as Ceremony));
      if (!done.ok) return setError(done.error);
      remember(userId, "done");
      setShow(false);
      toast.success(done.message ?? "Done.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="passkey-offer-title" className="rounded-panel bg-card p-4 ring-1 ring-line" data-testid="passkey-offer">
      <div className="flex items-start gap-3">
        <Fingerprint className="mt-0.5 size-6 shrink-0 text-brand-fg" aria-hidden />
        <div className="min-w-0 space-y-2">
          <h2 id="passkey-offer-title" className="text-base font-semibold text-ink">Sign in with your face or fingerprint next time</h2>
          <p className="text-sm text-muted">Set it up once on this phone. Next time, tap &quot;Sign in with face or fingerprint&quot; instead of typing. Your face or fingerprint stays on your phone; Taviron never sees it.</p>
          {error ? <p role="alert" className="text-sm text-critical">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={setUp} loading={busy} className="min-h-12">Set it up</Button>
            <Button variant="ghost" className="min-h-12" onClick={() => { remember(userId, `later:${Date.now()}`); setShow(false); }}>Not now</Button>
          </div>
        </div>
      </div>
    </section>
  );
}
