# Proposal: PostgreSQL JIT on hosted databases (decision for the owner)

**Status:** proposal only. Nothing here has been applied anywhere hosted. It is a hosted database setting, so it is
the owner's action (DEPLOYMENT §2a), and it is not a migration in `supabase/migrations/`.

## Why

On the local database (2026-10-13), the billing-readiness view behind the Command Center and Billing took 5.1 s per
query, of which **4.9 s was JIT compilation** (516 functions; 2.9 s optimisation, 1.9 s emission). With `jit = off`
the same query ran in **0.16 s**. JIT starts when PostgreSQL's cost estimate passes `jit_above_cost` (default
100 000); the large billing and Command Center views exceed it once a company has real data, even though they finish
quickly. Taviron's queries are short interactive ones that do not benefit from JIT.

Locally the setting is now off (`scripts/dev-stack/stack.sh` db-reset; SETUP §6).

## Check first (read-only)

In the Supabase SQL editor for each project (staging, production):

```sql
show jit;
select rolname, rolconfig from pg_roles where rolname in ('authenticated', 'anon', 'service_role', 'postgres');
```

If `jit` is `off` (or `rolconfig` for `authenticated` already contains `jit=off`), nothing needs to change.

## If it is on — the change (reversible)

```sql
-- The roles the app's requests run as. New connections pick it up.
alter role authenticated set jit = off;
alter role service_role set jit = off;
```

Rollback:

```sql
alter role authenticated reset jit;
alter role service_role reset jit;
```

## How to confirm the effect

Before and after, open the Command Center and Billing for a company with data and compare load times; or, in the SQL
editor as a test, `explain (analyze) select count(*) from public.billing_order_status;` and look for a `JIT:` section
(present = JIT ran).
