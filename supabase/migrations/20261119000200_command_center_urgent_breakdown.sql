-- =============================================================================
-- Command Center: urgent items by category (2026-10-19; owner report "duplicate urgent indicator").
--
-- The status strip showed "N urgent" (every priority-1 item) and, separately, "N urgent orders" (every urgent-order
-- item) — the same unacknowledged urgent order was counted in both. public.command_center_urgent_by_kind() returns
-- the priority-1 items per kind with exactly the summary's rules (company, the kinds this person may see), so the
-- strip can show one indicator whose parts add up to the urgent total. Urgent items cannot be hidden, so there is no
-- hidden filter. Read-only.
-- Rollback: drop function public.command_center_urgent_by_kind();
-- =============================================================================
create or replace function public.command_center_urgent_by_kind()
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_command_center();
  v_kinds   text[] := private.visible_exception_kinds();
begin
  return (select coalesce(jsonb_object_agg(kind, n), '{}')
          from (select e.kind, count(*)::int as n
                from private.operational_exceptions(v_company) e
                where e.kind = any (v_kinds) and e.priority = 1
                group by e.kind) k);
end;
$$;
revoke all on function public.command_center_urgent_by_kind() from public, anon;
grant execute on function public.command_center_urgent_by_kind() to authenticated;
