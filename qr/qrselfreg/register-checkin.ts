// Supabase Edge Function: register-checkin
// Deploy: supabase functions deploy register-checkin
//
// Called by register.html instead of writing directly to the attendees table.
// Uses the service-role key (server-side only) to CREATE TABLE if it doesn't
// exist, then inserts the record. The anon key cannot do DDL — this function
// bridges that gap securely.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { person, tableName } = body;

  // Validate inputs
  if (!person || !tableName) return json({ error: 'Missing person or tableName' }, 400);
  if (!person.id || !person.firstName) return json({ error: 'Missing required person fields' }, 400);

  // Table name safety — only allow alphanumeric and underscores
  if (!/^[a-zA-Z0-9_]+$/.test(tableName)) return json({ error: 'Invalid table name' }, 400);

  // Use service-role key — this is server-side only, never exposed to the client
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );

  // ── 1. Create table if it doesn't exist ─────────────────────────────────────
  const createSQL = `
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      id           TEXT PRIMARY KEY,
      "firstName"  TEXT NOT NULL,
      "lastName"   TEXT,
      email        TEXT,
      phone        TEXT,
      role         TEXT,
      "createdAt"  BIGINT,
      "checkedIn"  BOOLEAN DEFAULT false
    );

    -- RLS
    ALTER TABLE "${tableName}" ENABLE ROW LEVEL SECURITY;

    -- Policies (CREATE OR REPLACE not supported for RLS — use DO block to avoid errors on re-runs)
    DO $do$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = '${tableName}' AND policyname = 'public insert'
      ) THEN
        EXECUTE 'CREATE POLICY "public insert" ON "${tableName}" FOR INSERT WITH CHECK (true)';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = '${tableName}' AND policyname = 'service read'
      ) THEN
        EXECUTE 'CREATE POLICY "service read" ON "${tableName}" FOR SELECT USING (true)';
      END IF;
    END
    $do$;

    -- Unique index on firstName + phone (duplicate guard)
    CREATE UNIQUE INDEX IF NOT EXISTS "${tableName}_name_phone_uidx"
      ON "${tableName}" (LOWER(TRIM("firstName")), TRIM(phone))
      WHERE phone IS NOT NULL AND phone <> '';
  `;

  const { error: ddlError } = await supabase.rpc('exec_sql', { sql: createSQL });

  // If exec_sql RPC doesn't exist, fall back to pg_query via the admin API
  // (exec_sql is a helper function — see setup SQL below)
  if (ddlError) {
    console.error('DDL error:', ddlError);
    return json({ error: 'Could not initialise table: ' + ddlError.message }, 500);
  }

  // ── 2. Insert the person record ──────────────────────────────────────────────
  const { data, error: insertError } = await supabase
    .from(tableName)
    .insert({
      id:          person.id,
      firstName:   person.firstName,
      lastName:    person.lastName   || '',
      email:       person.email      || '',
      phone:       person.phone      || '',
      role:        person.role       || 'General',
      createdAt:   person.createdAt  || Date.now(),
      checkedIn:   false,
    })
    .select('id, firstName, lastName, role')
    .single();

  if (insertError) {
    // Postgres unique violation = duplicate
    const isDuplicate = insertError.code === '23505';
    if (isDuplicate) return json({ error: 'duplicate', code: '23505' }, 409);
    console.error('Insert error:', insertError);
    return json({ error: insertError.message }, 500);
  }

  return json({ success: true, person: data });
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
