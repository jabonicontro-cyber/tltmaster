"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Copy, Eye, EyeOff, Mail, Printer, X } from "lucide-react";
import { toast } from "sonner";
import { BrandMark } from "@/components/layout/brand";
import { Button } from "@/components/ui/button";
import { instructionsText } from "@/lib/accounts";
import type { ActionResult } from "@/lib/action-result";
import { formatDateTime } from "@/lib/dates";

export interface DeliveryCredential {
  kind: "employee" | "portal";
  personName: string;
  companyName: string;
  username: string;
  loginUrl: string;
  /** In memory only, for this administrator, until they close the panel. */
  temporaryPassword: string;
  expiresAt: string;
}

const REVEAL_SECONDS = 60;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / denied permission: a hidden text area and the copy command.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const okCopy = document.execCommand("copy");
      area.remove();
      return okCopy;
    } catch {
      return false;
    }
  }
}

/** The one-page sheet an administrator prints and hands over (always light, letter size). */
export function LoginSheet({ c, includePassword }: { c: DeliveryCredential; includePassword: boolean }) {
  return (
    <article className="force-light mx-auto max-w-[7.5in] bg-white p-8 text-[#0f172a]" aria-label="Sign-in sheet">
      <header className="flex items-center justify-between border-b border-[#cbd5e1] pb-4">
        <BrandMark tone="dark" />
        <span className="text-right text-sm font-semibold">{c.companyName}</span>
      </header>
      <h1 className="mt-6 text-2xl font-bold">Your {c.kind === "portal" ? "customer portal" : "Taviron"} sign-in</h1>
      <p className="mt-1 text-base">For <strong>{c.personName}</strong></p>
      <dl className="mt-6 grid gap-3 rounded-2xl border-2 border-[#0f172a] p-5 text-lg">
        <div><dt className="text-sm font-semibold uppercase tracking-wide text-[#475569]">Website</dt><dd className="font-mono font-semibold break-all">{c.loginUrl}</dd></div>
        <div><dt className="text-sm font-semibold uppercase tracking-wide text-[#475569]">Username</dt><dd className="font-mono text-2xl font-bold">{c.username}</dd></div>
        <div>
          <dt className="text-sm font-semibold uppercase tracking-wide text-[#475569]">Temporary password</dt>
          <dd className="font-mono text-2xl font-bold">{includePassword ? c.temporaryPassword : "Given to you separately"}</dd>
        </div>
      </dl>
      <h2 className="mt-6 text-lg font-bold">How to sign in the first time</h2>
      <ol className="mt-2 list-decimal space-y-2 pl-6 text-base">
        <li>On your phone or computer, open the website above.</li>
        <li>Type your username and the temporary password exactly as shown (capital letters count).</li>
        <li>Taviron asks you to <strong>create your own password</strong>. Choose one only you know, at least 10 characters.</li>
        <li>Next time, sign in with your username and your own password.</li>
      </ol>
      <h2 className="mt-6 text-lg font-bold">If something goes wrong</h2>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-base">
        <li>The temporary password stops working on <strong>{formatDateTime(c.expiresAt)}</strong>. After that, ask {c.companyName} for a new sheet.</li>
        <li>Forgot your password later? Ask {c.companyName} for a new sheet — nobody there can see your password.</li>
        <li>On a shared computer, tick &ldquo;This is a shared computer&rdquo; when you sign in, and sign out when you are done.</li>
      </ul>
      <p className="mt-6 rounded-xl bg-[#f1f5f9] p-3 text-sm">
        Keep this sheet private and do not share your sign-in. Once you have created your own password, this temporary password no longer works.
      </p>
    </article>
  );
}

/**
 * After a sign-in is created or reissued: reveal (briefly), print, copy or email. The temporary password is held only
 * in this component's memory; closing the panel forgets it. Printing or closing does not revoke anything — use
 * Reissue to replace a credential.
 */
