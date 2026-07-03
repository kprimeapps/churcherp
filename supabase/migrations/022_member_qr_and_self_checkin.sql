-- ChurchOS v2 — Migration 022: regenerable member QR codes + reverse self-check-in

-- ── 1) Allow a new check-in method for member-driven self check-in ───────────
alter table attendance drop constraint if exists attendance_check_in_method_check;
alter table attendance add constraint attendance_check_in_method_check
  check (check_in_method in ('manual','qr','import','qr_self'));

-- ── 2) ensure_member_qr: stable, regenerable QR id for a member ──────────────
-- Every member gets exactly one qr_registrations row (their permanent QR
-- identity). Regenerating a "lost" QR just re-renders this same id, so the
-- printed code is always the same for a given member.
create or replace function ensure_member_qr(p_member_id uuid, p_org_id uuid)
returns text language plpgsql security definer as $$
declare
  v_m  members%rowtype;
  v_id text;
begin
  if not auth_can_write('qr') then raise exception 'Not authorized'; end if;
  select * into v_m from members where id = p_member_id and org_id = p_org_id;
  if not found then raise exception 'Member not found'; end if;

  -- Already has a linked registration? Reuse it (deterministic).
  select id into v_id from qr_registrations
    where org_id = p_org_id and member_id = p_member_id limit 1;
  if v_id is not null then return v_id; end if;

  -- An unlinked self-registration that matches this member (phone/membership)?
  select id into v_id from qr_registrations
    where org_id = p_org_id and member_id is null
      and ( (v_m.phone is not null and v_m.phone <> '' and phone = v_m.phone)
         or (v_m.membership_no is not null and v_m.membership_no <> '' and membership_no = v_m.membership_no) )
    limit 1;
  if v_id is not null then
    update qr_registrations set member_id = p_member_id, imported = true where id = v_id;
    return v_id;
  end if;

  -- None yet — mint one. Falls back to reusing a same-name+phone row if the
  -- unique index trips (that row is then linked to this member).
  v_id := 'M' || upper(replace(gen_random_uuid()::text, '-', ''));
  insert into qr_registrations
    (id, org_id, first_name, last_name, phone, membership_no, role, imported, member_id)
  values
    (v_id, p_org_id, v_m.first_name, coalesce(v_m.last_name,''), v_m.phone,
     v_m.membership_no, coalesce(v_m.role,'General'), true, p_member_id)
  on conflict (org_id, lower(trim(first_name)), trim(coalesce(phone,'')))
    do update set member_id = p_member_id, imported = true
    returning id into v_id;
  return v_id;
end;
$$;
grant execute on function ensure_member_qr(uuid, uuid) to authenticated;

-- ── 3) self_check_in: member types their name + membership # after scanning ──
-- the church's posted QR. Resolves the member by membership number (space/
-- case-insensitive), dedupes per service+date, records attendance.
create or replace function self_check_in(
  p_org_id        uuid,
  p_name          text,
  p_membership_no text,
  p_service_date  date,
  p_service_type  text
) returns jsonb language plpgsql security definer as $$
declare
  v_member_id uuid;
  v_name text;
  v_mno  text;
  v_exists boolean;
begin
  v_name := trim(coalesce(p_name,''));
  v_mno  := nullif(upper(replace(trim(coalesce(p_membership_no,'')), ' ', '')), '');
  if v_name = '' then
    return jsonb_build_object('status','error','message','Please enter your name.');
  end if;

  -- Resolve member by normalized membership number
  if v_mno is not null then
    select id into v_member_id from members
      where org_id = p_org_id
        and upper(replace(coalesce(membership_no,''), ' ', '')) = v_mno
      limit 1;
  end if;

  -- Dedupe within the same service + date
  if v_member_id is not null then
    select exists(
      select 1 from attendance
      where org_id = p_org_id and service_date = p_service_date
        and service_type = p_service_type and member_id = v_member_id
    ) into v_exists;
  else
    select exists(
      select 1 from attendance
      where org_id = p_org_id and service_date = p_service_date
        and service_type = p_service_type and check_in_method = 'qr_self'
        and lower(guest_name) = lower(v_name)
    ) into v_exists;
  end if;

  if v_exists then
    return jsonb_build_object('status','duplicate','name',v_name,'member_id',v_member_id);
  end if;

  if v_member_id is not null then
    insert into attendance (org_id, member_id, service_date, service_type, check_in_method)
    values (p_org_id, v_member_id, p_service_date, p_service_type, 'qr_self');
  else
    insert into attendance (org_id, guest_name, service_date, service_type, check_in_method)
    values (p_org_id, v_name, p_service_date, p_service_type, 'qr_self');
  end if;

  return jsonb_build_object('status','ok','name',v_name,'member_id',v_member_id,'matched',v_member_id is not null);
end;
$$;
grant execute on function self_check_in(uuid, text, text, date, text) to anon, authenticated;
