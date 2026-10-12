"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import {
  announcementSchema, channelSchema, groupSchema, messageSchema, preferencesSchema, settingsSchema, workspaceScopeSchema,
} from "@/lib/communications";
import { requireAccess } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Every rule (membership, history, edit windows, permissions, safety minimums,
// tenancy) is enforced by the database functions; these actions validate input
// shape and translate errors. Nothing here sends email or any external message.

const id = z.uuid();
const reason = (min: number, label: string) => z.string().trim().min(min, label).max(500);

function refresh(conversationId?: string) {
  revalidatePath("/communications", "layout");
  if (conversationId) revalidatePath(`/communications/c/${conversationId}`);
}

async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}) {
  await requireAccess();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  return { data: data as T, error };
}

function first(e: z.ZodError) {
  return e.issues[0]?.message ?? "Invalid request.";
}

// -----------------------------------------------------------------------------
// Conversations and messages
// -----------------------------------------------------------------------------
export async function sendMessage(input: z.input<typeof messageSchema>): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    const p = messageSchema.safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { data, error } = await rpc<{ id: string }>("comm_send_files", {
      p_conversation: p.data.conversationId, p_body: p.data.body, p_reply_to: p.data.replyTo, p_client_key: p.data.clientKey, p_attachments: p.data.attachments,
    });
    if (error) return fail(dbErrorMessage(error));
    refresh(p.data.conversationId);
    return ok({ id: data.id });
  });
}

export async function openDirect(userId: string): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    if (!id.safeParse(userId).success) return fail("Choose a person.");
    const { data, error } = await rpc<string>("comm_open_direct", { p_user: userId });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok({ id: data });
  });
}

export async function createGroup(input: z.input<typeof groupSchema>): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    const p = groupSchema.safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { data, error } = await rpc<string>("comm_create_group", { p_title: p.data.title, p_members: p.data.members });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok({ id: data }, "Group created.");
  });
}

export async function createChannel(input: z.input<typeof channelSchema>): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    const p = channelSchema.safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { data, error } = await rpc<string>("comm_create_channel", {
      p_title: p.data.title, p_description: p.data.description, p_department: p.data.department, p_add_department: p.data.addDepartment, p_members: p.data.members,
    });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok({ id: data }, "Channel created.");
  });
}

export async function addMembers(input: { conversationId: string; members: string[]; shareHistory: boolean }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ conversationId: id, members: z.array(id).min(1, "Choose at least one person."), shareHistory: z.boolean() }).safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { error } = await rpc("comm_add_members", { p_conversation: p.data.conversationId, p_members: p.data.members, p_share_history: p.data.shareHistory });
    if (error) return fail(dbErrorMessage(error));
    refresh(p.data.conversationId);
    return ok(undefined, "Added.");
  });
}

export async function removeMember(input: { conversationId: string; userId: string; reason: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ conversationId: id, userId: id, reason: z.string().trim().max(300).default("") }).safeParse(input);
    if (!p.success) return fail("Invalid request.");
    const { error } = await rpc("comm_remove_member", { p_conversation: p.data.conversationId, p_user: p.data.userId, p_reason: p.data.reason });
    if (error) return fail(dbErrorMessage(error));
    refresh(p.data.conversationId);
    return ok(undefined, "Removed. They keep the history up to now and receive nothing new.");
  });
}

export async function setTitle(input: { conversationId: string; title: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ conversationId: id, title: z.string().trim().max(120) }).safeParse(input);
    if (!p.success) return fail("Invalid request.");
    const { error } = await rpc("comm_set_title", { p_conversation: p.data.conversationId, p_title: p.data.title });
    if (error) return fail(dbErrorMessage(error));
    refresh(p.data.conversationId);
    return ok(undefined, "Name saved.");
  });
}

