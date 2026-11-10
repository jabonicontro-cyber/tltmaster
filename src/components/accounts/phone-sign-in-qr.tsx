"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, QrCode as QrIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { toastActionError } from "@/lib/toast-result";
import { QR_MINUTES, qrStatusLabel } from "@/lib/signin-qr";
import {
  cancelDriverSignInQr, driverSignInQrStatus, removeDriverPasskeys, showDriverSignInQr,
} from "@/app/(app)/fleet/drivers/phone-sign-in-actions";
import { QrCode } from "./qr-code";

type Code = { id: string; url: string; expiresAt: string };

/** What the sample code in a demo company holds: plain text, never a link that signs anything in. */
const DEMO_SAMPLE = "Taviron demo: sample sign-in code. Demo companies never sign a phone in.";

function useCountdown(until: string | null): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!until) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000)));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [until]);
  return left;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Fleet → driver: show a one-time QR code that signs the driver's phone in (master plan DS1), and remove face or
 * fingerprint sign-in for a lost phone. In a demo company the code is a labelled sample that signs nothing in.
 */
export function PhoneSignInQr({ driverId, userId, driverName, demo, passkeys, supportVisit = false }: {
  driverId: string;
  userId: string | null;
  driverName: string;
  demo: boolean;
  /** A Taviron support visit: no code can be shown (the server and the database refuse it too). */
  supportVisit?: boolean;
  /** null: face or fingerprint sign-in is not offered on this site (nothing shown). */
  passkeys: { count: number | null } | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<Code | null>(null);
  const [status, setStatus] = useState("waiting");
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const left = useCountdown(code?.expiresAt ?? null);
  const state = qrStatusLabel(status);
  const expired = Boolean(code) && left === 0 && status === "waiting";

  const show = useCallback(() => {
    setOpen(true);
    setError(null);
    setStatus("waiting");
    if (demo) return;
    startBusy(async () => {
      const r = await showDriverSignInQr(driverId);
      if (!r.ok) {
        setCode(null);
        setError(r.error);
        return;
      }
      setCode({ id: r.data.id, url: r.data.url, expiresAt: r.data.expiresAt });
    });
  }, [demo, driverId]);

  // While the window is open and the code waits, ask every 3 seconds whether the phone used it.
  useEffect(() => {
    if (!open || !code || status !== "waiting") return;
    const t = window.setInterval(async () => {
      const s = await driverSignInQrStatus(code.id);
      if (s !== "unknown") setStatus(s);
    }, 3000);
    return () => window.clearInterval(t);
  }, [open, code, status]);

  const close = (next: boolean) => {
    if (next) return setOpen(true);
    setOpen(false);
    // Closing the window stops a code that was not used: nobody can scan it from a photo later.
    if (code && status === "waiting") void cancelDriverSignInQr(code.id);
    if (status === "used") router.refresh();
    setCode(null);
  };

  return (
    <div className="space-y-3">
      {supportVisit && !demo ? (
        <p className="text-sm text-muted" data-testid="qr-support-visit">
          During a Taviron support visit no sign-in QR code can be shown: only the company&apos;s own people hand out a way in. Someone in the company who manages sign-ins can show it.
        </p>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">
            No typing for the driver: they point their phone&apos;s camera at a code on this screen and are signed in on that phone. The code works once, for {QR_MINUTES} minutes.
          </p>
          <Button icon={<QrIcon className="size-4" />} onClick={show} loading={busy && !open} className="h-12 shrink-0 sm:h-10" data-testid="show-sign-in-qr">
            Show sign-in QR code
          </Button>
        </div>
      )}
      {passkeys && userId && !demo ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted" data-testid="passkey-summary">
            Face or fingerprint sign-in:{" "}
            <span className="text-ink">
              {passkeys.count === null ? "could not be checked" : passkeys.count === 0 ? "not set up yet (offered on their phone after they sign in)" : `set up on ${passkeys.count === 1 ? "1 phone" : `${passkeys.count} phones`}`}
            </span>
          </p>
          {passkeys.count ? (
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>Remove (lost or new phone)</Button>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={open}
        onOpenChange={close}
        size="sm"
        title={`Sign ${driverName} in on their phone`}
        description={demo ? "Demo: a sample code. Nothing signs in." : "Only show this code to the driver. Anyone who scans it is signed in as them."}
        footer={<Button variant="secondary" onClick={() => close(false)}>{status === "used" ? "Done" : "Close"}</Button>}
      >
        {demo ? (
          <div className="space-y-3 text-center" data-testid="qr-demo">
            <div className="flex justify-center"><QrCode value={DEMO_SAMPLE} label="Sample sign-in QR code (demo)" testId="sign-in-qr" /></div>
            <p className="rounded-xl bg-surface px-3 py-2 text-sm text-ink ring-1 ring-line">
              <strong className="font-semibold">Demo:</strong> this sample code signs nothing in. In your own company, the code signs the driver&apos;s phone in once and stops working after {QR_MINUTES} minutes; this window then says when the phone is signed in.
            </p>
          </div>
        ) : error ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-critical">{error}</p>
            <Button variant="secondary" onClick={show} loading={busy}>Try again</Button>
          </div>
        ) : !code ? (
          <p className="text-sm text-muted" role="status">Making a code…</p>
        ) : state.done && status === "used" ? (
          <p className="flex items-center gap-2 py-6 text-base font-semibold text-ink" role="status" data-testid="qr-status">
            <CheckCircle2 className="size-6 text-green-700" aria-hidden /> {state.text}
          </p>
        ) : (
          <div className="space-y-3">
            {expired || state.done ? (
              <div className="space-y-3" role="status" data-testid="qr-status">
                <p className="text-sm text-ink">{expired ? qrStatusLabel("expired").text : state.text}</p>
                <Button onClick={show} loading={busy}>Show a new code</Button>
              </div>
            ) : (
              <>
                <div className="flex justify-center"><QrCode value={code.url} label={`Sign-in QR code for ${driverName}`} testId="sign-in-qr" /></div>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-ink">
                  <li>On the driver&apos;s phone, open the camera and point it at this code.</li>
                  <li>Tap the link that appears. The phone opens My Day, signed in.</li>
                </ol>
                <p className="text-sm text-muted" role="status" data-testid="qr-status">
                  {state.text} Works once, for <span className="tabular font-semibold text-ink">{mmss(left)}</span> more.
                </p>
              </>
            )}
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${driverName}'s face or fingerprint sign-in?`}
        description="Use this when a phone is lost or replaced. Every phone set up with it stops signing in that way. Their username and password still work, and you can show a new QR code."
        confirmLabel="Remove"
        tone="danger"
        onConfirm={async () => {
          if (!userId) return "Sign-in not found.";
          const r = await removeDriverPasskeys(userId);
          if (!r.ok) {
            toastActionError(r.error);
            return r.error;
          }
          toast.success(r.message ?? "Removed.");
          router.refresh();
        }}
      />
    </div>
  );
}
