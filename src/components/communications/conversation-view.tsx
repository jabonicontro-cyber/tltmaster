"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCheck, ChevronDown, ChevronRight, CornerDownRight, FileText, Paperclip, Pencil, Pin, PinOff, Reply, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Textarea } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { EDIT_WINDOW_MINUTES, formatBytes, MAX_ATTACHMENTS_PER_MESSAGE, RETENTION_DAYS } from "@/lib/communications";
import { formatDateTime } from "@/lib/dates";
import type { Message } from "@/server/data/communications";
import { deleteMessage, discardAttachment, editMessage, markRead, pinMessage, sendMessage } from "@/app/(app)/communications/actions";

type Receipt = { recipients: number; delivered: number; read: number };
type Pending = { key: string; name: string; size: number; status: "uploading" | "ready" | "failed"; id?: string; error?: string };

function newKey() {
  return crypto.randomUUID();
}

function within(iso: string, minutes: number) {
  return Date.now() - new Date(iso).getTime() <= minutes * 60_000;
}

function ReceiptLine({ r }: { r: Receipt | undefined }) {
  if (!r || r.recipients === 0) return null;
  const text = r.read === r.recipients ? (r.recipients === 1 ? "Read" : "Read by everyone")
    : r.read > 0 ? `Read by ${r.read} of ${r.recipients}`
    : r.delivered > 0 ? (r.recipients === 1 ? "Delivered" : `Delivered to ${r.delivered} of ${r.recipients}`) : "Sent";
  return <span className="inline-flex items-center gap-1 text-xs text-muted"><CheckCheck className="size-3.5" aria-hidden />{text}</span>;
}

