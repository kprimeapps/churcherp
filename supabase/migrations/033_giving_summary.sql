-- ChurchOS v2 — Migration 033: server-side giving summary (for the paginated
-- Giving page, which can no longer sum client-side over tens of thousands of rows).
-- SECURITY INVOKER (default) so RLS scopes it to the caller's own org.

create or replace function get_giving_summary(p_org_id uuid, p_year int)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'total', coalesce((select sum(amount) from giving
                        where org_id = p_org_id
                          and given_date >= make_date(p_year,1,1)
                          and given_date <  make_date(p_year+1,1,1)), 0),
    'givers', (select count(distinct member_id) from giving
                where org_id = p_org_id and member_id is not null
                  and given_date >= make_date(p_year,1,1)
                  and given_date <  make_date(p_year+1,1,1)),
    'count', (select count(*) from giving
               where org_id = p_org_id
                 and given_date >= make_date(p_year,1,1)
                 and given_date <  make_date(p_year+1,1,1)),
    'month_total', coalesce((select sum(amount) from giving
                              where org_id = p_org_id
                                and date_trunc('month',given_date) = date_trunc('month',current_date)), 0)
  );
$$;
grant execute on function get_giving_summary(uuid, int) to authenticated;
