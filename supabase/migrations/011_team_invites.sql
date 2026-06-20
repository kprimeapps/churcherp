-- ChurchOS v2 — Migration 011: team invites (join an existing org)

create table if not exists org_invites (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  email      text not null,
  role       text not null default 'staff',
  created_at timestamptz not null default now()
);
create unique index if not exists idx_org_invites_email
  on org_invites (org_id, lower(email));

alter table org_invites enable row level security;
create policy org_invites_admin on org_invites for all
  using      (org_id = auth_org_id() and auth_user_role() in ('owner','admin'))
  with check (org_id = auth_org_id() and auth_user_role() in ('owner','admin'));

-- On signup, attach the user to an inviting org (if invited); else default owner.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_inv org_invites%rowtype;
begin
  select * into v_inv from org_invites where lower(email) = lower(new.email) limit 1;
  if found then
    insert into profiles (id, first_name, last_name, role, org_id)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'first_name',''),
      coalesce(new.raw_user_meta_data->>'last_name',''),
      v_inv.role, v_inv.org_id
    )
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
    delete from org_invites where id = v_inv.id;
  else
    insert into profiles (id, first_name, last_name, role)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'first_name',''),
      coalesce(new.raw_user_meta_data->>'last_name',''),
      coalesce(new.raw_user_meta_data->>'role','owner')
    )
    on conflict (id) do nothing;
  end if;
  return new;
end;
$$;
