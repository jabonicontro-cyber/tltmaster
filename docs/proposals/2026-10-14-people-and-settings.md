# Proposal: one People list (merge Users into Employees) and a simpler Settings

Status: **approved 2026-10-14** (ticked by default; backfill yes; regroup yes) and built (master plan B45). One change
from the draft: new sign-ins get their record from the app when the sign-in is sent, not from a database trigger, so
demo seeds and imports that create a login and its record together keep working. Department for backfilled records
follows the role (there is no "Unassigned" department).

## Why

Today a person can exist twice: as a **user** (Settings → Users: a sign-in with a role) and as an **employee**
(Employees: job, department, driver record, time off, pay). Owners have to keep both in step, and a login without an
employee record has no job, time off or driver link. The owner asked for one place: the Employees page should create
users, and every employee should be a user.

## Proposed design

1. **Employees becomes "People"** (same URL, `/employees`). Each row shows a **Sign-in** column:
   - "Signs in · Dispatcher" (has a login; role shown), "Invited" (waiting for them to set a password), or
     "No sign-in · Invite" (button).
2. **Adding a person** asks for the work email and a role, with "Send them a Taviron sign-in" **ticked by default**.
   - The invitation email is the only email sent; in demo companies it is simulated, as today.
   - People without an email (for example a seasonal yard hand) are still added, marked "No sign-in". They can be
     invited later.
3. **Every existing login gets an employee record** (a one-time database update): name and email from the account,
   department "Unassigned" for anyone not already linked. Nothing is deleted.
4. **Role and access** move onto the person's page ("Access" tab: role, active, deactivate sign-in). Settings →
   Permissions keeps the role matrix (what each role can do).
5. **Settings → Users is removed**, and it redirects to People.

## Settings, regrouped (10 tabs → 4 groups)

| Group | Contains |
| --- | --- |
| Company | Company details and branding, numbering, email |
| Operations | Dispatch rules (document rules, yard location), time off (approval chain) |
| Access | Roles and permissions |
| System | Sample data, audit log |

"My account" moves to the profile menu, which already has My profile.

## What it needs

- One migration: the backfill in item 3, plus a unique link between an employee and a login (already modelled by
  `employees.user_id`). It goes through `db push` like the others, with a rollback.
- No new service. Invitations use the existing invite path, and demos never send.

## Questions for the owner

1. Is **"Send them a sign-in" ticked by default** right? The alternative is unticked, so the owner decides per person.
2. May the one-time update **create employee records for existing logins** (item 3)?
3. Should the Settings regrouping go ahead at the same time?
