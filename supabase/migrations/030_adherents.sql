-- ChurchOS v2 — Migration 030: non-member "Adherents"
-- People you interact with (e.g. repeat givers) who are NOT counted members:
-- no membership number required, excluded from the plan member limit and from
-- official member counts, but still real records (searchable, giving history).

alter table members add column if not exists is_member boolean not null default true;

-- Adherents (is_member = false) don't count toward the plan limit, and adding
-- one is never blocked.
create or replace function enforce_member_limit()
returns trigger language plpgsql security definer as $$
declare v_lim integer; v_cnt integer;
begin
  if NEW.is_member = false then return NEW; end if;   -- adherents are unlimited
  select org_member_limit(plan) into v_lim from organizations where id = NEW.org_id;
  if v_lim is not null then
    select count(*) into v_cnt from members where org_id = NEW.org_id and is_member = true;
    if v_cnt >= v_lim then
      raise exception 'Member limit reached for your plan (%). Upgrade to add more.', v_lim
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

-- Dashboard "total members" should exclude adherents too.
create or replace function get_dashboard_stats(p_org_id uuid)
returns jsonb language plpgsql security definer as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'total_members',       (select count(*) from members     where org_id = p_org_id and is_active and is_member),
    'attendance_sunday',   (select count(*) from attendance  where org_id = p_org_id
                             and service_date = (select max(service_date) from attendance
                                                  where org_id = p_org_id and service_type = 'Sunday Service')),
    'giving_month',        (select coalesce(sum(amount),0) from giving where org_id = p_org_id
                             and date_trunc('month',given_date) = date_trunc('month',current_date)),
    'visitors_month',      (select count(*) from visitors    where org_id = p_org_id
                             and date_trunc('month',visit_date) = date_trunc('month',current_date)),
    'welfare_pending',     (select count(*) from welfare     where org_id = p_org_id and status = 'pending'),
    'events_upcoming',     (select count(*) from events      where org_id = p_org_id and start_date >= now()),
    'qr_pending_import',   (select count(*) from qr_registrations where org_id = p_org_id and not imported)
  ) into result;
  return result;
end;
$$;
