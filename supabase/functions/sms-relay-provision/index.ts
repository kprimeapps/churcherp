// ChurchOS — Edge Function: sms-relay-provision
//
// Idempotently provisions an SMS Relay *tenant* + tenant API key for the
// caller's org and stores the key in sms_config.relay_tenant_key. This is the
// Phase-2 automation of what was done manually for the Immanuel pilot.
//
// Why an Edge Function (and not pg_net like the rest of the SMS layer):
// provisioning needs a synchronous request/response (create tenant -> read its
// id -> create a key -> read it), which pg_net's fire-and-forget model can't do.
//
// Secrets (set via `supabase secrets set ...`, never in the client or git):
//   SMS_RELAY_SAAS_KEY    - the ChurchOS SaaS-app key (sk_...) held platform-side
//   SMS_RELAY_BASE_URL    - defaults to the live backend if unset
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY - provided by the
//                           platform to Edge Functions automatically.
//
// AuthZ: the caller's JWT must resolve to a profile whose org has comms-write
// permission (auth_can_write('comms')). The SaaS key and service role never
// leave the function.

import { createClient } from "jsr:@supabase/supabase-js@2";

const RELAY_BASE = Deno.env.get("SMS_RELAY_BASE_URL") ??
  "https://sms-relay-indx.onrender.com";
const SAAS_KEY = Deno.env.get("SMS_RELAY_SAAS_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!SAAS_KEY) return json({ error: "server_misconfigured" }, 500);

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "unauthorized" }, 401);
    }

    // Caller-bound client: identifies the user and runs their RBAC checks under
    // their own RLS context.
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userErr } = await caller.auth.getUser();
    if (userErr || !user) return json({ error: "unauthorized" }, 401);

    // Comms-write permission (same gate the SMS RPCs use).
    const { data: canWrite, error: permErr } = await caller.rpc(
      "auth_can_write",
      { p_module: "comms" },
    );
    if (permErr || canWrite !== true) return json({ error: "forbidden" }, 403);

    // Resolve the caller's org.
    const { data: prof, error: profErr } = await caller
      .from("profiles").select("org_id").eq("id", user.id).single();
    if (profErr || !prof?.org_id) return json({ error: "no_org" }, 403);
    const orgId: string = prof.org_id;

    // Service-role client for privileged reads/writes (sms_config has RLS with
    // no policies; service role bypasses RLS).
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Idempotency: already provisioned -> no-op.
    const { data: existing } = await admin
      .from("sms_config").select("relay_tenant_key").eq("org_id", orgId)
      .maybeSingle();
    if (existing?.relay_tenant_key) {
      return json({ status: "already_provisioned" });
    }

    const { data: org } = await admin
      .from("organizations").select("name, slug").eq("id", orgId).single();
    const orgName = org?.name ?? org?.slug ?? "Church";

    const relayHeaders = {
      "Authorization": `Bearer ${SAAS_KEY}`,
      "Content-Type": "application/json",
    };

    // 1) Create the tenant (external_tenant_ref = org id for traceability).
    const tRes = await fetch(`${RELAY_BASE}/v1/tenants`, {
      method: "POST",
      headers: relayHeaders,
      body: JSON.stringify({ name: orgName, external_tenant_ref: orgId }),
    });
    if (!tRes.ok) {
      return json(
        { error: "tenant_create_failed", detail: await tRes.text() },
        502,
      );
    }
    const tenantId: string = (await tRes.json()).tenant.id;

    // 2) Mint a tenant API key.
    const kRes = await fetch(`${RELAY_BASE}/v1/tenants/${tenantId}/api-keys`, {
      method: "POST",
      headers: relayHeaders,
      body: JSON.stringify({ label: `churchos-${org?.slug ?? orgId}` }),
    });
    if (!kRes.ok) {
      return json(
        { error: "key_create_failed", detail: await kRes.text() },
        502,
      );
    }
    const tenantKey: string = (await kRes.json()).api_key;

    // 3) Store on the org's sms_config (create the row if needed).
    const { error: upErr } = await admin.from("sms_config").upsert({
      org_id: orgId,
      relay_tenant_key: tenantKey,
      enabled: true,
      send_on_giving: true,
      sender_id: "ChurchOS",
    }, { onConflict: "org_id" });
    if (upErr) return json({ error: "store_failed", detail: upErr.message }, 500);

    return json({ status: "provisioned", tenant_id: tenantId });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
