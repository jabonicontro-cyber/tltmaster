"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, FormError, Input, Select } from "@/components/ui/form";
import { ACK_SCOPES, allowedPriorities, EDIT_WINDOW_MINUTES, RETENTION_DAYS, NOTIFICATION_CATEGORIES, PRIORITIES, type Priority } from "@/lib/communications";
import { formatDateTime } from "@/lib/dates";
import { ROLE_LABELS } from "@/lib/permissions";
import type { AlertType, CommSettings, Preferences } from "@/server/data/communications";
import { adminSearch, saveAlertSetting, savePreferences, saveSettings, type SearchHit } from "@/app/(app)/communications/actions";

const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];

export function PreferencesForm({ initial }: { initial: Preferences }) {
  const [p, setP] = useState(initial);
  const [quiet, setQuiet] = useState(Boolean(initial.quiet_start));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault();
      setPending(true); setError(null);
      const r = await savePreferences({ ...p, quiet_start: quiet ? p.quiet_start ?? "21:00" : null, quiet_end: quiet ? p.quiet_end ?? "06:00" : null });
      setPending(false);
      if (!r.ok) return setError(r.error);
      toast.success(r.message ?? "Saved.");
    }}>
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-ink">Notify me about</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(NOTIFICATION_CATEGORIES) as Array<keyof typeof NOTIFICATION_CATEGORIES>).map((k) => (
            <Checkbox key={k} label={NOTIFICATION_CATEGORIES[k]} checked={p[`notify_${k}`]} onChange={(e) => setP({ ...p, [`notify_${k}`]: e.target.checked })} />
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-semibold text-ink">Quiet hours</legend>
        <Checkbox label="Hold routine notifications during quiet hours (released afterwards; Critical alerts still notify)" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
        {quiet && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="From" htmlFor="q-start"><Input id="q-start" type="time" value={p.quiet_start ?? "21:00"} onChange={(e) => setP({ ...p, quiet_start: e.target.value })} /></Field>
            <Field label="Until" htmlFor="q-end"><Input id="q-end" type="time" value={p.quiet_end ?? "06:00"} onChange={(e) => setP({ ...p, quiet_end: e.target.value })} /></Field>
            <Field label="Time zone" htmlFor="q-tz">
              <Select id="q-tz" value={p.timezone} onChange={(e) => setP({ ...p, timezone: e.target.value })}>
                {[...new Set([p.timezone, ...TIMEZONES])].map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
              </Select>
            </Field>
          </div>
        )}
      </fieldset>
      <p className="text-xs text-muted">To mute one conversation, open it and choose Mute.</p>
      <FormError message={error} />
      <Button type="submit" loading={pending}>Save preferences</Button>
    </form>
  );
}

export function CompanySettingsForm({ initial }: { initial: CommSettings }) {
  const [s, setS] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const num = (k: keyof CommSettings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: e.target.value === "" ? null : Number(e.target.value) });
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault();
      setPending(true); setError(null);
      const r = await saveSettings(s);
      setPending(false);
      if (!r.ok) return setError(r.error);
      toast.success(r.message ?? "Saved.");
    }}>
      <p className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-muted">
        Fixed policies: authors can edit or delete a message for {EDIT_WINDOW_MINUTES} minutes after sending (later edits never extend it);
        managers can remove any message with a reason, which is recorded. Message content, including replies and files, is removed
        {" "}{RETENTION_DAYS} days after it was sent unless legal hold is on. Audit records are kept separately.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Away after (minutes)" htmlFor="cs-away" hint="Presence turns Away after this long without activity (an estimate).">
          <Input id="cs-away" type="number" min={5} max={240} value={s.away_after_minutes} onChange={num("away_after_minutes")} />
        </Field>
        <Field label="New members of groups see" htmlFor="cs-history">
          <Select id="cs-history" value={s.history_for_new_members} onChange={(e) => setS({ ...s, history_for_new_members: e.target.value as CommSettings["history_for_new_members"] })}>
            <option value="from_join">Messages from when they join</option>
            <option value="full">The full history</option>
          </Select>
        </Field>
        <Field label="Drivers on an active delivery" htmlFor="cs-delivery" hint="Critical alerts are never held back.">
          <Select id="cs-delivery" value={s.delivery_notifications} onChange={(e) => setS({ ...s, delivery_notifications: e.target.value as CommSettings["delivery_notifications"] })}>
            <option value="defer">Hold routine notifications; one catch-up notification afterwards</option>
            <option value="notice">Show the driving notice only; notify as usual</option>
          </Select>
        </Field>
        <Field label="Archive finished workspaces after (hours)" htmlFor="cs-archive">
          <Input id="cs-archive" type="number" min={0} max={720} value={s.workspace_archive_hours} onChange={num("workspace_archive_hours")} />
        </Field>
      </div>
      <div className="flex flex-col gap-2">
      <Checkbox label={`Members may delete their own messages (within ${EDIT_WINDOW_MINUTES} minutes of sending)`} checked={s.members_delete_own} onChange={(e) => setS({ ...s, members_delete_own: e.target.checked })} />
      <Checkbox label={`Legal hold: keep all message content past ${RETENTION_DAYS} days (nothing expires while this is on)`} checked={s.legal_hold} onChange={(e) => setS({ ...s, legal_hold: e.target.checked })} />
      </div>
      <FormError message={error} />
      <Button type="submit" loading={pending}>Save settings</Button>
    </form>
  );
}

