# Communications

Employee messaging, operational workspaces, alerts and announcements inside each company. Everything stays
inside Taviron: **nothing is sent by email, text or push**, and the demo company sends nothing.

Status (2026-10-12): the owner applied the migrations through `20261106000100`, so Communications runs on the hosted
database. **Two follow-ups are not applied yet:** `20261107000100` (photos in the directory, demo retire) and
`20261108000100` (hardening, below). Until `20261108000100` is applied, the hosted database still uses the earlier
rules: the company's edit window (default 15 minutes) instead of the fixed 5, no manager removal with a reason
(removing with a reason says the update is needed), and the old optional retention instead of the 14-day expiry.
The scheduled cleanup also needs `CRON_SECRET` (below). None of the hardening is live until both are verified.

## Hosted migrations (owner action, in this order, after a backup — DEPLOYMENT §2a)

Earlier pending migrations first: `20261101000100` → `20261102000100` → `20261103000100` → `20261104000100`. Then:

1. `20261105000100_communications.sql` — settings, conversations, members, messages, revisions, events, presence,
   preferences, notifications, announcements (+ revisions, receipts), channels, search, permissions.
2. `20261105000200_operational_workspaces.sql` — dispatch-linked workspaces and their triggers on dispatch tables.
3. `20261105000300_operational_alerts.sql` — alert catalog, company policies, alerts, recipients, acknowledgments,
   history, escalation, and source triggers (work orders, driver reports, assignments, time off, announcements).
4. `20261105000400_comm_attachments.sql` — private `comm-attachments` bucket and policies. If Storage is not
   installed when it runs, run `select private.setup_comm_attachment_storage();` afterwards.

5. `20261107000100_people_photos_and_demo_retire.sql` — photos in the directory; prospect demo retire;
   `profile_photo_versions` (employee pages request only photos that exist; until applied they request every
   linked person's photo, as before).
6. `20261108000100_comm_hardening.sql` — fixed 5-minute edit/delete window, manager removal with a reason, 14-day
   message content retention (read time and purge, attachments, legal hold), all-companies housekeeping for the
   scheduler, archive veto for outstanding actions, driver-replacement handoff, demo sample content.

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
the original); each thread can be collapsed and expanded, and a reply whose original has expired says so.
Conversations show the newest 100 messages; "Show earlier messages" loads 100 more at a time (up to 1,000).

