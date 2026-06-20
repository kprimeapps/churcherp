-- ChurchOS v2 — Row Level Security
-- Run after 001_schema.sql

-- ─── HELPERS ──────────────────────────────────────────────────────────────────
create or replace function auth_org_id()
returns uuid language sql stable security definer as $$
  select org_id from profiles where id = auth.uid()
$$;

create or replace function auth_user_role()
returns text language sql stable security definer as $$
  select role from profiles where id = auth.uid()
$$;

-- ─── ORGANIZATIONS ────────────────────────────────────────────────────────────
alter table organizations enable row level security;

create policy "org_select_own" on organizations
  for select using (
    id = auth_org_id()
    or auth_user_role() in ('district_admin','presbytery_admin','national_admin')
  );

create policy "org_update_own" on organizations
  for update using (
    id = auth_org_id() and auth_user_role() in ('owner','admin')
  );

-- public insert for onboarding (anyone can create an org)
create policy "org_insert_public" on organizations
  for insert with check (true);

-- ─── PROFILES ─────────────────────────────────────────────────────────────────
alter table profiles enable row level security;

create policy "profile_own" on profiles
  for all using (id = auth.uid());

create policy "profile_org_read" on profiles
  for select using (
    org_id = auth_org_id() and auth_user_role() in ('owner','admin')
  );

-- ─── MEMBERS ──────────────────────────────────────────────────────────────────
alter table members enable row level security;
create policy "members_org" on members
  for all using (org_id = auth_org_id());

-- ─── ATTENDANCE ───────────────────────────────────────────────────────────────
alter table attendance enable row level security;
create policy "attendance_org" on attendance
  for all using (org_id = auth_org_id());
-- QR app inserts with anon key, must pass org_id; validated in edge function
create policy "attendance_qr_insert" on attendance
  for insert with check (true);

-- ─── QR REGISTRATIONS ─────────────────────────────────────────────────────────
alter table qr_registrations enable row level security;
create policy "qr_org_read"     on qr_registrations for select using (org_id = auth_org_id());
create policy "qr_public_insert" on qr_registrations for insert with check (true);
create policy "qr_org_update"   on qr_registrations for update using (org_id = auth_org_id());
create policy "qr_org_delete"   on qr_registrations for delete using (org_id = auth_org_id());

-- ─── ALL OTHER ORG-SCOPED TABLES ──────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'giving','groups','events','volunteers','visitors','welfare','education',
    'missions','scholarships','communications','accounts','transactions',
    'budgets','budget_lines','payroll','expenses','family_life'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy "rls_%s" on %I for all using (org_id = auth_org_id())',
      t, t
    );
  end loop;
end $$;
