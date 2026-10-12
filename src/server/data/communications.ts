import "server-only";
import type { ConversationKind, Presence, Priority, WorkStatus } from "@/lib/communications";
import { createClient } from "@/server/supabase/server";

// Reads for Communications. Row-level security and the database functions decide
// what each person may see; these loaders only shape the results. Every loader
// returns null when the Communications database update is not installed yet, so
// pages can show their "not available" state instead of failing.

const MISSING = new Set(["PGRST202", "PGRST205", "42P01", "42883"]);
function missing(error: { code?: string } | null) {
  return Boolean(error?.code && MISSING.has(error.code));
}
function fail(what: string, error: { message?: string }): never {
  throw new Error(`Could not load ${what}: ${error.message}`);
}

/** False until the Communications migrations are installed (checked before permissions, which they create). */
export async function isCommunicationsInstalled(): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.from("comm_settings").select("company_id").limit(1);
  if (error && missing(error)) return false;
  if (error) fail("communications settings", error);
  return true;
}

export interface Person {
  user_id: string;
  name: string;
  role: string;
  department: string | null;
  presence: Presence | null;
  work_status: WorkStatus;
  /** Set when the person has their own profile photo (null before the photo columns exist). */
  photo_updated_at?: string | null;
  /** Illustrated avatar from their employee record ("" when none). */
  avatar_key?: string;
}

export interface InboxItem {
  id: string;
  kind: ConversationKind;
  status: "active" | "closed" | "archived";
  department: string | null;
  title: string | null;
  other_user_id: string | null;
  active_member: boolean;
  muted_until: string | null;
  last_activity: string | null;
  unread: number;
}

export interface Notification {
  id: string;
  category: string;
  title: string;
  link: string;
  critical: boolean;
  created_at: string;
  read_at: string | null;
}

/** Inbox, directory and notifications in one call; runs housekeeping and the catch-up release (both throttled/idempotent). */
export async function loadCommunicationsHome() {
  const supabase = await createClient();
  const inbox = await supabase.rpc("comm_inbox");
  if (inbox.error) {
    if (missing(inbox.error)) return null;
    fail("conversations", inbox.error);
  }
  // Escalation, document checks, workspace archiving and retention run while people use the app (no scheduler exists).
  const [hk, release] = await Promise.all([supabase.rpc("comm_housekeeping"), supabase.rpc("comm_release_deferred")]);
  if (hk.error && !missing(hk.error)) console.error("Communications housekeeping failed", { code: hk.error.code, message: hk.error.message });
  if (release.error && !missing(release.error)) console.error("Catch-up release failed", { code: release.error.code });
  const [directory, notifications] = await Promise.all([loadDirectory(), loadNotifications()]);
  return { inbox: (inbox.data ?? []) as InboxItem[], directory: directory ?? [], notifications: notifications ?? [] };
}

export async function loadDirectory(): Promise<Person[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("comm_directory");
  if (error) {
    if (missing(error)) return null;
    if (error.code === "42501") return [];
    fail("the directory", error);
  }
  return (data ?? []) as Person[];
}

export async function loadNotifications(limit = 30): Promise<Notification[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("comm_notifications").select("id, category, title, link, critical, created_at, read_at")
    .order("created_at", { ascending: false }).limit(limit);
  if (error) {
    if (missing(error)) return null;
    fail("notifications", error);
  }
  return (data ?? []) as Notification[];
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string;
  title_custom: boolean;
  description: string;
  department: string | null;
  history_policy: "from_join" | "full";
  members_can_add: boolean;
  status: "active" | "closed" | "archived";
  created_by: string | null;
  created_at: string;
}

export interface Member {
  id: string;
  user_id: string;
  role: "member" | "manager";
  source: "manual" | "dispatch" | "creator";
  joined_at: string;
  history_from: string;
  left_at: string | null;
  left_reason: string;
  muted_until: string | null;
  last_read_at: string | null;
}

export interface Attachment {
  id: string;
  message_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
}

export interface Message {
  id: string;
  author_id: string | null;
  kind: "text" | "system";
  body: string;
  reply_to_id: string | null;
  pinned: boolean;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  attachments: Attachment[];
}

export interface Workspace {
  scope_type: "project" | "destination" | "loads";
  order_ids: string[];
  site_key: string | null;
  scope_date: string | null;
  load_ids: string[];
  sync_status: "ok" | "failed";
  sync_error: string;
  last_synced_at: string | null;
  work_finished_at: string | null;
}

