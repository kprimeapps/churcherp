-- ChurchOS v2 — Migration 036: server-side giving report aggregation
-- The Reports > Giving tab summed raw rows client-side, capped at 1000 by
-- PostgREST — so large ranges undercounted and dropped whole months. This RPC
-- aggregates in Postgres (RLS-scoped to the caller's org).

create or replace function get_giving_report(p_org_id uuid, p_start date, p_end date)
returns jsonb language sql stable as $$
  with g as (
    select amount, category, given_date, member_id
    from giving
    where org_id = p_org_id and given_date >= p_start and given_date <= p_end
  )
  select jsonb_build_object(
    'total',  coalesce((select sum(amount) from g), 0),
    'givers', (select count(distinct member_id) from g where member_id is not null),
    'month_total', coalesce((select sum(amount) from g
                              where date_trunc('month',given_date) = date_trunc('month',current_date)), 0),
    'by_month', coalesce((
      select jsonb_agg(jsonb_build_object('ym', ym, 'total', t) order by ym)
      from (select to_char(given_date,'YYYY-MM') ym, sum(amount) t from g group by 1) s), '[]'::jsonb),
    'by_category', coalesce((
      select jsonb_agg(jsonb_build_object('category', category, 'total', t) order by t desc)
      from (select coalesce(category,'Uncategorized') category, sum(amount) t from g group by 1) s), '[]'::jsonb)
  );
$$;
grant execute on function get_giving_report(uuid, date, date) to authenticated;
