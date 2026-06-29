-- ChurchOS v2 — Migration 020: Missions Coordinator gains Visitors + lesson editing

-- Add 'visitors' to the Missions Coordinator's write scope.
create or replace function auth_can_write(p_module text)
returns boolean language sql stable as $$
  select case
    when auth_user_role() in
         ('owner','admin','pastor','district_admin','presbytery_admin','national_admin')
      then true
    when auth_user_role() = 'staff' then p_module in
         ('members','attendance','groups','volunteers','visitors','family','comms',
          'events','welfare','education','missions','scholarship','qr')
    when auth_user_role() = 'finance_team'         then p_module in ('giving','expenses','finance')
    when auth_user_role() = 'usher'                then p_module = 'attendance'
    when auth_user_role() = 'missions_coordinator' then p_module in ('missions','visitors')
    when auth_user_role() = 'education_coordinator' then p_module in ('education','scholarship')
    when auth_user_role() = 'welfare_coordinator'  then p_module = 'welfare'
    when auth_user_role() = 'counsellor'           then p_module = 'family'
    else false
  end;
$$;

-- Scoped editing of newcomer lessons (anyone who can write 'visitors'),
-- so non-admins (e.g. Missions Coordinator) can manage the lesson list without
-- broad access to organization settings.
create or replace function set_newcomer_lessons(p_org_id uuid, p_lessons jsonb, p_optional jsonb)
returns void language plpgsql security definer as $$
begin
  if not auth_can_write('visitors') then raise exception 'Not authorized'; end if;
  if (select org_id from profiles where id = auth.uid()) is distinct from p_org_id then
    raise exception 'Wrong organization';
  end if;
  update organizations set settings =
    coalesce(settings, '{}'::jsonb)
    || jsonb_build_object('lists',
         coalesce(settings->'lists', '{}'::jsonb)
         || jsonb_build_object('newcomer_lessons', p_lessons,
                               'newcomer_optional_lessons', p_optional))
  where id = p_org_id;
end;
$$;
grant execute on function set_newcomer_lessons(uuid, jsonb, jsonb) to authenticated;