export interface CommSettings {
  edit_window_minutes: number;
  members_delete_own: boolean;
  history_for_new_members: "from_join" | "full";
  retention_days: number | null;
  legal_hold: boolean;
  away_after_minutes: number;
  delivery_notifications: "notice" | "defer";
  workspace_archive_hours: number;
}

export const DEFAULT_SETTINGS: CommSettings = {
  edit_window_minutes: 15, members_delete_own: true, history_for_new_members: "from_join", retention_days: null,
  legal_hold: false, away_after_minutes: 15, delivery_notifications: "defer", workspace_archive_hours: 24,
};

export async function loadSettings(): Promise<CommSettings | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("comm_settings").select("*").maybeSingle();
  if (error) {
    if (missing(error)) return null;
    fail("communications settings", error);
  }
  return data ? (data as CommSettings) : DEFAULT_SETTINGS;
}

/** One conversation the caller is (or was) a member of; null when not found, undefined when not installed. */
export async function loadConversation(id: string) {
  const supabase = await createClient();
  const conv = await supabase.from("conversations").select("*").eq("id", id).maybeSingle();
  if (conv.error) {
    if (missing(conv.error)) return undefined;
    if (conv.error.code === "22P02") return null;
    fail("the conversation", conv.error);
  }
  if (!conv.data) return null;
  const [members, messages, workspace, receipts, inbox] = await Promise.all([
    supabase.from("conversation_members").select("id, user_id, role, source, joined_at, history_from, left_at, left_reason, muted_until, last_read_at")
      .eq("conversation_id", id).order("joined_at"),
    supabase.from("messages").select("id, author_id, kind, body, reply_to_id, pinned, created_at, edited_at, deleted_at")
      .eq("conversation_id", id).order("created_at", { ascending: false }).limit(300),
    supabase.from("operation_workspaces").select("scope_type, order_ids, site_key, scope_date, load_ids, sync_status, sync_error, last_synced_at, work_finished_at")
      .eq("conversation_id", id).maybeSingle(),
    supabase.rpc("comm_receipts", { p_conversation: id }),
    supabase.rpc("comm_inbox"),
  ]);
  if (members.error) fail("members", members.error);
  if (messages.error) fail("messages", messages.error);
  const rows = ((messages.data ?? []) as Omit<Message, "attachments">[]).reverse();
  const files = new Map<string, Attachment[]>();
  if (rows.length) {
    const att = await supabase.from("message_attachments").select("id, message_id, file_name, mime_type, size_bytes")
      .in("message_id", rows.map((m) => m.id)).order("created_at");
    if (att.error && !missing(att.error)) fail("attachments", att.error);
    for (const a of (att.data ?? []) as Attachment[]) files.set(a.message_id, [...(files.get(a.message_id) ?? []), a]);
  }
  const title = ((inbox.data ?? []) as InboxItem[]).find((c) => c.id === id)?.title ?? (conv.data as Conversation).title;
  return {
    conversation: { ...(conv.data as Conversation), title: title || (conv.data as Conversation).title },
    members: (members.data ?? []) as Member[],
    messages: rows.map((m) => ({ ...m, attachments: files.get(m.id) ?? [] })) as Message[],
    workspace: (workspace.data ?? null) as Workspace | null,
    receipts: (receipts.data ?? {}) as Record<string, { recipients: number; delivered: number; read: number }>,
    attachmentsAvailable: true,
  };
}

// -----------------------------------------------------------------------------
// Alerts
// -----------------------------------------------------------------------------
export interface AlertType {
  code: string;
  category: string;
  label: string;
  min_priority: Priority;
  default_priority: Priority;
  default_ack_scope: "any" | "all";
  default_escalation_minutes: number;
}

export interface AlertRow {
  id: string;
  event_type: string;
  title: string;
  detail: string;
  link: string;
  priority: Priority;
  ack_scope: "any" | "all";
  status: "open" | "resolved";
  occurrences: number;
  last_occurred_at: string;
  escalation_due_at: string | null;
  escalation_level: number;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string;
}

