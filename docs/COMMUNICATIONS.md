# Communications

Employee messaging, operational workspaces, alerts and announcements inside each company. Everything stays
inside Taviron: **nothing is sent by email, text or push**, and the demo company sends nothing.

Status (2026-10-12): code written and tested locally. **The four hosted migrations below are not applied**, so on
Preview and Production every Communications page shows "Not available yet" until the owner applies them.

## Hosted migrations (owner action, in this order, after a backup — DEPLOYMENT §2a)

Earlier pending migrations first: `20261101000100` → `20261102000100` → `20261103000100` → `20261104000100`. Then:

1. `20261105000100_communications.sql` — settings, conversations, members, messages, revisions, events, presence,
   preferences, notifications, announcements (+ revisions, receipts), channels, search, permissions.
2. `20261105000200_operational_workspaces.sql` — dispatch-linked workspaces and their triggers on dispatch tables.
3. `20261105000300_operational_alerts.sql` — alert catalog, company policies, alerts, recipients, acknowledgments,
   history, escalation, and source triggers (work orders, driver reports, assignments, time off, announcements).
4. `20261105000400_comm_attachments.sql` — private `comm-attachments` bucket and policies. If Storage is not
   installed when it runs, run `select private.setup_comm_attachment_storage();` afterwards.

Each has a tested rollback in `supabase/rollbacks/` (apply → rollback → re-apply verified locally). Roll back in
reverse order. After applying, PostgREST must reload its schema (Supabase does this automatically).

## Permissions (database defaults; the owner can change them per role)

| Code | Default roles | Allows |
| --- | --- | --- |
| `comms.message` | owner, office, dispatcher, mechanic, driver | Direct messages, posting in conversations one belongs to, attachments |
| `comms.groups` | owner, office, dispatcher | Creating groups |
| `comms.channels` | owner, office | Creating and managing channels |
| `comms.announce` | owner, office | Publishing, editing and withdrawing announcements; seeing receipts |
| `comms.operations` | owner, dispatcher | Creating and managing operational workspaces |
| `comms.alerts` | owner, dispatcher | Seeing all alerts; changing priority, reassigning, resolving |
| `comms.admin` | owner | Company rules, alert policies, audited administrative search, deleting any message |

Every rule is enforced in the database (RLS and `SECURITY DEFINER` functions with `search_path = ''`, all on the
reviewed list in `tests/db/tenancy.test.ts`). The server actions only validate input shape.

## Behaviour

**Conversations.** Direct messages are unique per pair and reused. Groups are named by members unless renamed.
Channels are per department or topic. Membership is kept as periods (`joined_at`, `history_from`, `left_at`): a new
member sees messages from when they joined (company setting or a manager may share the full history); a removed
member keeps the history up to removal and receives nothing new. One level of threads (replies to replies attach to
the original). Edits and deletions are allowed for the company's window (default 15 minutes); originals are kept in
`message_revisions` (readable by `comms.admin` only). Double submissions are ignored (client key). Delivery and read
receipts are shown to the author.

