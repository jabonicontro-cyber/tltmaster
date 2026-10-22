-- Rollback of 20261120001700_command_center_base_scope.sql. Not destructive (no data), but a SECURITY change: people
-- limited to some dispatch bases see every base's Command Center items again. Run with psql -v ON_ERROR_STOP=1 -1 -f.

drop function private.operational_exceptions(uuid);
alter function private.operational_exceptions_all(uuid) rename to operational_exceptions;
