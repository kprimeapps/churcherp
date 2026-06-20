-- ChurchOS v2 — Migration 006: QR check-in member-link + dedupe RPC

-- 1) Link a registration to its imported member record
alter table qr_registrations
  add column if not exists member_id uuid references members(id) on delete set null;

-- 2) import_qr_registration now stamps member_id back onto the registration
create or replace function import_qr_registration(p_reg_id text, p_org_id uuid)
returns uuid language plpgsql security definer as $$
declare
  v_reg qr_registrations%rowtype;
  v_member_id uuid;
begin
  select * into v_reg from qr_registrations where id = p_reg_id and org_id = p_org_id;
  if not found then raise exception 'Registration not found'; end if;
  if v_reg.imported then raise exception 'Already imported'; end if;

  insert into members (org_id, first_name, last_name, phone, membership_no, role)
  values (p_org_id, v_reg.first_name, coalesce(v_reg.last_name,''), v_reg.phone, v_reg.membership_no, v_reg.role)
  returning id into v_member_id;

  update qr_registrations set imported = true, member_id = v_member_id where id = p_reg_id;
  return v_member_id;
end;
$$;

-- 3) Atomic QR check-in: resolve member, dedupe per service/day, insert attendance.
-- Returns: { status: 'ok'|'duplicate'|'unknown', name, role, member_id }
create or replace function qr_check_in(
  p_qr_id        text,
  p_org_id       uuid,
  p_service_date date,
  p_service_type text
) returns jsonb language plpgsql security definer as $$
declare
  v_reg       qr_registrations%rowtype;
  v_member_id uuid;
  v_name      text;
  v_exists    boolean;
begin
  select * into v_reg from qr_registrations where id = p_qr_id and org_id = p_org_id;
  if not found then
    return jsonb_build_object('status','unknown');
  end if;

  v_name := trim(v_reg.first_name || ' ' || coalesce(v_reg.last_name,''));

  -- Resolve the member: explicit link first, then phone, then membership number
  v_member_id := v_reg.member_id;
  if v_member_id is null and v_reg.phone is not null and v_reg.phone <> '' then
    select id into v_member_id from members
      where org_id = p_org_id and phone = v_reg.phone limit 1;
  end if;
  if v_member_id is null and v_reg.membership_no is not null and v_reg.membership_no <> '' then
    select id into v_member_id from members
      where org_id = p_org_id and membership_no = v_reg.membership_no limit 1;
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
        and service_type = p_service_type and check_in_method = 'qr'
        and guest_name = v_name
        and coalesce(guest_phone,'') = coalesce(v_reg.phone,'')
    ) into v_exists;
  end if;

  if v_exists then
    return jsonb_build_object('status','duplicate','name',v_name,'role',v_reg.role,'member_id',v_member_id);
  end if;

  if v_member_id is not null then
    insert into attendance (org_id, member_id, service_date, service_type, check_in_method)
    values (p_org_id, v_member_id, p_service_date, p_service_type, 'qr');
  else
    insert into attendance (org_id, guest_name, guest_phone, guest_role, service_date, service_type, check_in_method)
    values (p_org_id, v_name, v_reg.phone, v_reg.role, p_service_date, p_service_type, 'qr');
  end if;

  return jsonb_build_object('status','ok','name',v_name,'role',v_reg.role,'member_id',v_member_id);
end;
$$;

-- Scanner uses the anon key
grant execute on function qr_check_in(text, uuid, date, text) to anon, authenticated;
