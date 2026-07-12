-- ChurchOS v2 — Migration 029: flexible attendance count segments + Media Team role

-- 1) Store a flexible demographic breakdown alongside the fixed columns.
alter table attendance_summaries add column if not exists breakdown jsonb;

-- 2) New role for the online streaming/media team (records online attendance only).
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in (
  'owner','admin','pastor','staff','viewer',
  'finance_team','usher','group_secretary','media_team',
  'missions_coordinator','education_coordinator',
  'welfare_coordinator','counsellor',
  'district_admin','presbytery_admin','national_admin'
));
