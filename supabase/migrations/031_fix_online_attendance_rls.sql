-- ChurchOS v2 — Migration 031: fix online_attendance RLS (inserts were rejected)
-- The original policy used `FOR ALL USING (...)` with no explicit WITH CHECK,
-- so INSERTs violated RLS ("new row violates row-level security policy").
-- Replace with explicit per-command policies matching the rest of the schema.
-- Writers: anyone who can write attendance, plus the Media Team role.

drop policy if exists "rls_online_attendance" on online_attendance;

create policy online_att_sel on online_attendance
  for select using (org_id = auth_org_id());

create policy online_att_ins on online_attendance
  for insert with check (
    org_id = auth_org_id()
    and (auth_can_write('attendance') or auth_user_role() = 'media_team')
  );

create policy online_att_upd on online_attendance
  for update using (org_id = auth_org_id())
  with check (
    org_id = auth_org_id()
    and (auth_can_write('attendance') or auth_user_role() = 'media_team')
  );

create policy online_att_del on online_attendance
  for delete using (
    org_id = auth_org_id()
    and (auth_can_write('attendance') or auth_user_role() = 'media_team')
  );
