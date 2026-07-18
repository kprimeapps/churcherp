-- ChurchOS v2 — Migration 034: corrected finance re-import — schema + staging
-- Supersedes the date handling in 032. given_date now carries the tithe PERIOD
-- (from Notes); the actual receipt/transaction date is preserved in receipt_date.
-- Run this, then re-import the regenerated finance_records/giving_clean.csv into
-- giving_import, then run 035.

alter table giving add column if not exists receipt_date date;   -- actual transaction date (audit)

-- Rebuild staging to match the new giving_clean.csv columns.
drop table if exists giving_import;
create table giving_import (
  given_date     text,   -- tithe period (YYYY-MM-01) or receipt date fallback
  receipt_date   text,   -- actual transaction/receipt date
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
alter table giving_import enable row level security;
