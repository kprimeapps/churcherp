-- ChurchOS v2 — Migration 037: server-side aggregation for Spending, Attendance,
-- and Membership-growth reports (all previously summed raw rows client-side and
-- were capped at 1000 by PostgREST). SECURITY INVOKER => RLS scopes to the org.

-- Spending by month + category over a range.
create or replace function get_spending_report(p_org_id uuid, p_start date, p_end date)
returns jsonb language sql stable as $$
  with e as (
    select amount, category, expense_date from expenses
    where org_id = p_org_id and expense_date >= p_start and expense_date <= p_end
  )
  select jsonb_build_object(
    'total', coalesce((select sum(amount) from e), 0),
    'month_total', coalesce((select sum(amount) from e
                              where date_trunc('month',expense_date)=date_trunc('month',current_date)), 0),
    'by_month', coalesce((select jsonb_agg(jsonb_build_object('ym',ym,'total',t) order by ym)
      from (select to_char(expense_date,'YYYY-MM') ym, sum(amount) t from e group by 1) s), '[]'::jsonb),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('category',category,'total',t) order by t desc)
      from (select coalesce(category,'Uncategorized') category, sum(amount) t from e group by 1) s), '[]'::jsonb)
  );
$$;
grant execute on function get_spending_report(uuid, date, date) to authenticated;

-- Attendance per bucket = individual check-ins + manual (non-group) summary totals.
-- p_type null = all service types; p_bucket in ('day','month','year').
create or replace function get_attendance_series(
  p_org_id uuid, p_start date, p_end date, p_type text default null, p_bucket text default 'day')
returns jsonb language sql stable as $$
  with fmt as (
    select case p_bucket when 'year' then 'YYYY' when 'month' then 'YYYY-MM' else 'YYYY-MM-DD' end f),
  a as (
    select to_char(service_date,(select f from fmt)) k, count(*)::numeric c
    from attendance
    where org_id=p_org_id and service_date between p_start and p_end
      and (p_type is null or service_type=p_type)
    group by 1),
  s as (
    select to_char(summary_date,(select f from fmt)) k, sum(total_count)::numeric c
    from attendance_summaries
    where org_id=p_org_id and summary_date between p_start and p_end
      and group_name is null and (p_type is null or service_type=p_type)
    group by 1),
  m as (select k, sum(c) c from (select * from a union all select * from s) u group by 1)
  select coalesce((select jsonb_agg(jsonb_build_object('k',k,'c',c) order by k) from m), '[]'::jsonb);
$$;
grant execute on function get_attendance_series(uuid, date, date, text, text) to authenticated;

-- New (counted) members per bucket, for the cumulative membership-growth line.
create or replace function get_member_joins(p_org_id uuid, p_bucket text default 'month')
returns jsonb language sql stable as $$
  with fmt as (select case p_bucket when 'year' then 'YYYY' else 'YYYY-MM' end f),
  j as (
    select to_char(coalesce(date_joined, created_at::date),(select f from fmt)) k, count(*)::numeric c
    from members
    where org_id=p_org_id and is_member = true
      and coalesce(date_joined, created_at::date) is not null
    group by 1)
  select coalesce((select jsonb_agg(jsonb_build_object('k',k,'c',c) order by k) from j), '[]'::jsonb);
$$;
grant execute on function get_member_joins(uuid, text) to authenticated;
