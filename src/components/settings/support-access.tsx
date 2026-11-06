"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { formatDateTime } from "@/lib/dates";
import { endSupportAccess, grantSupportAccess } from "@/app/(app)/settings/support-actions";

export interface SupportStatus {
  needs_grant: boolean;
  grant: { days: number; starts_at: string; ends_at: string; granted_by: string } | null;
  inside: Array<{ name: string; started_at: string; ends_at: string }>;
  visits: Array<{ name: string; reason: string; started_at: string; ended_at: string | null; end_reason: string }>;
  grants: Array<{ days: number; starts_at: string; ends_at: string; ended_at: string | null; granted_by: string; ended_by: string | null }>;
}

const END_REASON: Record<string, string> = { left: "left", switched: "left", access_ended: "access ended", staff_removed: "access ended", "": "access ended" };
const CHOICES = [1, 3, 7] as const;

/**
 * Taviron support access (SA1): the owner lets the Taviron team into the company for 1, 3 (default) or 7 days, sees who
 * is inside and ends it at any time. While the company is still being set up, Taviron can help without it.
 */
export function SupportAccess({ status, timezone, canChange, companyName }: { status: SupportStatus; timezone: string; canChange: boolean; companyName: string }) {
  const router = useRouter();
  const [days, setDays] = useState<number>(3);
  const done = (r: { message?: string }) => { toast.success(r.message ?? "Saved."); router.refresh(); };
  const grant = useFormAction(grantSupportAccess, { onSuccess: done });
  const end = useFormAction(async () => endSupportAccess(), { onSuccess: done });
  const g = status.grant;
  return (
    <div className="space-y-6">
      {!status.needs_grant && (
        <p className="rounded-xl bg-surface px-4 py-3 text-sm text-ink">
          While {companyName} is being set up, the Taviron team can come in to help without asking. Once you are live, they need your permission here.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">Taviron support</span>
        {g ? <Badge tone="green">Allowed until {formatDateTime(g.ends_at, timezone)}</Badge> : <Badge tone="gray">{status.needs_grant ? "Not allowed" : "Open during setup"}</Badge>}
        {status.inside.length > 0 && <Badge tone="blue">In your account now: {status.inside.map((i) => i.name).join(", ")}</Badge>}
      </div>

      {canChange ? (
        <div className="space-y-3">
          <form onSubmit={grant.onSubmit} className="space-y-3" aria-label="Give Taviron support access">
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-ink">{g ? "Change how long they can come in (counted from now)" : "How long can they come in?"}</legend>
              <div className="flex flex-wrap gap-2">
                {CHOICES.map((d) => (
                  <label key={d} className="flex cursor-pointer items-center gap-2 rounded-control border border-line px-3 py-2 text-sm has-[:checked]:border-strong has-[:checked]:bg-surface">
                    <input type="radio" name="days" value={d} checked={days === d} onChange={() => setDays(d)} />
                    {d} {d === 1 ? "day" : "days"}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="text-sm text-muted">They can see and change everything an owner can. It ends by itself; every visit is listed below and every change they make shows as &quot;Name (Taviron support)&quot;.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" loading={grant.pending}>{g ? "Save" : "Give access"}</Button>
              {g && (
                <Button type="submit" form="end-support-access" variant="secondary" loading={end.pending} className="text-critical">End access now</Button>
              )}
            </div>
          </form>
          {g && (
            <form id="end-support-access" onSubmit={(e) => { if (!window.confirm("End Taviron support access now? Anyone from Taviron in your account is signed out of it at once.")) { e.preventDefault(); return; } end.onSubmit(e); }} />
          )}
          <FormError message={grant.formError ?? end.formError} />
        </div>
      ) : (
        <p className="text-sm text-muted">Only the company&apos;s owners can give or end this access.</p>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink">Visits</h3>
        {status.visits.length === 0 ? (
          <p className="text-sm text-muted">Nobody from Taviron has come in yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm" aria-label="Taviron support visits">
            {status.visits.map((v, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span><span className="font-medium">{v.name}</span>{v.reason ? <span className="text-muted">: {v.reason}</span> : null}</span>
                <span className="text-xs text-muted">{formatDateTime(v.started_at, timezone)}{v.ended_at ? ` to ${formatDateTime(v.ended_at, timezone)} (${END_REASON[v.end_reason] ?? "ended"})` : " (in your account now)"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {status.grants.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">Access given</h3>
          <ul className="divide-y divide-line text-sm" aria-label="Taviron support access given">
            {status.grants.map((a, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span>{a.days} {a.days === 1 ? "day" : "days"}, by {a.granted_by}</span>
                <span className="text-xs text-muted">{formatDateTime(a.starts_at, timezone)} to {formatDateTime(a.ended_at ?? a.ends_at, timezone)}{a.ended_at && a.ended_by ? `, ended by ${a.ended_by}` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
