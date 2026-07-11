-- ChurchOS v2 — Migration 027: Group Secretary role + scoped meeting-count entry
-- A group secretary (e.g. YPG, YAF, MF, WF) can only record/update their own
-- group's meeting attendance COUNT. They never touch church-wide attendance.
-- Counts land in attendance_summaries so they show up in the admin views.

-- 1) Register the new role + tie a profile to one group.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in (
  'owner','admin','pastor','staff','viewer',
  'finance_team','usher','missions_coordinator','education_coordinator',
  'welfare_coordinator','counsellor','group_secretary',
  'district_admin','presbytery_admin','national_admin'
));
alter table profiles add column if not exists group_name text;

-- 2) Assign role + group in one call (owner/admin only). Overloads the existing
--    2-arg set_user_role; group_name is only kept for group_secretary.
create or replace function set_user_role(p_user_id uuid, p_role text, p_group text)
returns void language plpgsql security definer as $$
declare v_caller_role text; v_caller_org uuid; v_target_org uuid;
begin
  select role, org_id into v_caller_role, v_caller_org from profiles where id = auth.uid();
  if v_caller_role not in ('owner','admin') then raise exception 'Not authorized to change roles'; end if;
  select org_id into v_target_org from profiles where id = p_user_id;
  if v_target_org is distinct from v_caller_org then raise exception 'User belongs to a different organization'; end if;
  update profiles
     set role = p_role,
         group_name = case when p_role = 'group_secretary' then nullif(trim(p_group),'') else null end,
         updated_at = now()
   where id = p_user_id;
end;
$$;
grant execute on function set_user_role(uuid, text, text) to authenticated;

-- 3) Scoped upsert of a group's meeting count. Allowed for full-access roles or
--    a group_secretary editing THEIR assigned group. Writes to attendance_summaries.
create or replace function record_group_attendance(
  p_group_name text, p_date date, p_count int,
  p_male int default 0, p_female int default 0, p_children int default 0, p_notes text default null
) returns jsonb language plpgsql security definer as $$
declare
  v_role text; v_org uuid; v_group text; v_id uuid;
begin
  select role, org_id, group_name into v_role, v_org, v_group from profiles where id = auth.uid();
  if v_org is null then raise exception 'No organization'; end if;

  if v_role = 'group_secretary' then
    if v_group is distinct from p_group_name then raise exception 'You can only record for your own group'; end if;
  elsif v_role not in ('owner','admin','pastor','district_admin','presbytery_admin','national_admin','staff') then
    raise exception 'Not authorized';
  end if;
  if coalesce(trim(p_group_name),'') = '' then raise exception 'Group is required'; end if;
  if p_count < 0 then raise exception 'Count cannot be negative'; end if;

  -- One row per group per date (service_type 'Group Meeting'); update if present.
  select id into v_id from attendance_summaries
   where org_id = v_org and summary_date = p_date
     and service_type = 'Group Meeting' and group_name = p_group_name
   limit 1;

  if v_id is not null then
    update attendance_summaries
       set total_count = p_count, male_count = coalesce(p_male,0),
           female_count = coalesce(p_female,0), children_count = coalesce(p_children,0),
           notes = p_notes
     where id = v_id;
  else
    insert into attendance_summaries
      (org_id, summary_date, service_type, group_name, total_count, male_count, female_count, children_count, notes)
    values
      (v_org, p_date, 'Group Meeting', p_group_name, p_count, coalesce(p_male,0),
       coalesce(p_female,0), coalesce(p_children,0), p_notes)
    returning id into v_id;
  end if;

  return jsonb_build_object('status','ok','id',v_id);
end;
$$;
grant execute on function record_group_attendance(text, date, int, int, int, int, text) to authenticated;
