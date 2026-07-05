-- ChurchOS v2 — Migration 026: prefer membership-number match over phone, and
-- drop matched registrations from the Pending Import list.
--
-- Changes vs 016/025:
--   * Matching now tries membership number FIRST, phone only as a fallback
--     (avoids attaching to the wrong person when family members share a phone).
--   * A successful match sets imported = true, so it leaves "Pending Import".
--   * link_qr_registrations also clears any rows a previous run had linked but
--     left pending (imported = false with a member_id) — e.g. the ~32 already
--     matched under the old behavior.

-- ── "Match to Members" — bulk link, membership-first, clears pending ──────────
create or replace function link_qr_registrations(p_org_id uuid)
returns integer language plpgsql security definer as $$
declare n1 int; n2 int; n3 int;
begin
  -- (a) Retire rows already linked by an earlier run but still marked pending.
  update qr_registrations
     set imported = true
   where org_id = p_org_id and member_id is not null and imported = false;
  get diagnostics n1 = row_count;

  -- (b) Match unlinked rows by membership number (deterministic: oldest member).
  update qr_registrations q
     set member_id = sub.mid, imported = true
    from (
      select q2.id qid,
             ( select m.id from members m
                where m.org_id = p_org_id
                  and nullif(norm_mno(q2.membership_no),'') = norm_mno(m.membership_no)
                order by m.created_at limit 1 ) mid
        from qr_registrations q2
       where q2.org_id = p_org_id and q2.member_id is null
    ) sub
   where q.id = sub.qid and sub.mid is not null;
  get diagnostics n2 = row_count;

  -- (c) Match still-unlinked rows by phone.
  update qr_registrations q
     set member_id = sub.mid, imported = true
    from (
      select q2.id qid,
             ( select m.id from members m
                where m.org_id = p_org_id
                  and nullif(norm_phone(q2.phone),'') = norm_phone(m.phone)
                order by m.created_at limit 1 ) mid
        from qr_registrations q2
       where q2.org_id = p_org_id and q2.member_id is null
    ) sub
   where q.id = sub.qid and sub.mid is not null;
  get diagnostics n3 = row_count;

  return n1 + n2 + n3;
end;
$$;
grant execute on function link_qr_registrations(uuid) to authenticated;

-- ── "Import to Members" — same membership-first priority ─────────────────────
create or replace function import_qr_registration(p_reg_id text, p_org_id uuid)
returns uuid language plpgsql security definer as $$
declare
  v_reg       qr_registrations%rowtype;
  v_member_id uuid;
begin
  select * into v_reg from qr_registrations where id = p_reg_id and org_id = p_org_id;
  if not found then raise exception 'Registration not found'; end if;
  if v_reg.imported and v_reg.member_id is not null then return v_reg.member_id; end if;

  -- Already linked? Just mark imported.
  if v_reg.member_id is not null then
    update qr_registrations set imported = true where id = p_reg_id;
    return v_reg.member_id;
  end if;

  -- Match an existing member: membership number FIRST, then phone.
  select m.id into v_member_id from members m
    where m.org_id = p_org_id
      and nullif(norm_mno(v_reg.membership_no),'') = norm_mno(m.membership_no)
    order by m.created_at limit 1;
  if v_member_id is null then
    select m.id into v_member_id from members m
      where m.org_id = p_org_id
        and nullif(norm_phone(v_reg.phone),'') = norm_phone(m.phone)
      order by m.created_at limit 1;
  end if;

  -- Match → link only, keep the legacy record (and its membership #) intact.
  if v_member_id is not null then
    update qr_registrations set imported = true, member_id = v_member_id where id = p_reg_id;
    return v_member_id;
  end if;

  -- No match → genuinely new person; insert.
  insert into members (org_id, first_name, last_name, phone, membership_no, role)
  values (p_org_id, v_reg.first_name, coalesce(v_reg.last_name,''), v_reg.phone,
          v_reg.membership_no, v_reg.role)
  returning id into v_member_id;
  update qr_registrations set imported = true, member_id = v_member_id where id = p_reg_id;
  return v_member_id;
end;
$$;