export async function loadAlerts(status: "open" | "resolved" | "all" = "open"): Promise<{ alerts: AlertRow[]; types: AlertType[]; mine: Set<string> } | null> {
  const supabase = await createClient();
  let q = supabase.from("alerts").select("*").order("created_at", { ascending: false }).limit(200);
  if (status !== "all") q = q.eq("status", status);
  const [alerts, types, rec] = await Promise.all([
    q,
    supabase.from("alert_event_types").select("*").order("category"),
    supabase.from("alert_recipients").select("alert_id, user_id, responsible, released_at"),
  ]);
  if (alerts.error) {
    if (missing(alerts.error)) return null;
    fail("alerts", alerts.error);
  }
  const { data: { user } } = await supabase.auth.getUser();
  const mine = new Set(((rec.data ?? []) as Array<{ alert_id: string; user_id: string; released_at: string | null }>)
    .filter((r) => r.user_id === user?.id && !r.released_at).map((r) => r.alert_id));
  return { alerts: (alerts.data ?? []) as AlertRow[], types: (types.data ?? []) as AlertType[], mine };
}

export async function loadAlert(id: string) {
  const supabase = await createClient();
  const alert = await supabase.from("alerts").select("*").eq("id", id).maybeSingle();
  if (alert.error) {
    if (missing(alert.error)) return undefined;
    if (alert.error.code === "22P02") return null;
    fail("the alert", alert.error);
  }
  if (!alert.data) return null;
  const a = alert.data as AlertRow;
  const [type, recipients, acks, events] = await Promise.all([
    supabase.from("alert_event_types").select("*").eq("code", a.event_type).single(),
    supabase.from("alert_recipients").select("id, user_id, reason, responsible, added_at, released_at").eq("alert_id", id).order("added_at"),
    supabase.from("alert_acknowledgments").select("user_id, acknowledged_at, priority_at, note").eq("alert_id", id).order("acknowledged_at"),
    supabase.from("alert_events").select("id, kind, details, actor_id, created_at").eq("alert_id", id).order("created_at"),
  ]);
  return {
    alert: a,
    type: type.data as AlertType,
    recipients: (recipients.data ?? []) as Array<{ id: string; user_id: string; reason: string; responsible: boolean; added_at: string; released_at: string | null }>,
    acks: (acks.data ?? []) as Array<{ user_id: string; acknowledged_at: string; priority_at: Priority; note: string }>,
    events: (events.data ?? []) as Array<{ id: string; kind: string; details: Record<string, unknown>; actor_id: string | null; created_at: string }>,
  };
}

export async function loadAlertSettings() {
  const supabase = await createClient();
  const [types, saved] = await Promise.all([
    supabase.from("alert_event_types").select("*").order("category"),
    supabase.from("comm_alert_settings").select("event_type, enabled, default_priority, ack_scope, escalation_minutes, escalation_roles"),
  ]);
  if (types.error) {
    if (missing(types.error)) return null;
    fail("alert settings", types.error);
  }
  const byType = new Map(((saved.data ?? []) as Array<{ event_type: string; enabled: boolean; default_priority: Priority; ack_scope: "any" | "all"; escalation_minutes: number; escalation_roles: string[] }>)
    .map((s) => [s.event_type, s]));
  return ((types.data ?? []) as AlertType[]).map((t) => ({
    type: t,
    enabled: byType.get(t.code)?.enabled ?? true,
    default_priority: byType.get(t.code)?.default_priority ?? t.default_priority,
    ack_scope: byType.get(t.code)?.ack_scope ?? t.default_ack_scope,
    escalation_minutes: byType.get(t.code)?.escalation_minutes ?? t.default_escalation_minutes,
    escalation_roles: byType.get(t.code)?.escalation_roles ?? ["owner"],
  }));
}

export async function loadAlertCounts(): Promise<{ open: number; critical: number; mine: number } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("comm_alert_counts");
  if (error) return null;
  return data as { open: number; critical: number; mine: number };
}

// -----------------------------------------------------------------------------
// Announcements
// -----------------------------------------------------------------------------
export interface Announcement {
  id: string;
  department: string | null;
  title: string;
  body: string;
  requires_ack: boolean;
  status: "published" | "withdrawn";
  published_by: string | null;
  published_at: string;
  edited_at: string | null;
}

export async function loadAnnouncements(): Promise<{ items: Announcement[]; receipts: Map<string, { read_at: string | null; acknowledged_at: string | null }> } | null> {
  const supabase = await createClient();
  const [items, receipts] = await Promise.all([
    supabase.from("announcements").select("id, department, title, body, requires_ack, status, published_by, published_at, edited_at")
      .order("published_at", { ascending: false }).limit(100),
    supabase.auth.getUser().then(({ data }) => supabase.from("announcement_receipts").select("announcement_id, read_at, acknowledged_at").eq("user_id", data.user?.id ?? "")),
  ]);
  if (items.error) {
    if (missing(items.error)) return null;
    fail("announcements", items.error);
  }
  return {
    items: (items.data ?? []) as Announcement[],
    receipts: new Map(((receipts.data ?? []) as Array<{ announcement_id: string; read_at: string | null; acknowledged_at: string | null }>).map((r) => [r.announcement_id, r])),
  };
}

