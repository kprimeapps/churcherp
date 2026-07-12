-- ChurchOS v2 — Migration 028: remove a team member from the organization
-- Detaches the account from the org (org_id -> null, role -> viewer). The auth
-- user still exists but loses all access to this church's data; on next load
-- they land on onboarding as an org-less user. Owner/admin only; can't remove
-- the owner or yourself.

create or replace function remove_team_member(p_user_id uuid)
returns void language plpgsql security definer as $$
declare v_caller_role text; v_caller_org uuid; v_target_role text; v_target_org uuid;
begin
  select role, org_id into v_caller_role, v_caller_org from profiles where id = auth.uid();
  if v_caller_role not in ('owner','admin') then raise exception 'Not authorized'; end if;
  if p_user_id = auth.uid() then raise exception 'You cannot remove yourself'; end if;

  select role, org_id into v_target_role, v_target_org from profiles where id = p_user_id;
  if v_target_org is distinct from v_caller_org then raise exception 'User belongs to a different organization'; end if;
  if v_target_role = 'owner' then raise exception 'The owner cannot be removed'; end if;

  update profiles
     set org_id = null, role = 'viewer', group_name = null, updated_at = now()
   where id = p_user_id;
end;
$$;
grant execute on function remove_team_member(uuid) to authenticated;
