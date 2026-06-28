-- ChurchOS v2 — Migration 016: legacy member fields + self-service confirmation
-- Adds the fields the legacy register carries, a member-confirmation flow, and
-- QR-registration → member matching (phone / membership number).

-- ─── New member fields ───────────────────────────────────────────────────────
alter table members
  add column if not exists other_names        text,
  add column if not exists marital_status     text,
  add column if not exists residence          text,
  add column if not exists detailed_residence text,
  add column if not exists communicant        boolean,
  add column if not exists member_confirmed   boolean not null default false,
  add column if not exists confirmed_at        timestamptz;

-- One membership number per org (lets the import upsert safely; nulls allowed)
create unique index if not exists idx_members_org_mno
  on members (org_id, membership_no);

-- ─── Normalisers (membership no has no space in legacy, a space in QR data) ──
create or replace function norm_mno(p text)
returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p,''), '\s', '', 'g'));
$$;
create or replace function norm_phone(p text)
returns text language sql immutable as $$
  -- last 9 digits, ignoring 0 / +233 country-code differences
  select right(regexp_replace(coalesce(p,''), '\D', '', 'g'), 9);
$$;

-- ─── Link QR registrations to members (by phone or membership no) ───────────
create or replace function link_qr_registrations(p_org_id uuid)
returns integer language plpgsql security definer as $$
declare n integer;
begin
  with upd as (
    update qr_registrations q
       set member_id = m.id
      from members m
     where q.org_id = p_org_id and m.org_id = p_org_id and q.member_id is null
       and (
         (nullif(norm_phone(q.phone),'') = norm_phone(m.phone))
         or (nullif(norm_mno(q.membership_no),'') = norm_mno(m.membership_no))
       )
    returning 1)
  select count(*) into n from upd;
  return n;
end;
$$;
grant execute on function link_qr_registrations(uuid) to authenticated;

-- ─── Self-service confirmation (anon, scoped by org slug) ────────────────────
-- Find a member by membership number OR phone, within one org.
create or replace function confirm_find_member(p_slug text, p_query text)
returns table (
  id uuid, membership_no text, first_name text, last_name text, other_names text,
  phone text, email text, gender text, date_of_birth date, marital_status text,
  occupation text, employment_type text, residence text, detailed_residence text,
  baptised boolean, communicant boolean, member_confirmed boolean
) language plpgsql security definer as $$
declare v_org uuid;
begin
  select o.id into v_org from organizations o where o.slug = p_slug and o.is_active;
  if v_org is null then return; end if;
  return query
    select m.id, m.membership_no, m.first_name, m.last_name, m.other_names,
           m.phone, m.email, m.gender, m.date_of_birth, m.marital_status,
           m.occupation, m.employment_type, m.residence, m.detailed_residence,
           m.baptised, m.communicant, m.member_confirmed
    from members m
    where m.org_id = v_org
      and ( norm_mno(m.membership_no) = norm_mno(p_query)
            or (nullif(norm_phone(p_query),'') = norm_phone(m.phone)) )
    order by m.member_confirmed, m.last_name
    limit 10;
end;
$$;
grant execute on function confirm_find_member(text, text) to anon, authenticated;

-- Member updates their own record (allowed fields only), marks it confirmed,
-- and links any matching QR registration.
create or replace function confirm_update_member(p_id uuid, p_slug text, p_data jsonb)
returns void language plpgsql security definer as $$
declare v_org uuid;
begin
  select o.id into v_org from organizations o where o.slug = p_slug and o.is_active;
  if v_org is null then raise exception 'Organization not found'; end if;
  if not exists (select 1 from members where id = p_id and org_id = v_org) then
    raise exception 'Member not found';
  end if;
  update members set
    first_name         = coalesce(p_data->>'first_name', first_name),
    last_name          = coalesce(p_data->>'last_name', last_name),
    other_names        = coalesce(p_data->>'other_names', other_names),
    phone              = coalesce(p_data->>'phone', phone),
    email              = coalesce(p_data->>'email', email),
    gender             = coalesce(p_data->>'gender', gender),
    date_of_birth      = coalesce(nullif(p_data->>'date_of_birth','')::date, date_of_birth),
    marital_status     = coalesce(p_data->>'marital_status', marital_status),
    occupation         = coalesce(p_data->>'occupation', occupation),
    employment_type    = coalesce(p_data->>'employment_type', employment_type),
    residence          = coalesce(p_data->>'residence', residence),
    detailed_residence = coalesce(p_data->>'detailed_residence', detailed_residence),
    member_confirmed   = true,
    confirmed_at       = now(),
    updated_at         = now()
  where id = p_id and org_id = v_org;
  perform link_qr_registrations(v_org);
end;
$$;
grant execute on function confirm_update_member(uuid, text, jsonb) to anon, authenticated;
