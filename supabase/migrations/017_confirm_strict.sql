-- ChurchOS v2 — Migration 017: stricter confirmation match + exclude deceased
-- Requires membership number + surname + phone to view a record, and never
-- exposes members marked deceased (is_active = false).

drop function if exists confirm_find_member(text, text);

create or replace function confirm_find_member(
  p_slug text, p_mno text, p_surname text, p_phone text
) returns table (
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
      and coalesce(m.is_active, true) = true                       -- exclude deceased
      and norm_mno(m.membership_no) = norm_mno(p_mno)
      and lower(trim(m.last_name)) = lower(trim(p_surname))
      and ( norm_phone(m.phone) = norm_phone(p_phone)              -- phone must match
            or coalesce(m.phone,'') = '' )                         -- unless none on file
    limit 5;
end;
$$;
grant execute on function confirm_find_member(text, text, text, text) to anon, authenticated;

-- Don't let a deceased record be updated via the portal either.
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
