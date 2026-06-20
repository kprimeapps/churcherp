-- ChurchOS v2 — Migration 009: RBAC roles, online attendance, event participants

-- ─── 1) EXPANDED ROLES ───────────────────────────────────────────────────────
-- Add ministry/department roles used by the app's role-based access control.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in (
  'owner','admin','pastor','staff','viewer',
  'finance_team','usher','missions_coordinator','education_coordinator',
  'welfare_coordinator','counsellor',
  'district_admin','presbytery_admin','national_admin'
));

-- Assign / change a user's role — only owners/admins, only within their own org.
create or replace function set_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer as $$
declare
  v_caller_role text; v_caller_org uuid; v_target_org uuid;
begin
  select role, org_id into v_caller_role, v_caller_org from profiles where id = auth.uid();
  if v_caller_role not in ('owner','admin') then
    raise exception 'Not authorized to change roles';
  end if;
  select org_id into v_target_org from profiles where id = p_user_id;
  if v_target_org is distinct from v_caller_org then
    raise exception 'User belongs to a different organization';
  end if;
  update profiles set role = p_role, updated_at = now() where id = p_user_id;
end;
$$;
grant execute on function set_user_role(uuid, text) to authenticated;

-- ─── 2) EVENTS: number of participants ───────────────────────────────────────
alter table events add column if not exists num_participants integer;

-- ─── 3) ONLINE ATTENDANCE (per-channel manual counts) ────────────────────────
create table if not exists online_attendance (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  service_date date not null default current_date,
  service_type text not null default 'Sunday Service',
  channel      text not null,                 -- Facebook, YouTube, TikTok, Zoom, …
  count        integer not null default 0 check (count >= 0),
  notes        text,
  created_at   timestamptz not null default now()
);

create unique index if not exists idx_online_att_unique
  on online_attendance (org_id, service_date, service_type, lower(channel));
create index if not exists idx_online_att_org
  on online_attendance (org_id, service_date desc);

alter table online_attendance enable row level security;
create policy "rls_online_attendance" on online_attendance
  for all using (org_id = auth_org_id());
