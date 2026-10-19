-- Rollback of 20261119000200_command_center_urgent_breakdown: removes the per-kind urgent counts. Not destructive
-- (a read-only function); the Command Center then shows the plain urgent total again (src/server/data/command-center.ts).
drop function if exists public.command_center_urgent_by_kind();
