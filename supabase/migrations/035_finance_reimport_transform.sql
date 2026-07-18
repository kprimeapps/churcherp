-- ChurchOS v2 — Migration 035: corrected finance re-import — transform
-- Run AFTER re-importing giving_clean.csv into giving_import (migration 034).
-- Delete-then-insert on the batch => safe to re-run; also cleans up the earlier
-- (wrong-date) load of the same batch from migration 032.

do $$
declare v_org uuid; v_batch text := 'finance_2022_2026'; v_n int;
begin
  select id into v_org from organizations where slug = 'immanuel';
  if v_org is null then raise exception 'Org not found — set the correct slug'; end if;

  -- Remove any prior load of this batch (incl. the earlier transaction-date version).
  delete from giving where import_batch = v_batch;

  -- Resolve member: membership number first, then phone (last-9 match).
  update giving_import i set resolved_member_id = m.id
    from members m
   where m.org_id = v_org and i.resolved_member_id is null
     and nullif(norm_mno(i.membership_no), '') = norm_mno(m.membership_no);
  update giving_import i set resolved_member_id = m.id
    from members m
   where m.org_id = v_org and i.resolved_member_id is null
     and nullif(norm_phone(i.phone), '') = norm_phone(m.phone);

  -- Load: given_date = tithe period; receipt_date = actual transaction date.
  insert into giving (org_id, member_id, member_name, amount, currency, category,
                      payment_method, given_date, receipt_date, notes, receipt_no,
                      reference, source, import_batch)
  select v_org, i.resolved_member_id, nullif(i.member_name,''), i.amount::numeric,
         coalesce(nullif(i.currency,''),'GHS'), coalesce(nullif(i.category,''),'Tithe'),
         coalesce(nullif(i.payment_method,''),'Cash'),
         i.given_date::date, i.receipt_date::date,
         nullif(i.notes,''), nullif(i.receipt_no,''), nullif(i.reference,''),
         'legacy_import', v_batch
    from giving_import i
   where i.amount::numeric <> 0;
  get diagnostics v_n = row_count;
  raise notice 'Re-imported % giving rows (batch %).', v_n, v_batch;
end $$;

-- Sanity check — should now show NO future/impossible tithe periods:
--   select to_char(given_date,'YYYY-MM') ym, count(*)
--   from giving where import_batch='finance_2022_2026' and given_date > current_date
--   group by 1 order by 1;
-- When satisfied:  drop table if exists giving_import;