**Editing and deleting.** Authors may edit or delete their own message for **5 minutes from sending**, enforced by the
database; later edits never restart the window. Edited messages say "Edited". After the window (or for someone
else's message) only a manager with `comms.admin` can remove a message, and must give a reason; members then see
"Message removed by a manager". Every deletion leaves a tombstone; the original text stays in `message_revisions`
(readable by `comms.admin` only) with the reason, until retention removes it. Manager removals are written to the
audit log without the message text. Double submissions are ignored (client key). Delivery and read
receipts are shown to the author.

**Presence and work status.** Presence is Available (green) / Busy (red) / Away (yellow) as chosen, or automatic (Available while active,
Away after the company's inactivity threshold — an estimate). Work status comes only from Taviron's own records:
*Active delivery* (an active assignment whose load window is now and that has no delivery ticket yet) or *Out of
office* (approved time off now). Otherwise it is *Unknown*: no work schedules exist, so Taviron never shows
"Working hours" or "Outside working hours" and never says someone is available. Neither value is an hours-of-service
record or a statement about dispatch availability, and the UI says so. The presence dot is shown on people's
pictures in Communications and on your own picture in the top bar.

**Drivers on an active delivery.** Wherever a recipient is on an active delivery the app shows: "Driver may be
operating a vehicle. Do not expect an immediate response." Company setting: *notice only*, or *defer* (default):
routine message notifications are held and replaced by a single catch-up notification when the delivery ends.
Messages themselves are never held. Critical alerts are never held, muted or deferred.

**Notifications** are in-app only. Each person chooses categories, quiet hours (held, released afterwards) and
per-conversation mutes (1 hour … 1 week, or indefinitely). Critical alerts ignore all of these.

**Operational workspaces.** Scope: a project (orders), a destination on a date, or selected loads. The recipient
preview must be run before creating. Drivers with active, undelivered assignments in scope (and a Taviron login)
are members; membership is recalculated in the same transaction as each committed dispatch change (assign,
replace, cancel, load cancel/date change, order site change, delivery ticket). When a driver is replaced on a
load, the replacement inherits the replaced driver's history window (within retention) and a handoff message lists
the pinned instructions, open action-required or critical alerts on the load and its truck, and delivery tickets
awaiting review; they are also notified. The replaced driver keeps the history up to the handoff and gets nothing
new (no stale access: posting and reading new messages need a current membership). Other new drivers join with
pinned context only. If recalculation
fails, dispatch still commits, the workspace is marked failed and posting pauses until someone resyncs.
Workspaces archive automatically after all loads are finished plus the company delay (default 24 h), and only when
no outstanding action remains: no open Critical or Action-required alert on their loads or trucks and no delivery
ticket awaiting review; they can be closed and reopened by hand (reopen recalculates from
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

**Search** returns only what the caller may read (same history and retention rules). The administrative search (`comms.admin`)
covers all conversations, needs a reason, and every search is written to the audit log.

**Attachments.** JPEG, PNG, WebP or PDF up to 10 MB, at most 5 per message. The type is decided from the file's
bytes. The database reserves the storage path, the storage policy accepts the upload only at that path, and the
database confirms size and type before the file can be sent. Files are visible only to people who can read the
message (deleted messages hide their files). Downloads go through `/communications/files/[id]`, which checks access
on every request and redirects to a 60-second signed URL. There are no public URLs. App users can never delete or
replace a stored file.

**Message content retention: 14 days.** The text of direct messages, groups, channels, workspace conversations,
replies, edit history and attachments is kept 14 days from each message's creation; edits and replies never extend
it. It is enforced in the database, not only hidden in the UI:
- at read time, `private.comm_message_visible` (used by row-level security, search, unread counts, replies, pins and
  file access) stops returning content older than 14 days at once;
- the purge (`private.comm_apply_retention`) empties expired bodies, deletes their revisions and marks their
  attachments expired (unreadable). The rows stay, so threads and receipts stay consistent;
- stored files of expired attachments are removed through the Storage API by `/api/cron/comm-housekeeping`
  (Supabase does not allow deleting storage rows in SQL).

A company **legal hold** (Communications settings) overrides all of this: nothing expires while it is on; when it is
lifted the backlog expires at the next run. Audit records (`audit_events`) follow their own policy, are never
purged by message retention and never contain message text. The old optional `retention_days` setting (≥ 30 days,
or keep forever) and `edit_window_minutes` are no longer read; the 14-day policy replaces them. Announcements and
alerts are not message content and are not expired.

**Audit.** Settings, alert policies, manager removals (with reason) and administrative searches (with reason) are
audited; retention runs record counts only.

## Real-time updates and background jobs

No realtime service is used. Open Communications pages re-render from the server every 10 seconds while the browser
tab is visible, and immediately when it becomes visible again (`src/components/communications/poller.tsx`). Expired
content disappears on the next refresh because the database stops returning it.

Housekeeping (escalation, document checks, workspace archiving, retention) runs in three ways:
1. while people use Communications: the inbox load runs it for that company, at most once a minute;
2. **Vercel Cron** (`vercel.json`, daily at 04:17 UTC) calls `/api/cron/comm-housekeeping`, which runs
   `public.comm_housekeeping_all()` for every company and then removes expired attachment files. **Owner action:**
   set `CRON_SECRET` (at least 16 random characters) in the Vercel environment; without it the route refuses every
   request (503) and nothing runs. It also needs `SUPABASE_SERVICE_ROLE_KEY`, which is used there only for those
   three database functions and the `comm-attachments` bucket. Vercel Hobby allows daily cron jobs; more often needs
   a paid plan (not added);
3. **pg_cron**, if the owner installs that extension (Supabase dashboard → Database → Extensions) *before* applying
   `20261108000100`: the migration then schedules `comm-housekeeping` every 15 minutes. If installed later, schedule
   it once with `select cron.schedule('comm-housekeeping', '*/15 * * * *', 'select public.comm_housekeeping_all()');`.

Because read-time enforcement does not depend on the schedule, a late job only delays the physical purge, never the
expiry users see.

## Files

- `src/lib/communications.ts` — labels, safety wording, attachment checks, input schemas.
- `src/server/data/communications.ts` — loaders (return `null`/`undefined` when the migration is not installed).
- `src/app/(app)/communications/` — pages (`/communications`, `/c/[id]`, `/channels`, `/alerts`, `/alerts/[id]`,
  `/announcements`, `/announcements/[id]`, `/workspaces/new`, `/settings`), `actions.ts`, `files/` routes.
- `src/components/communications/` — UI components.
- `src/app/api/cron/comm-housekeeping/route.ts` and `src/server/cron.ts` — the scheduled job and its secret check.
- Tests: `tests/db/communications.test.ts`, `operational-workspaces.test.ts`, `operational-alerts.test.ts`,
  `comm-attachments.test.ts`, `comm-hardening.test.ts`, `tests/unit/communications.test.ts`, `cron.test.ts`,
  `tests/e2e/communications.spec.ts`.

## Not built (honest limits)

- Email, SMS or push notifications (in-app only; push would need a service and approval).
- Work schedules — so "Working hours" / "Outside working hours" are never shown.
- Joining a channel without being added; reactions; typing indicators; message forwarding.
- Cleanup of abandoned (never sent) uploads younger than 14 days: `public.abandoned_comm_attachments()` lists them for
  the service role; after 14 days they expire with everything else and the scheduled job removes their files.
- Escalation timing depends on the schedule above: daily on Vercel Hobby, every 15 minutes with pg_cron, or
  whenever someone uses Communications.
- Nav badges for unread messages outside the Communications pages.