export async function loadAnnouncement(id: string) {
  const supabase = await createClient();
  const a = await supabase.from("announcements").select("*").eq("id", id).maybeSingle();
  if (a.error) {
    if (missing(a.error)) return undefined;
    if (a.error.code === "22P02") return null;
    fail("the announcement", a.error);
  }
  if (!a.data) return null;
  const [receipts, revisions] = await Promise.all([
    supabase.from("announcement_receipts").select("user_id, read_at, acknowledged_at").eq("announcement_id", id),
    supabase.from("announcement_revisions").select("id, old_title, old_body, edited_by:actor_id, edited_at:created_at").eq("announcement_id", id).order("created_at", { ascending: false }),
  ]);
  return {
    announcement: a.data as Announcement,
    receipts: (receipts.data ?? []) as Array<{ user_id: string; read_at: string | null; acknowledged_at: string | null }>,
    revisions: (revisions.data ?? []) as Array<{ id: string; old_title: string; old_body: string; edited_by: string | null; edited_at: string }>,
  };
}

// -----------------------------------------------------------------------------
// Preferences
// -----------------------------------------------------------------------------
export interface Preferences {
  notify_direct: boolean;
  notify_group: boolean;
  notify_channel: boolean;
  notify_announcement: boolean;
  notify_alert: boolean;
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string;
}

export async function loadPreferences(): Promise<Preferences | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("comm_preferences").select("notify_direct, notify_group, notify_channel, notify_announcement, notify_alert, quiet_start, quiet_end, timezone").maybeSingle();
  if (error) {
    if (missing(error)) return null;
    fail("preferences", error);
  }
  const p = (data ?? { notify_direct: true, notify_group: true, notify_channel: true, notify_announcement: true, notify_alert: true, quiet_start: null, quiet_end: null, timezone: "America/Chicago" }) as Preferences;
  return { ...p, quiet_start: p.quiet_start?.slice(0, 5) ?? null, quiet_end: p.quiet_end?.slice(0, 5) ?? null };
}

/** My own presence choice (null = automatic). */
export async function loadMyPresence(): Promise<Presence | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("user_presence").select("manual_status").maybeSingle();
  return ((data as { manual_status: Presence | null } | null)?.manual_status) ?? null;
}

// -----------------------------------------------------------------------------
// Operational workspace choices
// -----------------------------------------------------------------------------
export async function loadWorkspaceChoices(date: string) {
  const supabase = await createClient();
  const [orders, loads] = await Promise.all([
    supabase.from("orders").select("id, order_number, site_label, site_line1, status, customers(name)")
      .in("status", ["confirmed", "scheduled", "dispatched", "in_progress", "partially_completed", "on_hold"]).order("order_number", { ascending: false }).limit(100),
    supabase.from("order_loads").select("id, load_number, load_date, status, order_id, orders(order_number, site_label, site_line1)")
      .eq("load_date", date).order("load_number").limit(200),
  ]);
  type OrderRow = { id: string; order_number: string; site_label: string | null; site_line1: string | null; status: string; customers: { name: string } | null };
  type LoadRow = { id: string; load_number: number; load_date: string; status: string; order_id: string; orders: { order_number: string; site_label: string | null; site_line1: string | null } | null };
  const loadRows = (loads.data ?? []) as unknown as LoadRow[];
  const sites = [...new Set(loadRows.map((l) => l.orders?.site_line1?.trim()).filter((s): s is string => Boolean(s)))].sort();
  return {
    orders: ((orders.data ?? []) as unknown as OrderRow[]).map((o) => ({ id: o.id, label: `${o.order_number} — ${o.customers?.name ?? "Customer"}${o.site_line1 ? ` — ${o.site_line1}` : ""}` })),
    loads: loadRows.filter((l) => l.status !== "canceled").map((l) => ({ id: l.id, label: `${l.orders?.order_number ?? "Order"} load ${l.load_number}${l.orders?.site_line1 ? ` — ${l.orders.site_line1}` : ""}` })),
    sites,
  };
}
