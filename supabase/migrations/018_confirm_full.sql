-- ChurchOS v2 — Migration 018: secondary phone + full self-service field set
-- Adds members.phone2 and expands the confirmation RPCs to cover every member
-- field (all optional). Members can update repeatedly.

alter table members add column if not exists phone2 text;

-- ─── Find (3-way match, excludes deceased) — now returns the full field set ──
drop function if exists confirm_find_member(text, text, text, text);

create or replace function confirm_find_member(
  p_slug text, p_mno text, p_surname text, p_phone text
) returns table (
  id uuid, membership_no text, first_name text, last_name text, other_names text,
  phone text, phone2 text, email text, gender text, date_of_birth date,
  marital_status text, occupation text, employer text, employment_type text,
  residence text, detailed_residence text,
  baptised boolean, baptism_date date, baptism_place text,
  communicant boolean, confirmed boolean, confirmation_date date, confirmation_place text,
  date_joined date, member_confirmed boolean
) language plpgsql security definer as $$
declare v_org uuid;
begin
  select o.id into v_org from organizations o where o.slug = p_slug and o.is_active;
  if v_org is null then return; end if;
  return query
    select m.id, m.membership_no, m.first_name, m.last_name, m.other_names,
           m.phone, m.phone2, m.email, m.gender, m.date_of_birth,
           m.marital_status, m.occupation, m.employer, m.employment_type,
           m.residence, m.detailed_residence,
           m.baptised, m.baptism_date, m.baptism_place,
           m.communicant, m.confirmed, m.confirmation_date, m.confirmation_place,
           m.date_joined, m.member_confirmed
    from members m
    where m.org_id = v_org
      and coalesce(m.is_active, true) = true
      and norm_mno(m.membership_no) = norm_mno(p_mno)
      and lower(trim(m.last_name)) = lower(trim(p_surname))
      and ( norm_phone(m.phone) = norm_phone(p_phone)
            or norm_phone(m.phone2) = norm_phone(p_phone)
            or coalesce(m.phone,'') = '' );
end;
$$;
grant execute on function confirm_find_member(text, text, text, text) to anon, authenticated;

-- ─── Update — all fields optional (only overwrite when a value is supplied) ──
create or replace function confirm_update_member(p_id uuid, p_slug text, p_data jsonb)
returns void language plpgsql security definer as $$
declare v_org uuid;
begin
  select o.id into v_org from organizations o where o.slug = p_slug and o.is_active;
  if v_org is null then raise exception 'Organization not found'; end if;
  if not exists (select 1 from members where id = p_id and org_id = v_org
                 and coalesce(is_active, true) = true) then
    raise exception 'Member not found';
  end if;
  update members set
    first_name         = coalesce(p_data->>'first_name', first_name),
    last_name          = coalesce(p_data->>'last_name', last_name),
    other_names        = coalesce(p_data->>'other_names', other_names),
    phone              = coalesce(p_data->>'phone', phone),
    phone2             = coalesce(p_data->>'phone2', phone2),
    email              = coalesce(p_data->>'email', email),
    gender             = coalesce(p_data->>'gender', gender),
    date_of_birth      = coalesce(nullif(p_data->>'date_of_birth','')::date, date_of_birth),
    marital_status     = coalesce(p_data->>'marital_status', marital_status),
    occupation         = coalesce(p_data->>'occupation', occupation),
    employer           = coalesce(p_data->>'employer', employer),
    employment_type    = coalesce(p_data->>'employment_type', employment_type),
    residence          = coalesce(p_data->>'residence', residence),
    detailed_residence = coalesce(p_data->>'detailed_residence', detailed_residence),
    baptised           = coalesce((nullif(p_data->>'baptised',''))::boolean, baptised),
    baptism_date       = coalesce(nullif(p_data->>'baptism_date','')::date, baptism_date),
    baptism_place      = coalesce(p_data->>'baptism_place', baptism_place),
    communicant        = coalesce((nullif(p_data->>'communicant',''))::boolean, communicant),
    confirmed          = coalesce((nullif(p_data->>'confirmed',''))::boolean, confirmed),
    confirmation_date  = coalesce(nullif(p_data->>'confirmation_date','')::date, confirmation_date),
    confirmation_place = coalesce(p_data->>'confirmation_place', confirmation_place),
    member_confirmed   = true,
    confirmed_at       = now(),
    updated_at         = now()
  where id = p_id and org_id = v_org;
  perform link_qr_registrations(v_org);
end;
$$;
grant execute on function confirm_update_member(uuid, text, jsonb) to anon, authenticated;