type AlertRow = { type: AlertType; enabled: boolean; default_priority: Priority; ack_scope: "any" | "all"; escalation_minutes: number; escalation_roles: string[] };
const ESC_ROLES = ["owner", "office", "dispatcher", "mechanic"] as const;

function AlertSettingRow({ row }: { row: AlertRow }) {
  const [r, setR] = useState(row);
  const [pending, setPending] = useState(false);
  const safety = row.type.min_priority === "critical";
  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold text-ink">{r.type.label}</p>
        <p className="text-xs text-muted">Minimum: {PRIORITIES[r.type.min_priority]}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Default priority" htmlFor={`ap-${r.type.code}`}>
          <Select id={`ap-${r.type.code}`} value={r.default_priority} onChange={(e) => setR({ ...r, default_priority: e.target.value as Priority })}>
            {allowedPriorities(r.type.min_priority).map((p) => <option key={p} value={p}>{PRIORITIES[p]}</option>)}
          </Select>
        </Field>
        <Field label="Acknowledged by" htmlFor={`as-${r.type.code}`}>
          <Select id={`as-${r.type.code}`} value={r.ack_scope} onChange={(e) => setR({ ...r, ack_scope: e.target.value as "any" | "all" })}>
            {Object.entries(ACK_SCOPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Escalate Critical after (min)" htmlFor={`ae-${r.type.code}`}>
          <Input id={`ae-${r.type.code}`} type="number" min={5} max={10080} value={r.escalation_minutes} onChange={(e) => setR({ ...r, escalation_minutes: Number(e.target.value) })} />
        </Field>
        <fieldset>
          <legend className="text-sm font-semibold text-ink">Escalate to</legend>
          <div className="mt-1 flex flex-wrap gap-x-3">
            {ESC_ROLES.map((role) => (
              <Checkbox key={role} label={ROLE_LABELS[role].split(" /")[0]} checked={r.escalation_roles.includes(role)}
                onChange={(e) => setR({ ...r, escalation_roles: e.target.checked ? [...r.escalation_roles, role] : r.escalation_roles.filter((x) => x !== role) })} />
            ))}
          </div>
        </fieldset>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Checkbox label={safety ? "On (safety alert — cannot be turned off)" : "On"} checked={r.enabled || safety} disabled={safety} onChange={(e) => setR({ ...r, enabled: e.target.checked })} />
        <Button size="sm" variant="secondary" loading={pending} onClick={async () => {
          setPending(true);
          const res = await saveAlertSetting({ type: r.type.code, enabled: r.enabled || safety, default_priority: r.default_priority, ack_scope: r.ack_scope, escalation_minutes: r.escalation_minutes, escalation_roles: r.escalation_roles });
          setPending(false);
          if (!res.ok) return toast.error(res.error);
          toast.success(res.message ?? "Saved.");
        }}>Save</Button>
      </div>
    </li>
  );
}

export function AlertSettingsList({ rows }: { rows: AlertRow[] }) {
  return <ul className="divide-y divide-line">{rows.map((r) => <AlertSettingRow key={r.type.code} row={r} />)}</ul>;
}

export function AdminSearch() {
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="space-y-3">
      <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={async (e) => {
        e.preventDefault();
        setPending(true); setError(null);
        const r = await adminSearch({ query, reason });
        setPending(false);
        if (!r.ok) { setHits(null); return setError(r.error); }
        setHits(r.data);
        if (r.message) toast.message(r.message);
      }}>
        <Field label="Search all conversations" htmlFor="as-q"><Input id="as-q" value={query} maxLength={200} onChange={(e) => setQuery(e.target.value)} /></Field>
        <Field label="Reason (recorded)" htmlFor="as-reason"><Input id="as-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
        <Button type="submit" variant="secondary" loading={pending}>Search</Button>
      </form>
      <FormError message={error} />
      {hits && (hits.length === 0 ? <p className="text-sm text-muted">Nothing found.</p> : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {hits.map((h) => (
            <li key={h.id} className="px-3 py-2 text-sm">
              <p className="text-ink">{h.body}</p>
              <p className="text-xs text-muted">{h.author} · {formatDateTime(h.created_at)} · <Link className="hover:underline" href={`/communications/c/${h.conversation_id}`}>Open (only if you are a member)</Link></p>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}
