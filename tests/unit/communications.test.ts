import { describe, expect, it } from "vitest";
import {
  allowedPriorities, checkAttachment, DRIVING_NOTICE, isMuted, messageSchema, muteLabel, preferencesSchema, settingsSchema,
  STATUS_DISCLAIMER, WORK_STATUS, workspaceScopeSchema,
} from "@/lib/communications";

const bytes = (s: string) => new TextEncoder().encode(s);
const id = "6f0f7d8e-3b1a-4c2d-9e8f-0a1b2c3d4e5f";

describe("attachments", () => {
  it("decides the type from the bytes, never the declared type or name", () => {
    expect(checkAttachment(bytes("%PDF-1.7\n..."), "application/pdf")).toEqual({ ok: true, type: "application/pdf" });
    expect(checkAttachment(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "")).toEqual({ ok: true, type: "image/jpeg" });
    expect(checkAttachment(bytes("<html>"), "application/pdf")).toMatchObject({ ok: false, status: 415 });
    expect(checkAttachment(bytes("%PDF-1.7"), "image/png")).toMatchObject({ ok: false, status: 415 });
    expect(checkAttachment(new Uint8Array(), "application/pdf")).toMatchObject({ ok: false, status: 400 });
    expect(checkAttachment(new Uint8Array(10 * 1024 * 1024 + 1), "application/pdf")).toMatchObject({ ok: false, status: 413 });
  });
});

describe("priorities", () => {
  it("never offers a priority below the type's safety minimum", () => {
    expect(allowedPriorities("critical")).toEqual(["critical"]);
    expect(allowedPriorities("action_required")).toEqual(["action_required", "critical"]);
    expect(allowedPriorities("informational")).toEqual(["informational", "action_required", "critical"]);
  });
});

describe("mutes", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  it("treats the database's 'infinity' as an indefinite mute and past times as unmuted", () => {
    expect(isMuted("infinity", now)).toBe(true);
    expect(muteLabel("infinity", now)).toBe("Muted");
    expect(isMuted("2026-10-12T13:00:00Z", now)).toBe(true);
    expect(muteLabel("2026-10-12T13:00:00Z", now, "UTC")).toBe("Muted until Oct 12, 1:00 PM");
    expect(isMuted("2026-10-12T11:00:00Z", now)).toBe(false);
    expect(muteLabel(null, now)).toBeNull();
  });
});

describe("input rules", () => {
  it("a message needs text or a file, at most 5 files", () => {
    expect(messageSchema.safeParse({ conversationId: id, body: "  ", clientKey: id }).success).toBe(false);
    expect(messageSchema.safeParse({ conversationId: id, body: "", clientKey: id, attachments: [id] }).success).toBe(true);
    expect(messageSchema.safeParse({ conversationId: id, body: "x", clientKey: id, attachments: Array(6).fill(id) }).success).toBe(false);
  });

  it("quiet hours need both ends and different times", () => {
    const base = { notify_direct: true, notify_group: true, notify_channel: true, notify_announcement: true, notify_alert: true, timezone: "America/Chicago" };
    expect(preferencesSchema.safeParse({ ...base, quiet_start: "21:00", quiet_end: "06:00" }).success).toBe(true);
    expect(preferencesSchema.safeParse({ ...base, quiet_start: "21:00", quiet_end: null }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...base, quiet_start: "21:00", quiet_end: "21:00" }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...base, quiet_start: null, quiet_end: null }).success).toBe(true);
  });

  it("retention is empty or at least 30 days", () => {
    const base = { edit_window_minutes: 15, members_delete_own: true, history_for_new_members: "from_join", legal_hold: false, away_after_minutes: 15, delivery_notifications: "defer", workspace_archive_hours: 24 };
    expect(settingsSchema.safeParse({ ...base, retention_days: null }).success).toBe(true);
    expect(settingsSchema.safeParse({ ...base, retention_days: 10 }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...base, retention_days: 90 }).success).toBe(true);
  });

  it("a workspace scope is a project, a destination on a date, or selected loads", () => {
    expect(workspaceScopeSchema.safeParse({ scope_type: "project", order_ids: [id] }).success).toBe(true);
    expect(workspaceScopeSchema.safeParse({ scope_type: "project", order_ids: [] }).success).toBe(false);
    expect(workspaceScopeSchema.safeParse({ scope_type: "destination", site: "100 Test Site Rd", date: "2026-10-12" }).success).toBe(true);
    expect(workspaceScopeSchema.safeParse({ scope_type: "destination", site: "100 Test Site Rd" }).success).toBe(false);
    expect(workspaceScopeSchema.safeParse({ scope_type: "loads", load_ids: [id] }).success).toBe(true);
    expect(workspaceScopeSchema.safeParse({ scope_type: "everyone" }).success).toBe(false);
  });
});

describe("safety wording", () => {
  it("states the driving notice exactly and never equates status with availability or hours of service", () => {
    expect(DRIVING_NOTICE).toBe("Driver may be operating a vehicle. Do not expect an immediate response.");
    expect(STATUS_DISCLAIMER).toMatch(/not hours-of-service records/);
    expect(Object.values(WORK_STATUS).join(" ")).not.toMatch(/available|on duty|off duty/i);
  });
});
