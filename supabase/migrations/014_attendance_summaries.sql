-- ChurchOS v2 — Migration 014: manual attendance summaries (non-QR churches + groups)
-- Records a single total (optionally split by gender) for a service or a group
-- meeting, for congregations that don't capture per-person QR attendance.

create table if not exists attendance_summaries (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  summary_date   date not null default current_date,
  service_type   text not null default 'Sunday Service',
  group_name     text,                       -- null = whole-church service
  total_count    integer not null default 0 check (total_count >= 0),
  male_count     integer not null default 0,
  female_count   integer not null default 0,
  children_count integer not null default 0,
  notes          text,
  created_at     timestamptz not null default now()
);

create unique index if not exists idx_att_summary_unique
  on attendance_summaries (org_id, summary_date, service_type, coalesce(group_name,''));
create index if not exists idx_att_summary_org
  on attendance_summaries (org_id, summary_date desc);

alter table attendance_summaries enable row level security;
create policy att_sum_sel on attendance_summaries for select using (org_id = auth_org_id());
create policy att_sum_ins on attendance_summaries for insert
  with check (org_id = auth_org_id() and auth_can_write('attendance'));
create policy att_sum_upd on attendance_summaries for update
  using      (org_id = auth_org_id() and auth_can_write('attendance'))
  with check (org_id = auth_org_id() and auth_can_write('attendance'));
create policy att_sum_del on attendance_summaries for delete
  using (org_id = auth_org_id() and auth_can_write('attendance'));
