# Incidents: what to do when Taviron breaks

Master plan §12 LR4. Written 2026-11-14 for Top Line's testing from 2026-12-01. One page to follow when an alert
arrives or someone says "Taviron isn't working". Plain steps first; the details behind them are linked.

Live address: **https://www.mytaviron.com** (owner decision 2026-11-14; `tltmaster.vercel.app` serves the same
deployment). Production branch: `claude/top-line-trucking-manager-vmw04i` (CLAUDE.md, Workflow).

## 1. Who looks

| Alert or report | Goes to | Who acts |
| --- | --- | --- |
| **UptimeRobot** "Down" for `/api/health` (checked every 5 minutes, docs/LAUNCH.md §4) | The owner's email and phone app | The owner opens a Claude Code session (or this chat) and pastes the alert; Claude works through §2 |
| **Sentry** "new issue" email (server errors, personal details removed, `src/lib/monitoring/sentry.ts`) | The owner's email | Same: the owner forwards the issue title and link to a Claude session |
| **GitHub** email: a failed "Database migrations (Production)" or "CI" run | The owner's email | Claude reads the run (needs the GitHub connector in that session) |
| Someone at Top Line (office or a driver) says something is wrong | The owner, by phone or in person | The owner writes down what they saw (page, time, the exact message), then a Claude session |

Claude does not watch alerts by itself between sessions. The daily scheduled check (6:47 Central, SESSION_HANDOFF)
runs once a day; it is not an alarm. Until a session is open, the owner is the person on call.

How bad is it (decides how fast and whether Top Line switches to paper):

| Level | Examples | Response |
| --- | --- | --- |
| **Down** | `/api/health` answers 503 or does not answer; nobody can sign in | Now. Top Line uses its paper method until it is back (§5). |
| **Broken** | One main workflow fails for everyone: dispatch, My Day, tickets, invoices | Same day. Workaround on paper for that workflow. |
| **Wrong data or security** | Someone sees another company's records; money figures wrong; a person has access they should not | Now. Stop and tell the owner; nothing is "fixed" by deleting data. |
| **Minor** | A label, layout or one person's edge case | Next normal release (DEVELOPMENT_WORKFLOW §4a). |

## 2. First checks (in this order, about 10 minutes)

1. **Health check:** open https://www.mytaviron.com/api/health. It answers with no customer data:
   `{"ok":true,"app":"ok","sign_in":"ok","database":"ok",...}` when everything answers (`src/app/api/health/route.ts`).
   - No answer at all or a Vercel error page: the hosting is the problem (step 2).
   - `"sign_in":"down"` or `"database":"down"` (status 503): Supabase is the problem (step 3).
   - All `ok` but people still have trouble: a page or feature is broken (step 4).
   From a computer with the repository, `node scripts/check-deployment.mjs https://www.mytaviron.com` also checks
   that the gate is in place and the public pages answer.
2. **Vercel:** dashboard → the project → **Deployments**. Is the deployment marked *Current* for Production *Ready*?
   When did it change? A push or a promotion just before the problem started is the first suspect. Also check
   https://www.vercel-status.com.
3. **Supabase:** https://status.supabase.com, then the project dashboard (taviron-staging serves Production): is the
   project running (a free-plan project pauses after a week without use; Pro does not), and do **Logs** show errors?
4. **GitHub Actions:** did "Database migrations (Production)" run just before (a new migration) or fail? Its summary
   lists the migrations it applied.
5. **Sentry:** the issue shows the route, the time it started and the release (the commit). Many errors starting at
   one release point at that release.

Write down what you found (§6) before changing anything.

## 3. Fix or roll back

**Roll back the app (fastest, no code):** Vercel → Deployments → the last Production deployment that worked →
**Instant Rollback** (also shown as Promote). The live address moves back within a minute. Notes:
- The database is not rolled back. That is safe: migrations only add things and each one works with the code before
  it (CLAUDE.md, Migrations; DEPLOYMENT §5).