export async function setMemberRole(input: { conversationId: string; userId: string; role: "member" | "manager" }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ conversationId: id, userId: id, role: z.enum(["member", "manager"]) }).safeParse(input);
    if (!p.success) return fail("Invalid request.");
    const { error } = await rpc("comm_set_member_role", { p_conversation: p.data.conversationId, p_user: p.data.userId, p_role: p.data.role });
    if (error) return fail(dbErrorMessage(error));
    refresh(p.data.conversationId);
    return ok(undefined, "Role saved.");
  });
}

/** minutes: a number, null = until turned back on, 0 = unmute. */
export async function mute(input: { conversationId: string; minutes: number | null }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ conversationId: id, minutes: z.number().int().min(0).max(43200).nullable() }).safeParse(input);
    if (!p.success) return fail("Invalid request.");
    const { error } = await rpc("comm_mute", { p_conversation: p.data.conversationId, p_minutes: p.data.minutes });
    if (error) return fail(dbErrorMessage(error));
    refresh(p.data.conversationId);
    return ok(undefined, p.data.minutes === 0 ? "Notifications on." : "Muted.");
  });
}

export async function markRead(conversationId: string): Promise<ActionResult> {
  return guard(async () => {
    if (!id.safeParse(conversationId).success) return fail("Invalid request.");
    const { error } = await rpc("comm_mark_read", { p_conversation: conversationId });
    if (error) return fail(dbErrorMessage(error));
    return ok(undefined);
  });
}

export async function editMessage(input: { messageId: string; body: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ messageId: id, body: z.string().trim().min(1, "Write a message.").max(4000) }).safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { error } = await rpc("comm_edit_message", { p_message: p.data.messageId, p_body: p.data.body });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Message edited.");
  });
}

export async function deleteMessage(messageId: string): Promise<ActionResult> {
  return guard(async () => {
    if (!id.safeParse(messageId).success) return fail("Invalid request.");
    const { error } = await rpc("comm_delete_message", { p_message: messageId });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Message deleted.");
  });
}

export async function pinMessage(input: { messageId: string; pinned: boolean }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ messageId: id, pinned: z.boolean() }).safeParse(input);
    if (!p.success) return fail("Invalid request.");
    const { error } = await rpc("comm_pin_message", { p_message: p.data.messageId, p_pinned: p.data.pinned });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, p.data.pinned ? "Pinned." : "Unpinned.");
  });
}

export async function discardAttachment(attachmentId: string): Promise<ActionResult> {
  return guard(async () => {
    if (!id.safeParse(attachmentId).success) return fail("Invalid request.");
    const { error } = await rpc("comm_discard_attachment", { p_attachment: attachmentId });
    if (error) return fail(dbErrorMessage(error));
    return ok(undefined);
  });
}

// -----------------------------------------------------------------------------
// Presence, notifications, preferences, settings, search
// -----------------------------------------------------------------------------
export async function setPresence(status: "available" | "busy" | "away" | null): Promise<ActionResult> {
  return guard(async () => {
    if (status !== null && !["available", "busy", "away"].includes(status)) return fail("Choose a status.");
    const { error } = await rpc("comm_set_presence", { p_status: status });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Status saved.");
  });
}

export async function markNotificationsRead(ids: string[] | null): Promise<ActionResult> {
  return guard(async () => {
    if (ids && !z.array(id).safeParse(ids).success) return fail("Invalid request.");
    const { error } = await rpc("comm_mark_notifications_read", { p_ids: ids });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined);
  });
}

export async function savePreferences(input: z.input<typeof preferencesSchema>): Promise<ActionResult> {
  return guard(async () => {
    const p = preferencesSchema.safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { error } = await rpc("comm_save_preferences", { p: p.data });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Notification preferences saved.");
  });
}

export async function saveSettings(input: z.input<typeof settingsSchema>): Promise<ActionResult> {
  return guard(async () => {
    const p = settingsSchema.safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { error } = await rpc("comm_save_settings", { p: p.data });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Communications settings saved.");
  });
}

