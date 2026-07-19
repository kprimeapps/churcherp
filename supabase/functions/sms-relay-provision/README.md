# sms-relay-provision (Edge Function)

Auto-provisions an SMS Relay **tenant + tenant API key** for a ChurchOS org and
stores the key in `sms_config.relay_tenant_key`. This is the Phase-2 automation
of the manual step used for the Immanuel pilot.

Called from the admin SMS settings page via `db.sms.provisionRelay()`
(`supabase.functions.invoke('sms-relay-provision')`). Idempotent — a second call
for an already-provisioned org is a no-op.

## One-time setup

1. Set the secrets (never commit these):
   ```bash
   supabase secrets set SMS_RELAY_SAAS_KEY=sk_...        # the ChurchOS SaaS-app key
   supabase secrets set SMS_RELAY_BASE_URL=https://sms-relay-indx.onrender.com
   ```
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
   injected automatically.

2. Deploy:
   ```bash
   supabase functions deploy sms-relay-provision
   ```

## Flow

1. Verifies the caller (JWT) has `auth_can_write('comms')` and resolves their org.
2. `POST /v1/tenants` (with the SaaS key) → tenant id.
3. `POST /v1/tenants/{id}/api-keys` → tenant key.
4. Upserts `sms_config` with `relay_tenant_key` (enabled, send_on_giving = true).

After provisioning, an admin still generates a phone-registration token (SMS
Relay side) and registers that org's gateway phone.