- Vercel's free plan may allow rolling back only to the previous deployment; Pro allows earlier ones.
- After a rollback Vercel stops moving the live address to new pushes until someone promotes a deployment again.
  When the fix ships, check which deployment is *Current* and promote the fixed one if needed.
- Never force-push or rewrite the Production branch to "undo" a release. The branch only moves forward
  (fast-forward); a rollback is done in Vercel, and the fix comes as a new commit.

**Fix forward (the usual way):** the hotfix rule in CLAUDE.md ("Autonomous fixes", owner 2026-11-09). For a security
risk or a bug that stops something working on the live site, Claude may ship the smallest fix without asking first,
only if all of these hold: a branch `claude/hotfix-<date>-<slug>` from the Production branch; lint, typecheck and unit
tests pass; CI green on that commit (with the full browser suite when app code changed) and its Preview deployment
succeeded; Production fast-forwarded to it (never forced); the fix merged into the development branch with a merge
commit; the live site checked afterwards (health check and the path that was broken); the owner notified (what broke,
the fix, how it was verified). **Not covered, still the owner's call:** any migration, environment variables or secrets,
DNS and domains, paid services, changes to data, deleting anything, people, roles or permissions, and weakening or
skipping a test. If a condition fails, Claude does not promote and sends the owner the finding and the proposed fix.

**A migration caused it:** every migration has a tested rollback script in `supabase/rollbacks/`. Running one on the
hosted database is a database change: the owner approves it each time, and the backup the workflow made before the
migration is kept for 14 days (§4).

**Supabase or Vercel itself is down:** nothing to fix in Taviron. Follow their status page, tell Top Line (§5), and
record the times.

## 4. When to restore a backup

Only when data is lost or damaged and cannot be put right with a normal correction (a bad migration or a mass update
removed or overwrote records). A wrong value on a few records is corrected in the app, with history, not by a restore.

1. Never restore over Production first. Restore into a copy (docs/BACKUP_RESTORE.md, "Restore drill"), find the
   records that were lost, and decide with the owner how to bring them back.
2. Restoring over Production replaces everything entered after the backup was taken (tickets, orders, payments from
   that day). It is the owner's decision, each time.
3. Backups that exist: the encrypted copy the migration workflow makes before each release with migrations
   (`backup-*.dump.gpg`, kept 14 days, GitHub → Actions → the run → Artifacts) and, after the Supabase Pro upgrade,
   Supabase's daily backups (7 days; Database → Backups). Photos and attachments in Storage are not in either.

## 5. Telling Top Line

Top Line is the owner's own company, so the owner tells its people directly, the way they normally reach each other
(phone or their usual group text). Taviron does not send texts or emails about incidents.

- **Down or Broken:** tell the office and the drivers on shift: what does not work, what to do instead (paper tickets
  and the paper dispatch sheet, as before December), and that you will say when it is back. Drivers keep the paper
  ticket for every load anyway (My Day says so).
- **While the app still works** (for example one page is broken): an announcement in Communications reaches everyone
  in the company.
- **Back to normal:** say so, and ask the office to enter anything done on paper meanwhile (tickets, loads). Drivers'
  phones send what they saved offline by themselves once they have signal (docs/COMPANION_APP.md §4).
- **Wrong data or security:** the owner decides who is told and what. Write down which records and people were
  affected.

From January, with outside customers, this section needs a customer notice procedure (who is told, how fast, by
whom); that is an open question in docs/LEGAL_REVIEW_PACKET.md §12 (breach notification).

## 6. The record to keep

Every incident, even a short one, gets a row below (newest first), written by the Claude session that handled it and
checked by the owner. Lasting risks also go to master plan §8.

| Started (Central) | Ended | Level | How it was noticed | What people saw | Cause | What was done (commit, rollback, migration) | Data affected | Top Line told | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | No incidents recorded yet. | — | — | — | — | — |

Keep times to the minute, link the Sentry issue, the Vercel deployment and the GitHub run, and say plainly what was
verified afterwards ("health check ok, ticket entry checked on a phone") and what was not.
