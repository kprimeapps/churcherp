-- ChurchOS v2 — Migration 032: legacy finance import — transform staging -> giving
-- Run this AFTER importing giving_clean.csv into giving_import (migration 031).
-- Idempotent: re-running won't double-insert the batch. Adjust the slug if your
-- org differs.

do $$
declare v_org uuid; v_batch text := 'finance_2022_2026'; v_n int;
begin
  select id into v_org from organizations where slug = 'immanuel';
  if v_org is null then raise exception 'Org not found — set the correct slug'; end if;

  -- Already imported? Bail (idempotent).
  if exists (select 1 from giving where import_batch = v_batch) then
    raise notice 'Batch % already imported — skipping.', v_batch;
    return;
  end if;

  -- Resolve member: membership number first, then phone (last-9-digit match).
  update giving_import i set resolved_member_id = m.id
    from members m
   where m.org_id = v_org and i.resolved_member_id is null
     and nullif(norm_mno(i.membership_no), '') = norm_mno(m.membership_no);

  update giving_import i set resolved_member_id = m.id
    from members m
   where m.org_id = v_org and i.resolved_member_id is null
     and nullif(norm_phone(i.phone), '') = norm_phone(m.phone);

  -- Load into giving (skip the 1 zero-amount row; keep negatives/reversals).
  insert into giving (org_id, member_id, member_name, amount, currency, category,
                      payment_method, given_date, notes, receipt_no, reference,
                      source, import_batch)
  select v_org, i.resolved_member_id, nullif(i.member_name,''), i.amount::numeric,
         coalesce(nullif(i.currency,''),'GHS'), coalesce(nullif(i.category,''),'Tithe'),
         coalesce(nullif(i.payment_method,''),'Cash'), i.given_date::date,
         nullif(i.notes,''), nullif(i.receipt_no,''), nullif(i.reference,''),
         'legacy_import', v_batch
    from giving_import i
   where i.amount::numeric <> 0;
  get diagnostics v_n = row_count;
  raise notice 'Imported % giving rows (batch %).', v_n, v_batch;
end $$;

-- Match report (run separately to see how many linked to members):
--   select count(*) filter (where member_id is not null) as matched,
--          count(*) filter (where member_id is null)     as name_only,
--          count(*) as total
--   from giving where import_batch = 'finance_2022_2026';

-- When satisfied, drop the staging table:
--   drop table if exists giving_import;

-- To undo the whole batch:
--   delete from giving where import_batch = 'finance_2022_2026';
