-- ChurchOS v2 — Migration 031: legacy finance import — schema + staging table
-- Run this FIRST. Then import finance_records/giving_clean.csv into giving_import
-- via the Supabase Table Editor (CSV import). Then run migration 032.

-- 1) Provenance + reference columns on giving.
alter table giving add column if not exists receipt_no   text;
alter table giving add column if not exists reference    text;   -- MoMo / cheque ref
alter table giving add column if not exists source       text;   -- e.g. 'legacy_import'
alter table giving add column if not exists import_batch text;

-- 2) Allow reversals (negative amounts). Legacy data has 823 reversals.
alter table giving drop constraint if exists giving_amount_check;
alter table giving add constraint giving_amount_check check (amount <> 0);

-- 3) Staging table matching giving_clean.csv (all text; cast during transform).
drop table if exists giving_import;
create table giving_import (
  given_date     text,
  receipt_no     text,
  membership_no  text,
  member_name    text,
  phone          text,
  phone_raw      text,
  currency       text,
  amount         text,
  payment_method text,
  reference      text,
  notes          text,
  category       text,
  resolved_member_id uuid
);
-- Staging is transient (dropped after 032). Lock it down; the CSV import and
-- the transform run with elevated privileges and bypass RLS.
alter table giving_import enable row level security;