export async function saveAlertSetting(input: { type: string; enabled: boolean; default_priority: string; ack_scope: string; escalation_minutes: number; escalation_roles: string[] }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({
      type: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
      enabled: z.boolean(),
      default_priority: z.enum(["informational", "action_required", "critical"]),
      ack_scope: z.enum(["any", "all"]),
      escalation_minutes: z.number().int().min(5).max(10080),
      escalation_roles: z.array(z.enum(["owner", "office", "dispatcher", "mechanic"])).min(1, "Choose who receives escalations."),
    }).safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { type, ...rest } = p.data;
    const { error } = await rpc("comm_save_alert_setting", { p_type: type, p: rest });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Alert setting saved.");
  });
}

export type SearchHit = { id: string; conversation_id: string; body: string; author: string; created_at: string };

export async function search(query: string): Promise<ActionResult<{ messages: SearchHit[]; announcements: Array<{ id: string; title: string; published_at: string }> }>> {
  return guard(async () => {
    const q = z.string().trim().min(2, "Search for at least 2 characters.").max(200).safeParse(query);
    if (!q.success) return fail(first(q.error));
    const { data, error } = await rpc<{ messages: SearchHit[]; announcements: Array<{ id: string; title: string; published_at: string }> }>("comm_search", { p_query: q.data });
    if (error) return fail(dbErrorMessage(error));
    return ok(data);
  });
}

export async function adminSearch(input: { query: string; reason: string }): Promise<ActionResult<SearchHit[]>> {
  return guard(async () => {
    const p = z.object({ query: z.string().trim().min(2, "Search for at least 2 characters.").max(200), reason: reason(5, "Give the reason for this administrative search.") }).safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { data, error } = await rpc<SearchHit[]>("comm_admin_search", { p_query: p.data.query, p_reason: p.data.reason });
    if (error) return fail(dbErrorMessage(error));
    return ok(data ?? [], "The search was recorded in the audit log.");
  });
}

// -----------------------------------------------------------------------------
// Announcements
// -----------------------------------------------------------------------------
export async function publishAnnouncement(input: z.input<typeof announcementSchema>): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    const p = announcementSchema.safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { data, error } = await rpc<string>("comm_publish_announcement", {
      p: { title: p.data.title, body: p.data.body, department: p.data.department, requires_ack: p.data.requiresAck, client_key: p.data.clientKey },
    });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok({ id: data }, "Announcement published in Taviron. No email or text message is sent.");
  });
}

export async function editAnnouncement(input: { id: string; title: string; body: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ id, title: z.string().trim().min(3).max(150), body: z.string().trim().min(1).max(8000) }).safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { error } = await rpc("comm_edit_announcement", { p_id: p.data.id, p_title: p.data.title, p_body: p.data.body });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    revalidatePath(`/communications/announcements/${p.data.id}`);
    return ok(undefined, "Announcement updated. The earlier version is kept.");
  });
}

export async function withdrawAnnouncement(announcementId: string): Promise<ActionResult> {
  return guard(async () => {
    if (!id.safeParse(announcementId).success) return fail("Invalid request.");
    const { error } = await rpc("comm_withdraw_announcement", { p_id: announcementId });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Announcement withdrawn.");
  });
}

export async function announcementReceipt(input: { id: string; acknowledge: boolean }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ id, acknowledge: z.boolean() }).safeParse(input);
    if (!p.success) return fail("Invalid request.");
    const { error } = await rpc("comm_announcement_receipt", { p_id: p.data.id, p_acknowledge: p.data.acknowledge });
    if (error) return fail(dbErrorMessage(error));
    if (p.data.acknowledge) refresh();
    return ok(undefined, p.data.acknowledge ? "Acknowledged." : undefined);
  });
}

// -----------------------------------------------------------------------------
// Alerts
// -----------------------------------------------------------------------------
export async function acknowledgeAlert(input: { id: string; note: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ id, note: z.string().trim().max(500).default("") }).safeParse(input);
    if (!p.success) return fail("Invalid request.");
    const { error } = await rpc("comm_alert_acknowledge", { p_alert: p.data.id, p_note: p.data.note });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Acknowledged. The alert stays open until it is resolved.");
  });
}

