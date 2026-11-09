-- Rollback of 20261120012400_inspection_document: removes maintenance_record_inspection. Certificates already recorded
-- stay on the vehicles (they are ordinary vehicle documents).
drop function if exists public.maintenance_record_inspection(uuid, jsonb);
