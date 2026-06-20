-- ChurchOS v2 — Migration 010: enforce RBAC at the database level (RLS)
--
-- Reads stay org-scoped (any signed-in member can read their org's data, which
-- the UI further restricts by hiding pages). WRITES are gated by role to match
-- js/permissions.js. Org isolation is unchanged.

-- ─── Role → write capability (mirrors permissions.js) ───────────────────────
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
    when auth_user_role() = 'usher'                then p_module in ('attendance','qr')
    when auth_user_role() = 'missions_coordinator' then p_module = 'missions'
    when auth_user_role() = 'education_coordinator' then p_module in ('education','scholarship')
    when auth_user_role() = 'welfare_coordinator'  then p_module = 'welfare'
    when auth_user_role() = 'counsellor'           then p_module = 'family'
    else false   -- viewer / unknown: read-only
  end;
$$;

-- ─── Replace broad "for all" policies with read + role-gated write ───────────
do $$
declare rec record; p record;
begin
  for rec in
    select * from (values
      ('members','members'),
      ('attendance','attendance'),
      ('online_attendance','attendance'),
      ('groups','groups'),
      ('events','events'),
      ('volunteers','volunteers'),
      ('visitors','visitors'),
      ('family_life','family'),
      ('communications','comms'),
      ('welfare','welfare'),
      ('education','education'),
      ('missions','missions'),
      ('scholarships','scholarship'),
      ('giving','giving'),
      ('expenses','expenses'),
      ('accounts','finance'),
      ('transactions','finance'),
      ('budgets','finance'),
      ('budget_lines','finance'),
      ('budget_plans','finance'),
      ('payroll','finance'),
      ('reconciliations','finance'),
      ('reconciliation_items','finance'),
      ('recon_snapshots','finance')
    ) as m(tbl, modu)
  loop
    -- drop all existing policies on the table (names vary across migrations)
    for p in select policyname from pg_policies
             where schemaname = 'public' and tablename = rec.tbl
    loop
      execute format('drop policy if exists %I on %I', p.policyname, rec.tbl);
    end loop;

    execute format(
      'create policy %I on %I for select using (org_id = auth_org_id())',
      rec.tbl||'_sel', rec.tbl);
    execute format(
      'create policy %I on %I for insert with check (org_id = auth_org_id() and auth_can_write(%L))',
      rec.tbl||'_ins', rec.tbl, rec.modu);
    execute format(
      'create policy %I on %I for update using (org_id = auth_org_id() and auth_can_write(%L)) with check (org_id = auth_org_id() and auth_can_write(%L))',
      rec.tbl||'_upd', rec.tbl, rec.modu, rec.modu);
    execute format(
      'create policy %I on %I for delete using (org_id = auth_org_id() and auth_can_write(%L))',
      rec.tbl||'_del', rec.tbl, rec.modu);
  end loop;
end $$;

-- ─── QR registrations: keep public insert (self-reg) + org read, gate edits ──
drop policy if exists qr_org_update on qr_registrations;
drop policy if exists qr_org_delete on qr_registrations;
create policy qr_org_update on qr_registrations for update
  using      (org_id = auth_org_id() and auth_can_write('qr'))
  with check (org_id = auth_org_id() and auth_can_write('qr'));
create policy qr_org_delete on qr_registrations for delete
  using (org_id = auth_org_id() and auth_can_write('qr'));

-- attendance previously allowed any public insert (old direct-write scanner).
-- The scanner now uses the qr_check_in() definer RPC, so that hole is removed
-- by the policy rebuild above (no more "with check (true)" on attendance).

-- ─── Prevent privilege escalation: users can't change their own role ─────────
-- profile_own ("for all using id = auth.uid()") otherwise lets a user set their
-- own role. Role changes must go through set_user_role() (owners/admins only).
create or replace function prevent_role_self_change()
returns trigger language plpgsql as $$
begin
  if NEW.role is distinct from OLD.role then
    if not exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.org_id = OLD.org_id and p.role in ('owner','admin')
    ) then
      raise exception 'Not allowed to change role';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_prevent_role_self_change on profiles;
create trigger trg_prevent_role_self_change
  before update on profiles
  for each row execute function prevent_role_self_change();

-- ─── Organizations: allow pastor (full access) to edit org settings too ──────
drop policy if exists org_update_own on organizations;
create policy org_update_own on organizations
  for update using (
    id = auth_org_id() and auth_user_role() in ('owner','admin','pastor')
  );