export async function setAlertPriority(input: { id: string; priority: string; reason: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ id, priority: z.enum(["informational", "action_required", "critical"]), reason: reason(3, "Give a reason for changing the priority.") }).safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { error } = await rpc("comm_alert_set_priority", { p_alert: p.data.id, p_priority: p.data.priority, p_reason: p.data.reason });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Priority changed.");
  });
}

export async function reassignAlert(input: { id: string; from: string; to: string; reason: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ id, from: id, to: id, reason: reason(3, "Give a reason for the reassignment.") }).safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { error } = await rpc("comm_alert_reassign", { p_alert: p.data.id, p_from: p.data.from, p_to: p.data.to, p_reason: p.data.reason });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Responsibility reassigned.");
  });
}

export async function resolveAlert(input: { id: string; note: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ id, note: reason(3, "Describe how it was resolved.") }).safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { error } = await rpc("comm_alert_resolve", { p_alert: p.data.id, p_note: p.data.note });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Alert resolved. Recipients were notified in Taviron.");
  });
}

// -----------------------------------------------------------------------------
// Operational workspaces
// -----------------------------------------------------------------------------
export interface WorkspacePreview {
  loads: Array<{ load_id: string; label: string; date: string }>;
  drivers: Array<{ user_id: string; name: string }>;
  drivers_without_login: number;
}

export async function previewWorkspace(scope: unknown): Promise<ActionResult<WorkspacePreview>> {
  return guard(async () => {
    const p = workspaceScopeSchema.safeParse(scope);
    if (!p.success) return fail(first(p.error));
    const { data, error } = await rpc<WorkspacePreview>("comm_operation_preview", { p: p.data });
    if (error) return fail(dbErrorMessage(error));
    return ok(data);
  });
}

export async function createWorkspace(input: { title: string; scope: unknown; staff: string[] }): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    const scope = workspaceScopeSchema.safeParse(input.scope);
    if (!scope.success) return fail(first(scope.error));
    const p = z.object({ title: z.string().trim().min(2, "Name the workspace.").max(120), staff: z.array(id) }).safeParse(input);
    if (!p.success) return fail(first(p.error));
    const { data, error } = await rpc<string>("comm_create_operation", { p_title: p.data.title, p: scope.data, p_staff: p.data.staff });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok({ id: data }, "Workspace created. Driver membership now follows dispatch.");
  });
}

export async function resyncWorkspace(conversationId: string): Promise<ActionResult> {
  return guard(async () => {
    if (!id.safeParse(conversationId).success) return fail("Invalid request.");
    const { error } = await rpc("comm_operation_resync", { p_conversation: conversationId });
    if (error) return fail(dbErrorMessage(error));
    refresh(conversationId);
    return ok(undefined, "Membership recalculated from current dispatch.");
  });
}

export async function closeWorkspace(input: { conversationId: string; reason: string }): Promise<ActionResult> {
  return guard(async () => {
    const p = z.object({ conversationId: id, reason: z.string().trim().max(300).default("") }).safeParse(input);
    if (!p.success) return fail("Invalid request.");
    const { error } = await rpc("comm_operation_close", { p_conversation: p.data.conversationId, p_reason: p.data.reason });
    if (error) return fail(dbErrorMessage(error));
    refresh(p.data.conversationId);
    return ok(undefined, "Workspace closed. Drivers no longer have access.");
  });
}

export async function reopenWorkspace(conversationId: string): Promise<ActionResult> {
  return guard(async () => {
    if (!id.safeParse(conversationId).success) return fail("Invalid request.");
    const { error } = await rpc("comm_operation_reopen", { p_conversation: conversationId });
    if (error) return fail(dbErrorMessage(error));
    refresh(conversationId);
    return ok(undefined, "Workspace reopened. Drivers were recalculated from current assignments.");
  });
}
