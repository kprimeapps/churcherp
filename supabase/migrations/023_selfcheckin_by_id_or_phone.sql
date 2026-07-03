-- ChurchOS v2 — Migration 023: self check-in identifies by membership # OR phone
-- (replaces the name+membership version from 022). If neither resolves to a
-- known member we do NOT record a nameless guest — we ask them to see a steward.

drop function if exists self_check_in(uuid, text, text, date, text);

create or replace function self_check_in(
  p_org_id        uuid,
  p_membership_no text,
  p_phone         text,
  p_service_date  date,
  p_service_type  text
) returns jsonb language plpgsql security definer as $$
declare
  v_member_id uuid;
  v_name  text;
  v_mno   text;
  v_phone text;
  v_exists boolean;
begin
  v_mno   := nullif(upper(replace(trim(coalesce(p_membership_no,'')), ' ', '')), '');
  -- keep digits only; match on the last 9 (handles +233 / 0-prefix variations)
  v_phone := nullif(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), '');

  if v_mno is null and v_phone is null then
    return jsonb_build_object('status','error','message','Enter your membership number or phone number.');
  end if;

  -- Resolve member by normalized membership number, then by phone
  if v_mno is not null then
    select id, trim(first_name || ' ' || coalesce(last_name,''))
      into v_member_id, v_name
      from members
      where org_id = p_org_id
        and upper(replace(coalesce(membership_no,''), ' ', '')) = v_mno
      limit 1;
  end if;
  if v_member_id is null and v_phone is not null then
    select id, trim(first_name || ' ' || coalesce(last_name,''))
      into v_member_id, v_name
      from members
      where org_id = p_org_id
        and length(regexp_replace(coalesce(phone,''), '\D', '', 'g')) >= 9
        and right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 9) = right(v_phone, 9)
      limit 1;
  end if;

  if v_member_id is null then
    return jsonb_build_object('status','unknown');
  end if;

  -- Dedupe within the same service + date
  select exists(
    select 1 from attendance
    where org_id = p_org_id and service_date = p_service_date
      and service_type = p_service_type and member_id = v_member_id
  ) into v_exists;
  if v_exists then
    return jsonb_build_object('status','duplicate','name',v_name);
  end if;

  insert into attendance (org_id, member_id, service_date, service_type, check_in_method)
  values (p_org_id, v_member_id, p_service_date, p_service_type, 'qr_self');

  return jsonb_build_object('status','ok','name',v_name);
end;
$$;
grant execute on function self_check_in(uuid, text, text, date, text) to anon, authenticated;
