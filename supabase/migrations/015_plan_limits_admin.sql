-- ChurchOS v2 — Migration 015: plan limits + super-admin unlock
-- Free: 50 members, 50 QR registrations. Starter: 200 members. Pro: unlimited.
-- Super admin (platform owner) can list orgs and set their plan.

-- ─── Plan limits ─────────────────────────────────────────────────────────────
create or replace function org_member_limit(p_plan text)
returns integer language sql immutable as $$
  select case p_plan
    when 'free'    then 50
    when 'starter' then 200
    else null    -- pro / enterprise = unlimited
  end;
$$;

create or replace function enforce_member_limit()
returns trigger language plpgsql security definer as $$
declare v_lim integer; v_cnt integer;
begin
  select org_member_limit(plan) into v_lim from organizations where id = NEW.org_id;
  if v_lim is not null then
    select count(*) into v_cnt from members where org_id = NEW.org_id;
    if v_cnt >= v_lim then
      raise exception 'Member limit reached for your plan (%). Upgrade to add more.', v_lim
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_member_limit on members;
create trigger trg_member_limit before insert on members
  for each row execute function enforce_member_limit();

create or replace function enforce_qr_limit()
returns trigger language plpgsql security definer as $$
declare v_plan text; v_cnt integer;
begin
  select plan into v_plan from organizations where id = NEW.org_id;
  if v_plan = 'free' then
    select count(*) into v_cnt from qr_registrations where org_id = NEW.org_id;
    if v_cnt >= 50 then
      raise exception 'Free plan QR limit reached (50 registrations). Upgrade for unlimited.'
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_qr_limit on qr_registrations;
create trigger trg_qr_limit before insert on qr_registrations
  for each row execute function enforce_qr_limit();

-- ─── Super admin (platform owner) ────────────────────────────────────────────
create or replace function is_super_admin()
returns boolean language sql stable security definer as $$
  select coalesce(
    (select lower(email) from auth.users where id = auth.uid()) = 'osaetaz@gmail.com',
    false);
$$;

create or replace function admin_list_orgs()
returns table (
  id uuid, name text, slug text, plan text, currency text,
  requested_plan text, member_count bigint, created_at timestamptz
) language plpgsql security definer as $$
begin
  if not is_super_admin() then raise exception 'Not authorized'; end if;
  return query
    select o.id, o.name, o.slug, o.plan, o.currency,
           o.settings->>'requested_plan',
           (select count(*) from members m where m.org_id = o.id),
           o.created_at
    from organizations o
    order by o.created_at desc;
end;
$$;

create or replace function admin_set_plan(p_org_id uuid, p_plan text)
returns void language plpgsql security definer as $$
begin
  if not is_super_admin() then raise exception 'Not authorized'; end if;
  if p_plan not in ('free','starter','pro','enterprise') then
    raise exception 'Invalid plan';
  end if;
  update organizations
    set plan = p_plan,
        settings = (coalesce(settings,'{}'::jsonb) - 'requested_plan')
  where id = p_org_id;
end;
$$;

grant execute on function is_super_admin()                 to authenticated;
grant execute on function admin_list_orgs()                to authenticated;
grant execute on function admin_set_plan(uuid, text)       to authenticated;
