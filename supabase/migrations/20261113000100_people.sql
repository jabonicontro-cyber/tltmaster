-- People: every login is an employee (owner 2026-10-14, docs/proposals/2026-10-14-people-and-settings.md).
--
-- One-time backfill: each existing login (company membership) without an employee record gets one in that company,
-- or is linked to an unlinked record with the same work email. Name and email come from the profile; department from
-- the role. Username sign-ins carry an internal address that is never a contact address, so it is not copied.
-- Platform owners who joined a demo company as presenters are not its staff and are skipped. Nothing is deleted.
--
-- New sign-ins get their record from the app when they are sent (People: add person, Send a sign-in, Invite user),
-- not from a trigger, so seeds and imports that create both a login and its record keep working unchanged.

do $$
declare
  r       record;
  v_email text;
  v_emp   uuid;
begin
  for r in
    select m.company_id, m.user_id, m.role::text as role, m.active,
           lower(trim(coalesce(p.email, ''))) as email, trim(coalesce(p.full_name, '')) as full_name
    from public.company_memberships m
    join public.profiles p on p.id = m.user_id
    where not exists (select 1 from public.employees e where e.company_id = m.company_id and e.user_id = m.user_id)
      and not (exists (select 1 from private.platform_admins a where a.user_id = m.user_id and a.revoked_at is null)
               and exists (select 1 from public.companies c where c.id = m.company_id and c.is_demo))
    order by m.created_at
  loop
    v_email := case when r.email like '%@users.mytaviron.com' then '' else r.email end;
    v_emp := null;
    if v_email <> '' then
      select e.id into v_emp from public.employees e
      where e.company_id = r.company_id and e.user_id is null and lower(trim(e.work_email)) = v_email
      order by e.created_at limit 1;
    end if;
    if v_emp is not null then
      update public.employees set user_id = r.user_id, updated_at = now() where id = v_emp;
    else
      insert into public.employees (company_id, user_id, full_name, department, status, work_email)
      values (
        r.company_id, r.user_id,
        left(coalesce(nullif(r.full_name, ''), nullif(split_part(r.email, '@', 1), ''), 'New person'), 120),
        case r.role when 'dispatcher' then 'dispatch' when 'mechanic' then 'shop' when 'office' then 'office'
                    when 'owner' then 'management' else 'operations' end,
        case when r.active then 'active' else 'inactive' end,
        left(v_email, 200))
      returning id into v_emp;
    end if;
    -- A driver record already linked to this login joins the employee record when free.
    update public.employees e set driver_id = d.id
    from public.drivers d
    where e.id = v_emp and e.driver_id is null and d.company_id = r.company_id and d.user_id = r.user_id
      and not exists (select 1 from public.employees x where x.company_id = r.company_id and x.driver_id = d.id);
  end loop;
end;
$$;
