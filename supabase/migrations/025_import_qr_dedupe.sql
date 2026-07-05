-- ChurchOS v2 — Migration 025: make "Import to Members" dedupe-aware
-- Previously import_qr_registration always INSERTed a new member, which created
-- a duplicate (with the QR's mis-formatted membership #) when the registrant was
-- already a legacy member. Now: if an existing member matches by normalized
-- phone or membership number, LINK to them and keep the legacy record untouched
-- (legacy membership # wins). Only insert a brand-new member when there's no
-- match. Safe/idempotent — never overwrites existing member data.

create or replace function import_qr_registration(p_reg_id text, p_org_id uuid)
returns uuid language plpgsql security definer as $$
declare
  v_reg       qr_registrations%rowtype;
  v_member_id uuid;
begin
  select * into v_reg from qr_registrations where id = p_reg_id and org_id = p_org_id;
  if not found then raise exception 'Registration not found'; end if;
  if v_reg.imported then raise exception 'Already imported'; end if;

  -- 1) Already linked (e.g. via "Match to Members")? Just mark imported.
  if v_reg.member_id is not null then
    update qr_registrations set imported = true where id = p_reg_id;
    return v_reg.member_id;
  end if;

  -- 2) Find an existing member by normalized membership # or phone.
  select m.id into v_member_id
    from members m
   where m.org_id = p_org_id
     and ( (nullif(norm_mno(v_reg.membership_no),'')   = norm_mno(m.membership_no))
        or (nullif(norm_phone(v_reg.phone),'')         = norm_phone(m.phone)) )
   limit 1;

  -- 3) Match found → link only; keep the legacy record (and its membership #) intact.
  if v_member_id is not null then
    update qr_registrations set imported = true, member_id = v_member_id where id = p_reg_id;
    return v_member_id;
  end if;

  -- 4) No match → this is a genuinely new person; insert them.
  insert into members (org_id, first_name, last_name, phone, membership_no, role)
  values (p_org_id, v_reg.first_name, coalesce(v_reg.last_name,''), v_reg.phone,
          v_reg.membership_no, v_reg.role)
  returning id into v_member_id;

  update qr_registrations set imported = true, member_id = v_member_id where id = p_reg_id;
  return v_member_id;
end;
$$;
