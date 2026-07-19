-- ChurchOS v2 — Migration 038: multi-word member search + giving immutability

-- 1) Full-roster, multi-word search (name + membership# + phone). Every
--    whitespace token must appear somewhere in the searchable text, so
--    "nana osae" matches first_name 'Nana' + last_name 'Osae'.
create or replace function search_members(p_org_id uuid, p_q text)
returns setof members language sql stable as $$
  select m.* from members m
  where m.org_id = p_org_id
    and (
      coalesce(trim(p_q),'') = ''
      or (
        select bool_and(
          lower(coalesce(m.first_name,'') || ' ' || coalesce(m.last_name,'') || ' ' ||
                coalesce(m.other_names,'') || ' ' || coalesce(m.membership_no,'') || ' ' ||
                coalesce(m.phone,'') || ' ' || coalesce(m.phone2,'')) like '%' || tok || '%')
        from unnest(string_to_array(lower(trim(p_q)), ' ')) tok
        where tok <> ''
      )
    )
  order by m.first_name, m.last_name
  limit 100;
$$;
grant execute on function search_members(uuid, text) to authenticated;

-- 2) Giving is an audit record: block edits and deletes (insert + read only).
--    Corrections are made by posting a reversal (negative amount), not editing.
drop policy if exists giving_upd on giving;
drop policy if exists giving_del on giving;

-- 3) Receipts: bulk incoming funds (offerings, donations, deposits, transfers) —
--    the income counterpart to Payments (expenses). Finance-writers manage them.
create table if not exists receipts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  receipt_date date not null default current_date,
  title        text not null,               -- what it was for / source
  category     text,                         -- Offering, Donation, Harvest, Grant, Transfer…
  amount       numeric(14,2) not null check (amount <> 0),
  currency     text not null default 'GHS',
  method       text,                         -- Cash / Mobile Money / Cheque / Bank
  reference    text,                         -- MoMo / cheque / transfer ref
  account_id   uuid references accounts(id) on delete set null,   -- account it landed in
  notes        text,
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now()
);
alter table receipts enable row level security;
drop policy if exists receipts_sel on receipts;
drop policy if exists receipts_ins on receipts;
drop policy if exists receipts_upd on receipts;
drop policy if exists receipts_del on receipts;
create policy receipts_sel on receipts for select using (org_id = auth_org_id());
create policy receipts_ins on receipts for insert with check (org_id = auth_org_id() and auth_can_write('finance'));
create policy receipts_upd on receipts for update using (org_id = auth_org_id() and auth_can_write('finance')) with check (org_id = auth_org_id() and auth_can_write('finance'));
create policy receipts_del on receipts for delete using (org_id = auth_org_id() and auth_can_write('finance'));
create index if not exists idx_receipts_org_date on receipts (org_id, receipt_date desc);
