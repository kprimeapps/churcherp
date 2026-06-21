-- ChurchOS v2 — Migration 012: restrict Usher to attendance only
-- Ushers no longer have QR check-in or any member-data access; only attendance
-- (manual + online). Mirrors js/permissions.js.

create or replace function auth_can_write(p_module text)
returns boolean language sql stable as $$
  select case
    when auth_user_role() in
         ('owner','admin','pastor','district_admin','presbytery_admin','national_admin')
      then true
    when auth_user_role() = 'staff' then p_module in
         ('members','attendance','groups','volunteers','visitors','family','comms',
          'events','welfare','education','missions','scholarship','qr')
    when auth_user_role() = 'finance_team'         then p_module in ('giving','expenses','finance')
    when auth_user_role() = 'usher'                then p_module = 'attendance'
    when auth_user_role() = 'missions_coordinator' then p_module = 'missions'
    when auth_user_role() = 'education_coordinator' then p_module in ('education','scholarship')
    when auth_user_role() = 'welfare_coordinator'  then p_module = 'welfare'
    when auth_user_role() = 'counsellor'           then p_module = 'family'
    else false
  end;
$$;