export function CredentialDelivery({ c, email, onEmail, onRecord, onDone }: {
  c: DeliveryCredential;
  email: { available: boolean; reason?: string; to?: string };
  onEmail?: () => Promise<ActionResult<unknown>>;
  onRecord?: (channel: "print" | "copy") => Promise<void>;
  onDone: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [withPassword, setWithPassword] = useState(true);
  const [confirmCopy, setConfirmCopy] = useState(false);
  const [emailState, setEmailState] = useState<{ busy: boolean; message?: string; ok?: boolean }>({ busy: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!printing) return;
    const after = () => { document.body.classList.remove("print-login-sheet"); };
    window.addEventListener("afterprint", after);
    return () => { window.removeEventListener("afterprint", after); document.body.classList.remove("print-login-sheet"); };
  }, [printing]);

  const reveal = () => {
    setRevealed(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setRevealed(false), REVEAL_SECONDS * 1000);
  };
  const expiresLabel = `on ${formatDateTime(c.expiresAt)}`;

  async function copy(includePassword: boolean) {
    const text = instructionsText({ ...c, temporaryPassword: includePassword ? c.temporaryPassword : undefined }, expiresLabel);
    const done = await copyText(text);
    if (done) {
      toast.success(includePassword ? "Copied, including the temporary password. Share it only with this person." : "Instructions copied (without the password).");
      void onRecord?.("copy");
    } else toast.error("Copying is blocked in this browser. Select the text on the printed sheet instead.");
    setConfirmCopy(false);
  }

  async function sendEmail() {
    if (!onEmail) return;
    setEmailState({ busy: true });
    const r = await onEmail();
    setEmailState({ busy: false, ok: r.ok, message: r.ok ? r.message : r.error });
  }

  return (
    <section aria-label="Sign-in instructions" className="space-y-4 rounded-panel border border-line/70 bg-card shadow-card p-4 sm:p-5">
      <div>
        <h2 className="text-base font-bold text-ink">Sign-in ready for {c.personName}</h2>
        <p className="mt-1 text-sm text-muted">Hand it over one of these ways. The temporary password works until {formatDateTime(c.expiresAt)} and must be replaced at first sign-in.</p>
      </div>
      <dl className="grid gap-2 rounded-xl bg-surface p-3 text-sm sm:grid-cols-3">
        <div><dt className="text-muted">Username</dt><dd className="font-mono text-base font-semibold text-ink">{c.username}</dd></div>
        <div className="sm:col-span-2">
          <dt className="text-muted">Temporary password</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base font-semibold text-ink" aria-live="polite">{revealed ? c.temporaryPassword : "•••• •••• ••••"}</span>
            <Button size="sm" variant="ghost" onClick={() => (revealed ? setRevealed(false) : reveal())} icon={revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}>
              {revealed ? "Hide" : "Show"}
            </Button>
          </dd>
        </div>
      </dl>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-line p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><Printer className="size-4" aria-hidden /> Print a sheet</h3>
          <p className="mt-1 text-xs text-muted">One page with the website, username, temporary password and simple steps.</p>
          <Button size="sm" className="mt-2" onClick={() => { setPrinting(true); void onRecord?.("print"); }}>Print Sign-in Sheet</Button>
        </div>
        <div className="rounded-xl border border-line p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><Copy className="size-4" aria-hidden /> Copy instructions</h3>
          <p className="mt-1 text-xs text-muted">To paste into a message you already use with this person.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void copy(false)}>Copy Without Password</Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirmCopy(true)}>Copy With Password…</Button>
          </div>
          {confirmCopy ? (
            <div role="alertdialog" aria-label="Copy the temporary password?" className="mt-2 rounded-xl border border-line bg-surface p-2 text-xs text-ink">
              <p className="flex gap-1.5"><AlertTriangle className="size-4 shrink-0 text-amber-600" aria-hidden /> The copied text contains the temporary password. Paste it only into a private message to {c.personName}.</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => void copy(true)}>Copy It</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmCopy(false)}>Cancel</Button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="rounded-xl border border-line p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><Mail className="size-4" aria-hidden /> Email a setup link</h3>
          {email.available ? (
            <>
              <p className="mt-1 text-xs text-muted">Sends {email.to} a one-time link to create their password (no password in the email). The printed temporary password then stops working.</p>
              <Button size="sm" variant="secondary" className="mt-2" loading={emailState.busy} onClick={() => void sendEmail()}>Send Setup Link</Button>
            </>
          ) : (
            <p className="mt-1 text-xs text-muted">{email.reason ?? "Email is not available."}</p>
          )}
          {emailState.message ? <p role="status" className={`mt-2 text-xs ${emailState.ok ? "text-ink" : "text-critical"}`}>{emailState.message}</p> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <p className="text-xs text-muted">Closing this panel forgets the temporary password here. It does not cancel it — use Reissue to replace it.</p>
        <Button variant="secondary" onClick={onDone}>Done</Button>
      </div>

      {printing
        ? createPortal(
            <div id="login-sheet-root" className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 p-4">
              <div className="no-print mx-auto mb-3 flex max-w-[7.5in] flex-wrap items-center justify-between gap-2 rounded-xl bg-card p-3">
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={withPassword} onChange={(e) => setWithPassword(e.target.checked)} className="size-4 rounded border-line accent-brand" />
                  Print the temporary password on the sheet
                </label>
                <div className="flex gap-2">
                  <Button size="sm" icon={<Printer className="size-4" />} onClick={() => { document.body.classList.add("print-login-sheet"); window.print(); }}>Print</Button>
                  <Button size="sm" variant="secondary" icon={<X className="size-4" />} onClick={() => setPrinting(false)}>Close</Button>
                </div>
              </div>
              <LoginSheet c={c} includePassword={withPassword} />
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