export function ConversationView(props: {
  conversationId: string;
  me: string;
  messages: Message[];
  names: Record<string, string>;
  /** Each person's picture: own profile photo, else employee avatar (see personPhoto). */
  photos: Record<string, { src: string; fallbackSrc: string }>;
  receipts: Record<string, Receipt>;
  membersDeleteOwn: boolean;
  /** Older messages exist beyond the `shown` newest ones. */
  hasEarlier: boolean;
  shown: number;
  isAdmin: boolean;
  canManage: boolean;
  canPost: boolean;
  postBlockedReason: string | null;
}) {
  const { conversationId, me, names, receipts } = props;
  const router = useRouter();
  // What this person just sent, shown at once and until the refreshed server list contains it (never depends on the
  // refresh arriving, e.g. in a long conversation).
  const [sentHere, setSentHere] = useState<Message[]>([]);
  const messages = useMemo(() => {
    const pending = sentHere.filter((m) => !props.messages.some((x) => x.id === m.id));
    return pending.length ? [...props.messages, ...pending] : props.messages;
  }, [props.messages, sentHere]);
  const list = useRef<HTMLOListElement>(null);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [clientKey, setClientKey] = useState(newKey);
  const [files, setFiles] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; manager: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);

  const top = useMemo(() => messages.filter((m) => !m.reply_to_id || !messages.some((p) => p.id === m.reply_to_id)), [messages]);
  const replies = useMemo(() => {
    const map = new Map<string, Message[]>();
    for (const m of messages) if (m.reply_to_id && messages.some((p) => p.id === m.reply_to_id)) map.set(m.reply_to_id, [...(map.get(m.reply_to_id) ?? []), m]);
    return map;
  }, [messages]);
  const pinned = messages.filter((m) => m.pinned && !m.deleted_at && !m.expired_at);
  const lastId = messages.at(-1)?.id;

  // Reading the conversation marks it read (also after each refresh that brings new messages).
  useEffect(() => {
    void markRead(conversationId);
    if (list.current) list.current.scrollTop = list.current.scrollHeight; // scroll the list only, never the page
  }, [conversationId, lastId]);

  const name = (id: string | null) => (id ? names[id] ?? "Former member" : "Taviron");

  async function upload(list: FileList | null) {
    if (!list) return;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - files.length;
    const chosen = Array.from(list).slice(0, Math.max(room, 0));
    if (list.length > chosen.length) toast.error(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
    for (const file of chosen) {
      const key = newKey();
      setFiles((f) => [...f, { key, name: file.name, size: file.size, status: "uploading" }]);
      const form = new FormData();
      form.set("file", file);
      form.set("conversation_id", conversationId);
      form.set("upload_key", key);
      try {
        const res = await fetch("/communications/files", { method: "POST", body: form });
        const json = (await res.json()) as { attachmentId?: string; error?: string };
        setFiles((f) => f.map((x) => (x.key === key ? (res.ok && json.attachmentId ? { ...x, status: "ready", id: json.attachmentId } : { ...x, status: "failed", error: json.error ?? "Upload failed." }) : x)));
      } catch {
        setFiles((f) => f.map((x) => (x.key === key ? { ...x, status: "failed", error: "Upload failed. Check your connection." } : x)));
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  async function removeFile(p: Pending) {
    setFiles((f) => f.filter((x) => x.key !== p.key));
    if (p.id) await discardAttachment(p.id);
  }

  async function send() {
    if (sending) return;
    if (files.some((f) => f.status === "uploading")) return setError("Wait for the files to finish uploading.");
    if (files.some((f) => f.status === "failed")) return setError("A file did not upload. Remove it, or attach it again.");
    const ready = files.filter((f) => f.status === "ready" && f.id).map((f) => f.id as string);
    if (!body.trim() && ready.length === 0) return;
    setSending(true);
    setError(null);
    const r = await sendMessage({ conversationId, body, replyTo: replyTo?.id ?? null, clientKey, attachments: ready });
    setSending(false);
    if (!r.ok) return setError(r.error);
    const attached = files.filter((f) => f.status === "ready" && f.id).map((f) => ({ id: f.id as string, message_id: r.data.id, file_name: f.name, mime_type: "", size_bytes: f.size }));
    setSentHere((s) => [...s, {
      id: r.data.id, author_id: me, kind: "text", body: body.trim(), reply_to_id: replyTo?.id ?? null, pinned: false,
      created_at: new Date().toISOString(), edited_at: null, deleted_at: null, attachments: attached,
    } as Message]);
    setBody("");
    setReplyTo(null);
    setFiles([]);
    setClientKey(newKey());
    router.refresh();
  }

  function renderMessage(m: Message, nested = false) {
    const mine = m.author_id === me;
    if (m.kind === "system") {
      return <li key={m.id} id={`m-${m.id}`} className="py-1 text-center text-xs text-muted">{m.body} · {formatDateTime(m.created_at)}</li>;
    }
    const gone = Boolean(m.deleted_at || m.expired_at);
    const ownWindow = mine && within(m.created_at, EDIT_WINDOW_MINUTES);
    const canEdit = ownWindow && !gone;
    const ownDelete = ownWindow && props.membersDeleteOwn;
    const canDelete = !gone && (ownDelete || props.isAdmin);
    const orphan = m.reply_to_id && !messages.some((p) => p.id === m.reply_to_id);
    return (
      <li key={m.id} id={`m-${m.id}`} className={cn("group flex gap-3 py-2", nested && "ml-10")}>
        <Avatar name={name(m.author_id)} size={nested ? 28 : 34} {...(m.author_id ? props.photos[m.author_id] : {})} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-ink">{mine ? "You" : name(m.author_id)}</span>
            <span className="text-xs text-muted">{formatDateTime(m.created_at)}</span>
            {m.edited_at && !gone && <span className="text-xs text-muted">Edited</span>}
            {m.pinned && <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-muted"><Pin className="size-3" aria-hidden />Pinned</span>}
          </div>
          {orphan && !nested && <p className="text-xs text-muted"><CornerDownRight className="mr-1 inline size-3" aria-hidden />Reply to an earlier message that is no longer shown</p>}
          {m.expired_at ? <p className="text-sm text-muted italic">Message expired ({RETENTION_DAYS}-day retention)</p>
            : m.deleted_at ? <p className="text-sm text-muted italic">{m.removal_kind === "manager" ? "Message removed by a manager" : "Message deleted"}</p>
            : editing?.id === m.id ? (
            <form className="mt-1 space-y-2" onSubmit={async (e) => {
              e.preventDefault();
              const r = await editMessage({ messageId: m.id, body: editing.body });
              if (!r.ok) return toast.error(r.error);
              setEditing(null);
              router.refresh();
            }}>
              <Textarea aria-label="Edit message" rows={3} maxLength={4000} value={editing.body} onChange={(e) => setEditing({ id: m.id, body: e.target.value })} />
              <div className="flex gap-2"><Button size="sm" type="submit">Save</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
            </form>
          ) : <p className="text-sm break-words whitespace-pre-wrap text-ink">{m.body}</p>}
          {!gone && m.attachments.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-2">
              {m.attachments.map((a) => (
                <li key={a.id}>
                  <a href={`/communications/files/${a.id}`} target="_blank" rel="noopener noreferrer"
                    className="inline-flex h-[26px] items-center gap-1.5 rounded-xl border border-line bg-surface px-2 text-xs leading-4 text-ink hover:border-strong">
                    {a.mime_type === "application/pdf" ? <FileText className="size-3.5" aria-hidden /> : <Paperclip className="size-3.5" aria-hidden />}
                    <span className="max-w-48 truncate">{a.file_name}</span>
                    <span className="text-muted">{formatBytes(a.size_bytes)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-3">
            {mine && !gone && <ReceiptLine r={receipts[m.id]} />}
            {!gone && (
              <div className="flex gap-1 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                {props.canPost && !nested && <Button size="sm" variant="ghost" className="h-7 px-2" icon={<Reply className="size-3.5" />} onClick={() => setReplyTo(m)}>Reply</Button>}
                {canEdit && <Button size="sm" variant="ghost" className="h-7 px-2" icon={<Pencil className="size-3.5" />} onClick={() => setEditing({ id: m.id, body: m.body })}>Edit</Button>}
                {props.canManage && (
                  <Button size="sm" variant="ghost" className="h-7 px-2" icon={m.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                    onClick={async () => { const r = await pinMessage({ messageId: m.id, pinned: !m.pinned }); if (!r.ok) toast.error(r.error); else router.refresh(); }}>
                    {m.pinned ? "Unpin" : "Pin"}
                  </Button>
                )}
                {canDelete && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-red-700" icon={<Trash2 className="size-3.5" />}
                    onClick={() => { setReason(""); setDeleting({ id: m.id, manager: !ownDelete }); }}>
                    {ownDelete ? "Delete" : "Remove"}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </li>
    );
  }

  return (
    <div className="flex flex-col">
      {pinned.length > 0 && (
        <section aria-label="Pinned messages" className="border-b border-line bg-surface/60 px-4 py-3">
          <h3 className="mb-1 flex items-center gap-1 text-xs font-semibold text-muted"><Pin className="size-3.5" aria-hidden />Pinned</h3>
          <ul className="space-y-1">
            {pinned.map((m) => <li key={m.id} className="text-sm text-ink"><a href={`#m-${m.id}`} className="hover:underline">{m.body}</a> <span className="text-xs text-muted">— {name(m.author_id)}</span></li>)}
          </ul>
        </section>
      )}
      <ol ref={list} aria-label="Messages" className="max-h-[60vh] min-h-48 overflow-y-auto px-4 py-2">
        {props.hasEarlier && (
          <li className="list-none py-2 text-center">
            <Link href={`?show=${props.shown + 100}`} scroll={false} className="text-sm font-semibold text-brand-fg hover:underline">Show earlier messages</Link>
          </li>
        )}
        {messages.length === 0 && <li className="py-10 text-center text-sm text-muted">No messages yet. Messages are kept for {RETENTION_DAYS} days.</li>}
        {top.map((m) => {
          const thread = replies.get(m.id) ?? [];
          const open = !collapsed.has(m.id);
          return (
            <li key={m.id} className="list-none">
              <ul>{renderMessage(m)}</ul>
              {thread.length > 0 && (
                <div className="ml-10">
                  <button type="button" aria-expanded={open} className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-ink"
                    onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}>
                    {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                    {open ? "Hide replies" : `Show ${thread.length} ${thread.length === 1 ? "reply" : "replies"}`}
                  </button>
                </div>
              )}
              {thread.length > 0 && open && (
                <ul aria-label="Replies" className="border-l-2 border-line pl-2">
                  {thread.map((r) => renderMessage(r, true))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      <div className="border-t border-line px-4 py-3">
        {!props.canPost ? (
          <p className="text-sm text-muted">{props.postBlockedReason ?? "You cannot post in this conversation."}</p>
        ) : (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            {replyTo && (
              <div className="flex items-center gap-2 rounded-xl bg-surface px-3 py-1.5 text-xs text-muted">
                <CornerDownRight className="size-3.5" aria-hidden />
                <span className="min-w-0 flex-1 truncate">Replying to {name(replyTo.author_id)}: {replyTo.body}</span>
                <button type="button" aria-label="Cancel reply" onClick={() => setReplyTo(null)}><X className="size-3.5" /></button>
              </div>
            )}
            <Textarea
              aria-label="Message"
              placeholder="Write a message…"
              rows={2}
              maxLength={4000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            />
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Files to send">
                {files.map((f) => (
                  <li key={f.key} className={cn("inline-flex h-[26px] items-center gap-1.5 rounded-xl border px-2 text-xs leading-4", f.status === "failed" ? "border-red-300 text-red-800" : "border-line text-ink")}>
                    <Paperclip className="size-3.5" aria-hidden />
                    <span className="max-w-40 truncate">{f.name}</span>
                    <span className="text-muted">{f.status === "uploading" ? "Uploading…" : f.status === "failed" ? f.error : formatBytes(f.size)}</span>
                    <button type="button" aria-label={`Remove ${f.name}`} onClick={() => void removeFile(f)}><X className="size-3.5" /></button>
                  </li>
                ))}
              </ul>
            )}
            <FormError message={error} />
            <div className="flex items-center justify-between gap-2">
              <div>
                <input ref={fileInput} type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" id="comm-file" onChange={(e) => void upload(e.target.files)} />
                <label htmlFor="comm-file" className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl px-2 text-sm font-semibold text-muted hover:bg-surface hover:text-ink">
                  <Paperclip className="size-4" aria-hidden />Attach
                </label>
                <span className="ml-2 hidden text-xs text-muted sm:inline">Photos or PDF, up to 10 MB. Enter sends; Shift+Enter adds a line.</span>
              </div>
              <Button type="submit" loading={sending} icon={<Send className="size-4" />} disabled={sending || (!body.trim() && !files.some((f) => f.status === "ready"))}>Send</Button>
            </div>
          </form>
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting?.manager ? "Remove this message?" : "Delete this message?"}
        description={deleting?.manager
          ? "Members will see that a manager removed a message. The reason and the original are kept for administrators and recorded in the audit log."
          : "Members will see that a message was deleted. Administrators keep the original for the record."}
        confirmLabel={deleting?.manager ? "Remove" : "Delete"}
        tone="danger"
        onConfirm={async () => {
          if (!deleting) return;
          if (deleting.manager && reason.trim().length < 5) return "Give the reason for removing this message.";
          const r = await deleteMessage(deleting.id, deleting.manager ? reason : undefined);
          if (!r.ok) return r.error;
          setDeleting(null);
          router.refresh();
        }}
      >
        {deleting?.manager && (
          <Field label="Reason (required)" htmlFor="remove-reason">
            <Textarea id="remove-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
      </ConfirmDialog>
    </div>
  );
}
