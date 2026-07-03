-- ChurchOS v2 — Migration 024: SMS via Arkesel (server-side, key never leaves DB)
-- Uses pg_net to POST to Arkesel's v2 API from Postgres. The API key lives in a
-- restricted table (no client SELECT); only SECURITY DEFINER functions read it.

create extension if not exists pg_net with schema extensions;

-- ── Per-org SMS configuration ────────────────────────────────────────────────
create table if not exists sms_config (
  org_id         uuid primary key references organizations(id) on delete cascade,
  provider       text not null default 'arkesel',
  api_key        text,                 -- secret; never exposed to the client
  sender_id      text not null default 'ChurchOS',   -- Arkesel-approved sender (≤11 chars)
  enabled        boolean not null default true,
  send_on_giving boolean not null default true,
  updated_at     timestamptz not null default now()
);
alter table sms_config enable row level security;
-- No policies => authenticated/anon cannot read or write directly. All access
-- goes through the SECURITY DEFINER functions below (which check org + role).

-- ── Helpers ──────────────────────────────────────────────────────────────────
-- Normalise a phone number to Arkesel's international format (Ghana-aware).
create or replace function _norm_msisdn(p text)
returns text language plpgsql immutable as $$
declare d text;
begin
  d := regexp_replace(coalesce(p,''), '\D', '', 'g');
  if d = '' then return null; end if;
  if left(d,3) = '233' then return d; end if;
  if left(d,1) = '0' and length(d) = 10 then return '233' || substring(d from 2); end if;
  if length(d) = 9 then return '233' || d; end if;
  return d;  -- already international / unknown format — send as-is
end;
$$;

-- Fire a single Arkesel v2 send for a set of recipients.
create or replace function _arkesel_send(p_api_key text, p_sender text, p_message text, p_recipients text[])
returns bigint language plpgsql security definer set search_path = public, extensions, net as $$
declare req_id bigint;
begin
  select net.http_post(
    url     := 'https://sms.arkesel.com/api/v2/sms/send',
    headers := jsonb_build_object('api-key', p_api_key, 'Content-Type', 'application/json'),
    body    := jsonb_build_object('sender', p_sender, 'message', p_message, 'recipients', to_jsonb(p_recipients))
  ) into req_id;
  return req_id;
end;
$$;

-- ── Admin-facing settings (never returns the api_key) ────────────────────────
create or replace function sms_settings_get(p_org_id uuid)
returns jsonb language plpgsql security definer as $$
declare c sms_config%rowtype;
begin
  if not auth_can_write('comms') then raise exception 'Not authorized'; end if;
  select * into c from sms_config where org_id = p_org_id;
  if not found then
    return jsonb_build_object('configured', false, 'enabled', false,
                              'sender_id', 'ChurchOS', 'send_on_giving', true);
  end if;
  return jsonb_build_object(
    'configured', c.api_key is not null and c.api_key <> '',
    'enabled', c.enabled, 'sender_id', c.sender_id, 'send_on_giving', c.send_on_giving);
end;
$$;
grant execute on function sms_settings_get(uuid) to authenticated;

create or replace function sms_settings_set(p_org_id uuid, p_enabled boolean, p_sender_id text, p_send_on_giving boolean)
returns void language plpgsql security definer as $$
begin
  if not auth_can_write('comms') then raise exception 'Not authorized'; end if;
  if (select org_id from profiles where id = auth.uid()) is distinct from p_org_id then
    raise exception 'Wrong organization';
  end if;
  insert into sms_config (org_id, enabled, sender_id, send_on_giving, updated_at)
  values (p_org_id, p_enabled, coalesce(nullif(trim(p_sender_id),''),'ChurchOS'), p_send_on_giving, now())
  on conflict (org_id) do update
    set enabled = excluded.enabled, sender_id = excluded.sender_id,
        send_on_giving = excluded.send_on_giving, updated_at = now();
end;
$$;
grant execute on function sms_settings_set(uuid, boolean, text, boolean) to authenticated;

-- ── Bulk send (Communications page) ──────────────────────────────────────────
create or replace function send_sms(p_org_id uuid, p_recipients text[], p_message text)
returns jsonb language plpgsql security definer as $$
declare
  c sms_config%rowtype;
  v_norm text[];
  r text;
begin
  if not auth_can_write('comms') then raise exception 'Not authorized'; end if;
  if (select org_id from profiles where id = auth.uid()) is distinct from p_org_id then
    raise exception 'Wrong organization';
  end if;
  select * into c from sms_config where org_id = p_org_id;
  if not found or coalesce(c.api_key,'') = '' then raise exception 'SMS is not configured'; end if;
  if not c.enabled then raise exception 'SMS is disabled for this organization'; end if;
  if coalesce(trim(p_message),'') = '' then raise exception 'Message is empty'; end if;

  v_norm := array(select distinct _norm_msisdn(x) from unnest(p_recipients) x
                  where _norm_msisdn(x) is not null);
  if array_length(v_norm,1) is null then raise exception 'No valid phone numbers'; end if;

  perform _arkesel_send(c.api_key, c.sender_id, p_message, v_norm);
  return jsonb_build_object('status','sent','count', array_length(v_norm,1));
end;
$$;
grant execute on function send_sms(uuid, text[], text) to authenticated;

-- ── Auto-SMS a thank-you when a gift is recorded ─────────────────────────────
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
  if not found or coalesce(c.api_key,'') = '' or not c.enabled or not c.send_on_giving then
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

  perform _arkesel_send(c.api_key, c.sender_id, v_msg, array[v_phone]);
  return NEW;
exception when others then
  -- Never let an SMS failure block the giving insert.
  return NEW;
end;
$$;

drop trigger if exists trg_giving_sms on giving;
create trigger trg_giving_sms after insert on giving
  for each row execute function giving_sms_notify();

-- ── Set your Arkesel API key ─────────────────────────────────────────────────
-- Do NOT commit the real key to git. Run the statement below directly in the
-- Supabase SQL editor, replacing <YOUR_ARKESEL_API_KEY> and the slug if needed:
--
--   insert into sms_config (org_id, api_key, sender_id, enabled, send_on_giving)
--   select id, '<YOUR_ARKESEL_API_KEY>', 'ChurchOS', true, true
--     from organizations where slug = 'immanuel'
--   on conflict (org_id) do update set api_key = excluded.api_key;
