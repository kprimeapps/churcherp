-- ChurchOS v2 — Migration 019: visitor → newcomer → member lifecycle
-- Visitors gain purpose/status/demographics; newcomer classes + teachers;
-- convert a completed visitor into a (partial) member to finish via the portal.

-- ─── Visitor lifecycle fields ────────────────────────────────────────────────
alter table visitors
  add column if not exists purpose        text not null default 'Visiting',  -- Visiting | Joining
  add column if not exists status         text not null default 'new_visitor',
  add column if not exists gender         text,
  add column if not exists age            integer,
  add column if not exists already_member boolean not null default false,     -- already in this denomination
  add column if not exists member_id      uuid references members(id) on delete set null;
-- status: new_visitor | in_classes | completed | full_member

-- ─── Newcomer class teachers ─────────────────────────────────────────────────
create table if not exists newcomer_teachers (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  name       text not null,
  phone      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- ─── Newcomer class attendance (per lesson, per visitor) ─────────────────────
create table if not exists newcomer_classes (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  visitor_id          uuid not null references visitors(id) on delete cascade,
  lesson              text not null,
  date_attended       date not null default current_date,
  lead_teacher_id     uuid references newcomer_teachers(id) on delete set null,
  supporting_teachers jsonb not null default '[]',   -- array of teacher names
  notes               text,
  created_at          timestamptz not null default now()
);
create unique index if not exists idx_newcomer_class_unique
  on newcomer_classes (org_id, visitor_id, lower(lesson));
create index if not exists idx_newcomer_class_visitor on newcomer_classes (visitor_id);

alter table newcomer_teachers enable row level security;
alter table newcomer_classes  enable row level security;
create policy nt_sel on newcomer_teachers for select using (org_id = auth_org_id());
create policy nt_wri on newcomer_teachers for all
  using (org_id = auth_org_id() and auth_can_write('visitors'))
  with check (org_id = auth_org_id() and auth_can_write('visitors'));
create policy nc_sel on newcomer_classes for select using (org_id = auth_org_id());
create policy nc_wri on newcomer_classes for all
  using (org_id = auth_org_id() and auth_can_write('visitors'))
  with check (org_id = auth_org_id() and auth_can_write('visitors'));

-- ─── Convert a visitor into a member (partial data; finish via confirm portal) ─
create or replace function convert_visitor_to_member(p_visitor_id uuid, p_org_id uuid)
returns uuid language plpgsql security definer as $$
declare v_vis visitors%rowtype; v_member uuid;
begin
  if not auth_can_write('visitors') then raise exception 'Not authorized'; end if;
  select * into v_vis from visitors where id = p_visitor_id and org_id = p_org_id;
  if not found then raise exception 'Visitor not found'; end if;
  if v_vis.member_id is not null then return v_vis.member_id; end if;

  insert into members (org_id, first_name, last_name, phone, email, gender, role, member_confirmed)
  values (p_org_id, v_vis.first_name, coalesce(v_vis.last_name,''), v_vis.phone, v_vis.email,
          v_vis.gender, 'General', false)
  returning id into v_member;

  update visitors set status = 'full_member', member_id = v_member where id = p_visitor_id;
  return v_member;
end;
$$;
grant execute on function convert_visitor_to_member(uuid, uuid) to authenticated;
