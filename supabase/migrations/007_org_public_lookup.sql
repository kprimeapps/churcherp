-- ChurchOS v2 — Migration 007: public org lookup for the QR apps (anon key)
-- The QR scanner and self-registration pages run with the anon key and must
-- resolve an organization by its slug. RLS (org_select_own) blocks anon reads,
-- so expose ONLY the fields those pages need via a security-definer function.
-- This avoids a blanket public SELECT policy (which would let anyone dump the
-- full organizations table / enumerate every tenant).

create or replace function get_org_by_slug(p_slug text)
returns table (
  id            uuid,
  name          text,
  sub_name      text,
  slug          text,
  qr_reset_code text,
  settings      jsonb
)
language sql
security definer
stable
as $$
  select id, name, sub_name, slug, qr_reset_code, settings
  from organizations
  where slug = p_slug and is_active = true
  limit 1;
$$;

grant execute on function get_org_by_slug(text) to anon, authenticated;
