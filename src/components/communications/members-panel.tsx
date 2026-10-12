"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bell, BellOff, UserMinus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select } from "@/components/ui/form";
import { isMuted, muteLabel, MUTE_CHOICES } from "@/lib/communications";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import type { Person } from "@/server/data/communications";
import { addMembers, mute, removeMember, setMemberRole, setTitle } from "@/app/(app)/communications/actions";
import { PeoplePicker } from "./people-picker";
import { PresenceDot, WorkStatusBadge } from "./status";

export interface PanelMember {
  user_id: string;
  name: string;
  role: "member" | "manager";
  source: "manual" | "dispatch" | "creator";
  person: Person | null;
}

export function MembersPanel(props: {
  conversationId: string;
  kind: "direct" | "group" | "channel" | "operation";
  active: boolean;
  me: string;
  isMember: boolean;
  members: PanelMember[];
  people: Person[];
  canManage: boolean;
  canAdd: boolean;
  myMutedUntil: string | null;
  title: string;
  titleCustom: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [share, setShare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<PanelMember | null>(null);
  const [reason, setReason] = useState("");
  const [name, setName] = useState(props.titleCustom ? props.title : "");
  const muted = isMuted(props.myMutedUntil);

  async function run(p: Promise<{ ok: boolean; error?: string; message?: string }>) {
    const r = await p;
    if (!r.ok) { toast.error(r.error ?? "Could not save."); return false; }
    if (r.message) toast.success(r.message);
    router.refresh();
    return true;
  }

  return (
    <div className="space-y-4">
      {props.isMember && (
        <div className="space-y-1">
          <p className="text-xs font-bold tracking-wide text-muted uppercase">Notifications</p>
          {muted ? (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 text-muted"><BellOff className="size-4" aria-hidden />{muteLabel(props.myMutedUntil, new Date(), DEFAULT_TIMEZONE)}</span>
              <Button size="sm" variant="secondary" icon={<Bell className="size-4" />} onClick={() => run(mute({ conversationId: props.conversationId, minutes: 0 }))}>Unmute</Button>
            </div>
          ) : (
            <Select aria-label="Mute this conversation" className="h-9" value="" onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              void run(mute({ conversationId: props.conversationId, minutes: v === "forever" ? null : Number(v) }));
            }}>
              <option value="">Mute this conversation…</option>
              {MUTE_CHOICES.map((c) => <option key={c.label} value={c.minutes ?? "forever"}>{c.label}</option>)}
            </Select>
          )}
          <p className="text-xs text-muted">Muting stops notifications only. Critical alerts are never muted.</p>
        </div>
      )}

      {props.canManage && props.kind !== "direct" && props.kind !== "operation" && (
        <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); void run(setTitle({ conversationId: props.conversationId, title: name })); }}>
          <Field label="Name" htmlFor="conv-name" hint={props.kind === "group" ? "Leave empty to name the group after its members." : undefined}>
            <div className="flex gap-2">
              <Input id="conv-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
              <Button type="submit" size="sm" variant="secondary" className="h-10">Save</Button>
            </div>
          </Field>
        </form>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs font-bold tracking-wide text-muted uppercase">Members ({props.members.length})</p>
          {props.canAdd && props.active && props.kind !== "direct" && (
            <Button size="sm" variant="ghost" icon={<UserPlus className="size-4" />} onClick={() => { setAdding(true); setChosen([]); setShare(false); setError(null); }}>Add</Button>
          )}
        </div>
        <ul className="divide-y divide-line">
          {props.members.map((m) => (
            <li key={m.user_id} className="flex items-center gap-2 py-2 text-sm">
              <PresenceDot presence={m.person?.presence ?? null} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{m.user_id === props.me ? `${m.name} (you)` : m.name}</span>
                <span className="flex flex-wrap items-center gap-1">
                  {m.role === "manager" && <Badge tone="gray">Manager</Badge>}
                  {m.source === "dispatch" && <Badge tone="blue">From dispatch</Badge>}
                  {m.person && <WorkStatusBadge status={m.person.work_status} />}
                </span>
              </span>
              {props.canManage && props.kind === "group" && m.user_id !== props.me && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => run(setMemberRole({ conversationId: props.conversationId, userId: m.user_id, role: m.role === "manager" ? "member" : "manager" }))}>
                  {m.role === "manager" ? "Make member" : "Make manager"}
                </Button>
              )}
              {props.canManage && props.kind !== "direct" && m.user_id !== props.me && m.source !== "dispatch" && (
                <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={`Remove ${m.name}`} icon={<UserMinus className="size-4" />} onClick={() => { setRemoving(m); setReason(""); }} />
              )}
            </li>
          ))}
        </ul>
        {props.kind === "operation" && <p className="mt-1 text-xs text-muted">Drivers are added and removed automatically from dispatch assignments.</p>}
      </div>

      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title="Add people"
        description="New members see messages from when they join unless earlier history is shared."
        footer={<>
          <Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
          <Button loading={pending} disabled={chosen.length === 0} onClick={async () => {
            setPending(true); setError(null);
            const r = await addMembers({ conversationId: props.conversationId, members: chosen, shareHistory: share });
            setPending(false);
            if (!r.ok) return setError(r.error);
            toast.success(r.message ?? "Added.");
            setAdding(false);
            router.refresh();
          }}>Add</Button>
        </>}
      >
        <div className="space-y-3">
          <PeoplePicker people={props.people} selected={chosen} onChange={setChosen} exclude={props.members.map((m) => m.user_id)} />
          {props.canManage && <Checkbox label="Share earlier messages with them" checked={share} onChange={(e) => setShare(e.target.checked)} />}
          <FormError message={error} />
        </div>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? ""}?`}
        description="They keep the messages up to now and receive nothing new."
        confirmLabel="Remove"
        tone="danger"
        onConfirm={async () => {
          if (!removing) return;
          const r = await removeMember({ conversationId: props.conversationId, userId: removing.user_id, reason });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Removed.");
          setRemoving(null);
          router.refresh();
        }}
      >
        <Field label="Reason (optional)" htmlFor="rm-reason">
          <Input id="rm-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
