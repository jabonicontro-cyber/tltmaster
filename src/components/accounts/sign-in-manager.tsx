"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { signInStatus } from "@/lib/accounts";
import {
  accountEvents, deactivateEmployeeSignIn, emailEmployeeSetup, reactivateEmployeeSignIn, recordInstructionsHandoff, reissueEmployeeSignIn,
} from "@/app/(app)/employees/account-actions";
import { CredentialDelivery, type DeliveryCredential } from "./credential-delivery";

export interface SignInState {
  userId: string;
  username: string;
  status: "setup_required" | "complete";
  expired: boolean;
  issuedAt: string;
  expiresAt: string;
  completedAt: string | null;
  lastSignInAt: string | null;
  banned: boolean;
  active: boolean;
}

const EVENT_LABELS: Record<string, string> = {
  "account.created": "Sign-in created",
  "account.setup_issued": "Setup instructions issued",
  "account.setup_reissued": "New temporary password issued",
  "account.setup_completed": "Set their own password (setup completed)",
  "account.delivery_accepted": "Setup email accepted by the email service",
  "account.delivery_failed": "Setup email failed",
  "account.delivery_prepared": "Instructions printed or copied",
  "account.deactivated": "Sign-in turned off",
  "account.reactivated": "Sign-in turned on",
  "account.sessions_blocked": "Signed out everywhere (blocked in Auth)",
  "account.sessions_unblocked": "Sign-in unblocked in Auth",
};

export function SignInManager({ s, personName, companyName, email }: {
  s: SignInState;
  personName: string;
  companyName: string;
  email: { available: boolean; reason?: string; to?: string };
}) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [credential, setCredential] = useState<DeliveryCredential | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [events, setEvents] = useState<Array<{ at: string; event: string }> | string | null>(null);
  const status = signInStatus(s);

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    startBusy(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message ?? "Saved.");
      else toast.error(r.error ?? "Not saved.");
      router.refresh();
    });

  if (credential) {
    return (
      <CredentialDelivery
        c={credential}
        email={email}
        onEmail={() => emailEmployeeSetup(s.userId)}
        onRecord={(channel) => recordInstructionsHandoff(s.userId, channel)}
        onDone={() => { setCredential(null); router.refresh(); }}
      />
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold text-ink">{s.username}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <dl className="grid gap-1 text-xs text-muted">
        <div>Last sign-in: <span className="text-ink">{s.lastSignInAt ? formatDateTime(s.lastSignInAt) : "Never"}</span></div>
        {s.status === "setup_required" ? <div>Temporary password {s.expired ? "expired" : "valid until"} <span className="text-ink">{formatDateTime(s.expiresAt)}</span></div> : null}
        {s.completedAt ? <div>Set their own password: <span className="text-ink">{formatDateTime(s.completedAt)}</span></div> : null}
      </dl>
      <div className="flex flex-wrap gap-2">
        {s.active ? (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => startBusy(async () => {
            const r = await reissueEmployeeSignIn(s.userId);
            if (!r.ok) { toast.error(r.error); return; }
            toast.success(r.message ?? "New temporary password issued.");
            setCredential({ kind: "employee", personName, companyName, username: r.data.username, loginUrl: r.data.loginUrl, temporaryPassword: r.data.temporaryPassword, expiresAt: r.data.expiresAt });
          })}>
            {s.status === "setup_required" ? "Reissue Sign-in Sheet" : "Reset Password"}
          </Button>
        ) : null}
        {s.active && email.available ? (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => emailEmployeeSetup(s.userId))}>Email Setup Link</Button>
        ) : null}
        {s.active ? (
          confirmOff ? (
            <span className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface p-2">
              <span className="text-xs text-ink">Turn off {personName}&apos;s sign-in? Their records and history are kept.</span>
              <Button size="sm" variant="danger" loading={busy} onClick={() => { setConfirmOff(false); run(() => deactivateEmployeeSignIn(s.userId)); }}>Turn Off</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmOff(false)}>Cancel</Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmOff(true)}>Turn Off Sign-in</Button>
          )
        ) : (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => reactivateEmployeeSignIn(s.userId))}>Turn On Sign-in</Button>
        )}
      </div>
      {!email.available && email.reason ? <p className="text-xs text-muted">Email: {email.reason}</p> : null}
      <details onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && events === null) void accountEvents(s.userId).then(setEvents); }}>
        <summary className="cursor-pointer text-xs font-semibold text-muted hover:text-ink">Security history</summary>
        {events === null ? <p className="mt-1 text-xs text-muted">Loading…</p> : typeof events === "string" ? (
          <p className="mt-1 text-xs text-critical">{events}</p>
        ) : events.length === 0 ? <p className="mt-1 text-xs text-muted">Nothing recorded yet.</p> : (
          <ol className="mt-1 space-y-0.5 text-xs">
            {events.map((e) => <li key={`${e.at}${e.event}`}><span className="text-muted">{formatDateTime(e.at)} · </span><span className="text-ink">{EVENT_LABELS[e.event] ?? e.event}</span></li>)}
          </ol>
        )}
      </details>
    </div>
  );
}
