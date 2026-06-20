-- ChurchOS v2 — DB Functions & Triggers

-- Auto-create profile when a user signs up
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, first_name, last_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', ''),
    coalesce(new.raw_user_meta_data->>'role', 'owner')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- Dashboard stats
create or replace function get_dashboard_stats(p_org_id uuid)
returns jsonb language plpgsql security definer as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'total_members',       (select count(*) from members     where org_id = p_org_id and is_active),
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

-- Attendance trend (last 12 Sundays)
create or replace function get_attendance_trend(p_org_id uuid)
returns table(service_date date, cnt bigint) language sql security definer as $$
  select service_date, count(*) as cnt
  from attendance
  where org_id = p_org_id
    and service_type = 'Sunday Service'
    and service_date >= current_date - interval '84 days'
  group by service_date
  order by service_date;
$$;

-- Giving by category for current year
create or replace function get_giving_by_category(p_org_id uuid)
returns table(category text, total numeric) language sql security definer as $$
  select category, sum(amount) as total
  from giving
  where org_id = p_org_id
    and extract(year from given_date) = extract(year from current_date)
  group by category
  order by total desc;
$$;

-- Import QR registration into members
create or replace function import_qr_registration(p_reg_id text, p_org_id uuid)
returns uuid language plpgsql security definer as $$
declare
  v_reg qr_registrations%rowtype;
  v_member_id uuid;
begin
  select * into v_reg from qr_registrations where id = p_reg_id and org_id = p_org_id;
  if not found then raise exception 'Registration not found'; end if;
  if v_reg.imported then raise exception 'Already imported'; end if;

  insert into members (org_id, first_name, last_name, phone, membership_no, role)
  values (p_org_id, v_reg.first_name, coalesce(v_reg.last_name,''), v_reg.phone, v_reg.membership_no, v_reg.role)
  returning id into v_member_id;

  update qr_registrations set imported = true where id = p_reg_id;
  return v_member_id;
end;
$$;

-- Update account balance after transaction insert
create or replace function update_account_balances()
returns trigger language plpgsql security definer as $$
begin
  update accounts set balance = balance + new.amount where id = new.debit_account_id;
  update accounts set balance = balance - new.amount where id = new.credit_account_id;
  return new;
end;
$$;

drop trigger if exists trg_update_balances on transactions;
create trigger trg_update_balances
  after insert on transactions
  for each row execute procedure update_account_balances();

-- Reverse balance on transaction delete
create or replace function reverse_account_balances()
returns trigger language plpgsql security definer as $$
begin
  update accounts set balance = balance - old.amount where id = old.debit_account_id;
  update accounts set balance = balance + old.amount where id = old.credit_account_id;
  return old;
end;
$$;

drop trigger if exists trg_reverse_balances on transactions;
create trigger trg_reverse_balances
  after delete on transactions
  for each row execute procedure reverse_account_balances();
