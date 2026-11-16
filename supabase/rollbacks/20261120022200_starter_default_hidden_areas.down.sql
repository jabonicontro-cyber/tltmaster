-- Rollback of 20261120022200_starter_default_hidden_areas.sql (not a migration; run by hand with a backup first).
-- New Starter companies then start with every area in the menu, as before. Menus already set stay as they are (they
-- are the company's own setting now; an owner changes them in Settings).
drop trigger if exists z_starter_default_hidden_areas on private.company_lifecycle;
drop function if exists private.starter_default_hidden_areas();