**Presence and work status.** Presence is Available / Busy / Away as chosen, or automatic (Available while active,
Away after the company's inactivity threshold — an estimate). Work status comes only from Taviron's own records:
*Active delivery* (an active assignment whose load window is now and that has no delivery ticket yet) or *Out of
office* (approved time off now). Otherwise it is *Unknown*: no work schedules exist, so Taviron never shows
"Working hours" or "Outside working hours" and never says someone is available. Neither value is an hours-of-service
record or a statement about dispatch availability, and the UI says so.

**Drivers on an active delivery.** Wherever a recipient is on an active delivery the app shows: "Driver may be
operating a vehicle. Do not expect an immediate response." Company setting: *notice only*, or *defer* (default):
routine message notifications are held and replaced by a single catch-up notification when the delivery ends.
Messages themselves are never held. Critical alerts are never held, muted or deferred.

**Notifications** are in-app only. Each person chooses categories, quiet hours (held, released afterwards) and
per-conversation mutes (1 hour … 1 week, or indefinitely). Critical alerts ignore all of these.

**Operational workspaces.** Scope: a project (orders), a destination on a date, or selected loads. The recipient
preview must be run before creating. Drivers with active, undelivered assignments in scope (and a Taviron login)
are members; membership is recalculated in the same transaction as each committed dispatch change (assign,
replace, cancel, load cancel/date change, order site change, delivery ticket). A replacement driver joins with
pinned context only; the replaced driver keeps the history up to removal and gets nothing new. If recalculation
fails, dispatch still commits, the workspace is marked failed and posting pauses until someone resyncs.
Workspaces archive automatically after all loads are finished plus the company delay (default 24 h) unless a
Critical alert is open on their loads or trucks; they can be closed and reopened by hand (reopen recalculates from
current assignments; former drivers do not regain access).

**Alerts** are separate from conversations. Types and safety minimums:

| Type | Minimum | Default | Acknowledged by |
| --- | --- | --- | --- |
| Safety-critical defect restricts a truck | Critical | Critical | one recipient |
| Breakdown / inspection problem reported | Action required | Critical | one recipient |
| Approved time off overlaps assignments | Action required | Action required | one recipient |
| Assignment canceled (to the driver) | Informational | Informational | — |
| Time-off request waiting / decided | Informational | Informational | — |
| Vehicle document expires within 30 days | Informational | Action required | one recipient |
| Vehicle document expired | Action required | Action required | one recipient |
| Announcement needs acknowledgment | Informational | Action required | every recipient |

Repeats of the same event update the open alert (occurrences); a distinct event gets its own. Priority can be
raised or lowered with a reason, never below the minimum; safety alerts cannot be turned off. Unacknowledged
Critical alerts escalate to the company's escalation roles (default owner) after the interval; the original
recipients stay responsible. Responsibility ends only by explicit reassignment. Resolution notifies recipients with
a link. Time-off alerts never contain the leave category or comment. Every change is in the alert history; policy
changes are audited.

**Announcements** go to everyone or one department (from employee records), may require acknowledgment (which
raises an "all recipients" alert that resolves when everyone has acknowledged), can be edited (versions kept) or
withdrawn.

**Search** returns only what the caller may read (same history rules). The administrative search (`comms.admin`)
covers all conversations, needs a reason, and every search is written to the audit log.

**Attachments.** JPEG, PNG, WebP or PDF up to 10 MB, at most 5 per message. The type is decided from the file's
bytes. The database reserves the storage path, the storage policy accepts the upload only at that path, and the
database confirms size and type before the file can be sent. Files are visible only to people who can read the
message (deleted messages hide their files). Downloads go through `/communications/files/[id]`, which checks access
on every request and redirects to a 60-second signed URL. There are no public URLs. App users can never delete or
replace a stored file.

**Retention and audit.** Optional retention (≥ 30 days) deletes older messages unless legal hold is on; each run is
audited. Settings and alert policies are audited. Administrator deletions of messages they could not otherwise see
are audited.

## Real-time updates

No realtime service is used. Open Communications pages re-render from the server every 10 seconds while the browser
tab is visible, and immediately when it becomes visible again (`src/components/communications/poller.tsx`). The
inbox load also runs housekeeping (escalation, document checks, workspace archiving, retention; at most once a
minute per company) because Taviron has no scheduler: escalations happen when someone in the company has
Communications open.

## Files

- `src/lib/communications.ts` — labels, safety wording, attachment checks, input schemas.
- `src/server/data/communications.ts` — loaders (return `null`/`undefined` when the migration is not installed).
- `src/app/(app)/communications/` — pages (`/communications`, `/c/[id]`, `/channels`, `/alerts`, `/alerts/[id]`,
  `/announcements`, `/announcements/[id]`, `/workspaces/new`, `/settings`), `actions.ts`, `files/` routes.
- `src/components/communications/` — UI components.
- Tests: `tests/db/communications.test.ts`, `operational-workspaces.test.ts`, `operational-alerts.test.ts`,
  `comm-attachments.test.ts`, `tests/unit/communications.test.ts`, `tests/e2e/communications.spec.ts`.

## Not built (honest limits)

- Email, SMS or push notifications (in-app only; push would need a service and approval).
- Work schedules — so "Working hours" / "Outside working hours" are never shown.
- Joining a channel without being added; reactions; typing indicators; message forwarding.
- A storage cleanup script for abandoned attachment uploads (`public.abandoned_comm_attachments()` lists them for
  the service role; deleting them is a manual step until a script exists).
- Escalation runs only while someone in the company uses Communications (no scheduler).
- Nav badges for unread messages outside the Communications pages.
