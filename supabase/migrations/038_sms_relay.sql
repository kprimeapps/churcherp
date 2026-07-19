-- ChurchOS v2 — Migration 038: route the giving-confirmation SMS through SMS Relay
--
-- SMS Relay (https://github.com/kprimeapps/smsrelay) delivers transactional SMS
-- through a physical Android gateway phone. We use it ONLY for the per-gift
-- giving confirmation; bulk send_sms() (Communications page) stays on Arkesel.
--
-- Like the Arkesel integration (024), sending is server-side and fire-and-forget
-- via pg_net -- ChurchOS never sees the gateway; the per-org SMS Relay tenant key
-- lives in sms_config (no client access; SECURITY DEFINER functions only).
--
-- Provisioning of a per-org SMS Relay tenant + key (which needs to read a
-- response, and so can't be done in pg_net's async model) is handled out of band
-- (Phase 1: manual/API; Phase 2: a Supabase Edge Function). This migration only
-- consumes an already-provisioned relay_tenant_key.

-- ── Per-org SMS Relay tenant key (secret; same handling as sms_config.api_key) ─
alter table sms_config add column if not exists relay_tenant_key text;

-- ── SMS Relay base URL (single source of truth) ──────────────────────────────
create or replace function _relay_base_url()
returns text language sql immutable as $$ select 'https://sms-relay-indx.onrender.com' $$;

-- ── Fire a single SMS Relay send (one recipient). Fire-and-forget, like Arkesel ─
create or replace function _relay_send(p_tenant_key text, p_recipient text, p_message text)
returns bigint language plpgsql security definer set search_path = public, extensions, net as $$
declare req_id bigint;
begin
  select net.http_post(
    url     := _relay_base_url() || '/v1/messages',
    headers := jsonb_build_object('Authorization', 'Bearer ' || p_tenant_key,
                                  'Content-Type', 'application/json'),
    body    := jsonb_build_object('recipient_msisdn', p_recipient, 'body', p_message)
  ) into req_id;
  return req_id;
end;
$$;

-- ── Reroute the giving-confirmation trigger ──────────────────────────────────
-- Prefer SMS Relay when the org has a relay_tenant_key; otherwise fall back to
-- Arkesel (unchanged behavior). Message composition is unchanged.
create or replace function giving_sms_notify()
returns trigger language plpgsql security definer as $$
declare
  c   sms_config%rowtype;
  v_phone text;
  v_name  text;
  v_msg   text;
  v_org   organizations%rowtype;
begin
  select * into c from sms_config where org_id = NEW.org_id;
  if not found or not c.enabled or not c.send_on_giving then
    return NEW;
  end if;
  -- Need at least one transport configured (SMS Relay tenant key or Arkesel key).
  if coalesce(c.relay_tenant_key,'') = '' and coalesce(c.api_key,'') = '' then
    return NEW;
  end if;

  -- Resolve the member's primary phone + name
  if NEW.member_id is not null then
    select phone, trim(first_name || ' ' || coalesce(last_name,'')) into v_phone, v_name
      from members where id = NEW.member_id;
  end if;
  v_phone := _norm_msisdn(v_phone);
  if v_phone is null then return NEW; end if;

  select * into v_org from organizations where id = NEW.org_id;
  v_msg := format('Dear %s, we acknowledge your %s of %s %s on %s. God bless you. - %s',
                  coalesce(nullif(v_name,''),'Member'),
                  coalesce(NEW.category,'gift'),
                  coalesce(NEW.currency,''),
                  trim(to_char(NEW.amount, 'FM999999990.00')),
                  to_char(NEW.given_date, 'DD Mon YYYY'),
                  coalesce(v_org.name,'Church'));

  if coalesce(c.relay_tenant_key,'') <> '' then
    -- SMS Relay's gateway dials via Android SmsManager, so send E.164.
    -- _norm_msisdn returns 233XXXXXXXXX (no +); prepend it.
    perform _relay_send(c.relay_tenant_key, '+' || v_phone, v_msg);
  else
    perform _arkesel_send(c.api_key, c.sender_id, v_msg, array[v_phone]);
  end if;
  return NEW;
exception when others then
  -- Never let an SMS failure block the giving insert.
  return NEW;
end;
$$;

-- Trigger definition is unchanged (still AFTER INSERT on giving); replacing the
-- function above is sufficient.

-- ── Configure an org for SMS Relay (run in the Supabase SQL editor; do NOT
--    commit the real key). This sets the per-org tenant key; keep enabled and
--    send_on_giving on. Leaving api_key set is fine -- relay_tenant_key wins.
--
--   update sms_config
--      set relay_tenant_key = '<ORG_SMS_RELAY_TENANT_KEY>'
--    where org_id = (select id from organizations where slug = '<org-slug>');
--
--   -- or, if the org has no sms_config row yet:
--   insert into sms_config (org_id, relay_tenant_key, sender_id, enabled, send_on_giving)
--   select id, '<ORG_SMS_RELAY_TENANT_KEY>', 'ChurchOS', true, true
--     from organizations where slug = '<org-slug>'
--   on conflict (org_id) do update set relay_tenant_key = excluded.relay_tenant_key;
