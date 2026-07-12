// ChurchOS v2 — Database layer with offline queue
// Wraps Supabase calls; queues mutations when offline and syncs on reconnect.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const { createClient } = window.supabase;
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── OFFLINE QUEUE (IndexedDB via a small wrapper) ───────────────────────────
const DB_NAME = 'churchos_offline';
const STORE   = 'queue';
const CACHE   = 'cache';   // key/value cache of read data for offline use
let idb = null;

async function openIDB() {
  if (idb) return idb;
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(CACHE))
        db.createObjectStore(CACHE, { keyPath: 'key' });
    };
    req.onsuccess = e => { idb = e.target.result; res(idb); };
    req.onerror   = e => rej(e.target.error);
  });
}

// ─── READ CACHE (key/value) ──────────────────────────────────────────────────
// Snapshot data while online so the key offline flows (member lookup, giving,
// attendance) still render when the network is gone.
export async function cachePut(key, value) {
  try {
    const db = await openIDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(CACHE, 'readwrite');
      tx.objectStore(CACHE).put({ key, value, ts: Date.now() });
      tx.oncomplete = () => res();
      tx.onerror = e => rej(e.target.error);
    });
  } catch { /* cache is best-effort */ }
}

export async function cacheGet(key) {
  try {
    const db = await openIDB();
    return await new Promise((res, rej) => {
      const tx = db.transaction(CACHE, 'readonly');
      const req = tx.objectStore(CACHE).get(key);
      req.onsuccess = () => res(req.result ? req.result.value : null);
      req.onerror = e => rej(e.target.error);
    });
  } catch { return null; }
}

async function enqueue(op) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx   = db.transaction(STORE, 'readwrite');
    const req  = tx.objectStore(STORE).add({ ...op, ts: Date.now() });
    req.onsuccess = () => res(req.result);
    req.onerror   = e  => rej(e.target.error);
  });
}

async function dequeue(id) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => res();
    req.onerror   = e  => rej(e.target.error);
  });
}

async function getAllQueued() {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = e  => rej(e.target.error);
  });
}

// ─── SYNC ────────────────────────────────────────────────────────────────────
let syncing = false;
export async function syncQueue() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  try {
    const items = await getAllQueued();
    for (const item of items) {
      try {
        await replayOp(item);
        await dequeue(item.id);
      } catch (e) {
        console.warn('Sync failed for item', item.id, e);
      }
    }
    if (items.length > 0) window.dispatchEvent(new CustomEvent('churchos:synced', { detail: { count: items.length } }));
  } finally {
    syncing = false;
  }
}

async function replayOp({ table, op, data, match }) {
  switch (op) {
    case 'insert': {
      const { error } = await supabase.from(table).insert(data);
      if (error) throw error;
      break;
    }
    case 'update': {
      const { error } = await supabase.from(table).update(data).match(match);
      if (error) throw error;
      break;
    }
    case 'delete': {
      const { error } = await supabase.from(table).delete().match(match);
      if (error) throw error;
      break;
    }
  }
}

window.addEventListener('online', () => syncQueue());

// ─── CORE CRUD ───────────────────────────────────────────────────────────────
export async function dbInsert(table, data) {
  if (!navigator.onLine) {
    await enqueue({ table, op: 'insert', data });
    // Synthesize a local record so the UI can render it and print receipts.
    // The temp id is replaced by the server's on sync.
    const local = { ...data, id: `local-${crypto.randomUUID()}`, _local: true,
                    created_at: new Date().toISOString() };
    return { data: local, queued: true };
  }
  const { data: row, error } = await supabase.from(table).insert(data).select().single();
  if (error) throw error;
  return { data: row };
}

export async function dbUpdate(table, data, match) {
  if (!navigator.onLine) {
    await enqueue({ table, op: 'update', data, match });
    return { queued: true };
  }
  const { data: row, error } = await supabase.from(table).update(data).match(match).select().single();
  if (error) throw error;
  return { data: row };
}

export async function dbDelete(table, match) {
  if (!navigator.onLine) {
    await enqueue({ table, op: 'delete', match });
    return { queued: true };
  }
  const { error } = await supabase.from(table).delete().match(match);
  if (error) throw error;
  return {};
}

// ─── QUERIES ─────────────────────────────────────────────────────────────────
// All queries accept an orgId so callers don't need to think about scoping.

export const db = {
  // Members
  members: {
    list: (orgId, { search, active = true, group } = {}) => {
      let q = supabase.from('members').select('*').eq('org_id', orgId);
      if (active !== null) q = q.eq('is_active', active);
      if (group)  q = q.eq('group_name', group);
      if (search) q = q.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,phone.ilike.%${search}%,membership_no.ilike.%${search}%`);
      return q.order('first_name');
    },
    get:    (id) => supabase.from('members').select('*').eq('id', id).single(),
    insert: (data) => dbInsert('members', data),
    update: (id, data) => dbUpdate('members', data, { id }),
    delete: (id) => dbDelete('members', { id }),
    count:  (orgId) => supabase.from('members').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('is_active', true).eq('is_member', true),
  },

  // Attendance
  attendance: {
    list: (orgId, { date, type, limit = 200 } = {}) => {
      let q = supabase.from('attendance')
        .select('*, members(first_name,last_name,membership_no,role)')
        .eq('org_id', orgId);
      if (date) q = q.eq('service_date', date);
      if (type) q = q.eq('service_type', type);
      return q.order('created_at', { ascending: false }).limit(limit);
    },
    forDate: (orgId, date, type) => {
      let q = supabase.from('attendance')
        .select('*, members(first_name,last_name)')
        .eq('org_id', orgId).eq('service_date', date);
      if (type) q = q.eq('service_type', type);
      return q.order('created_at', { ascending: false });
    },
    trend:  (orgId) => supabase.rpc('get_attendance_trend', { p_org_id: orgId }),
    insert: (data) => dbInsert('attendance', data),
    delete: (id) => dbDelete('attendance', { id }),
  },

  // Online attendance (per-channel manual counts)
  online: {
    forDate: (orgId, date, type) =>
      supabase.from('online_attendance').select('*')
        .eq('org_id', orgId).eq('service_date', date).eq('service_type', type)
        .order('channel'),
    insert: (data) => dbInsert('online_attendance', data),
    update: (id, data) => dbUpdate('online_attendance', data, { id }),
    delete: (id) => dbDelete('online_attendance', { id }),
  },

  // Manual attendance summaries (service totals + group meetings)
  summaries: {
    forDate: (orgId, date) => supabase.from('attendance_summaries').select('*')
      .eq('org_id', orgId).eq('summary_date', date).is('group_name', null).order('service_type'),
    groupMeetings: (orgId, limit = 100) => supabase.from('attendance_summaries').select('*')
      .eq('org_id', orgId).not('group_name', 'is', null).order('summary_date', { ascending: false }).limit(limit),
    range: (orgId, start, end) => supabase.from('attendance_summaries').select('*')
      .eq('org_id', orgId).gte('summary_date', start).lte('summary_date', end),
    forGroup: (orgId, groupName, limit = 30) => supabase.from('attendance_summaries').select('*')
      .eq('org_id', orgId).eq('service_type', 'Group Meeting').eq('group_name', groupName)
      .order('summary_date', { ascending: false }).limit(limit),
    // Scoped upsert used by the Group Secretary kiosk (and admins).
    recordGroup: (groupName, date, count, male, female, children, notes) =>
      supabase.rpc('record_group_attendance', {
        p_group_name: groupName, p_date: date, p_count: count,
        p_male: male, p_female: female, p_children: children, p_notes: notes }),
    insert: (data) => dbInsert('attendance_summaries', data),
    update: (id, data) => dbUpdate('attendance_summaries', data, { id }),
    delete: (id) => dbDelete('attendance_summaries', { id }),
  },

  // Reports — raw rows for client-side roll-ups
  reports: {
    givingByMember: (orgId, memberId) => supabase.from('giving').select('*')
      .eq('org_id', orgId).eq('member_id', memberId).order('given_date', { ascending: false }),
    givingRange: (orgId, start, end) => supabase.from('giving')
      .select('amount,category,given_date,member_id,member_name,payment_method')
      .eq('org_id', orgId).gte('given_date', start).lte('given_date', end),
    expensesRange: (orgId, start, end) => supabase.from('expenses')
      .select('amount,category,expense_date,title,vendor')
      .eq('org_id', orgId).gte('expense_date', start).lte('expense_date', end),
    membersJoined: (orgId) => supabase.from('members')
      .select('date_joined,created_at').eq('org_id', orgId),
    verifyCounts: async (orgId) => {
      const total = await supabase.from('members').select('id', { count: 'exact', head: true })
        .eq('org_id', orgId).eq('is_active', true).eq('is_member', true);
      const verified = await supabase.from('members').select('id', { count: 'exact', head: true })
        .eq('org_id', orgId).eq('is_active', true).eq('is_member', true).eq('member_confirmed', true);
      return { total: total.count || 0, verified: verified.count || 0 };
    },
    attendanceRange: (orgId, start, end) => supabase.from('attendance')
      .select('service_date,service_type,member_id').eq('org_id', orgId)
      .gte('service_date', start).lte('service_date', end),
  },

  // Team / roles
  team: {
    list: (orgId) => supabase.from('profiles')
      .select('id,first_name,last_name,role,group_name').eq('org_id', orgId).order('first_name'),
    setRole: (userId, role, group = null) =>
      supabase.rpc('set_user_role', { p_user_id: userId, p_role: role, p_group: group }),
    remove: (userId) => supabase.rpc('remove_team_member', { p_user_id: userId }),
    invites: (orgId) => supabase.from('org_invites')
      .select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
    invite: (orgId, email, role) => supabase.from('org_invites')
      .insert({ org_id: orgId, email, role }),
    revokeInvite: (id) => supabase.from('org_invites').delete().eq('id', id),
  },

  // QR Registrations
  qrRegs: {
    list: (orgId, imported = false) =>
      supabase.from('qr_registrations').select('*').eq('org_id', orgId).eq('imported', imported).order('created_at', { ascending: false }),
    import: (regId, orgId) => supabase.rpc('import_qr_registration', { p_reg_id: regId, p_org_id: orgId }),
    linkToMembers: (orgId) => supabase.rpc('link_qr_registrations', { p_org_id: orgId }),
    // Stable, regenerable QR id for a member (creates one if missing).
    memberQr: (memberId, orgId) => supabase.rpc('ensure_member_qr', { p_member_id: memberId, p_org_id: orgId }),
  },

  // Giving
  giving: {
    list: (orgId, { year, month, category } = {}) => {
      let q = supabase.from('giving').select('*, members(first_name,last_name)').eq('org_id', orgId);
      if (year)     q = q.gte('given_date', `${year}-01-01`).lte('given_date', `${year}-12-31`);
      if (month)    q = q.gte('given_date', `${year}-${String(month).padStart(2,'0')}-01`);
      if (category) q = q.eq('category', category);
      return q.order('given_date', { ascending: false });
    },
    summary: (orgId) => supabase.rpc('get_giving_by_category', { p_org_id: orgId }),
    // Distinct names of non-member givers (for repeat-giver autocomplete).
    donorNames: (orgId) => supabase.from('giving').select('member_name')
      .eq('org_id', orgId).is('member_id', null).not('member_name', 'is', null).limit(2000),
    insert: (data) => dbInsert('giving', data),
    update: (id, data) => dbUpdate('giving', data, { id }),
    delete: (id) => dbDelete('giving', { id }),
  },

  // Groups
  groups: {
    list:   (orgId) => supabase.from('groups').select('*, members!leader_id(first_name,last_name)').eq('org_id', orgId).order('name'),
    insert: (data) => dbInsert('groups', data),
    update: (id, data) => dbUpdate('groups', data, { id }),
    delete: (id) => dbDelete('groups', { id }),
  },

  // Events
  events: {
    list: (orgId, upcoming = false) => {
      let q = supabase.from('events').select('*').eq('org_id', orgId);
      if (upcoming) q = q.gte('start_date', new Date().toISOString());
      return q.order('start_date', { ascending: false });
    },
    insert: (data) => dbInsert('events', data),
    update: (id, data) => dbUpdate('events', data, { id }),
    delete: (id) => dbDelete('events', { id }),
  },

  // Volunteers
  volunteers: {
    list:   (orgId) => supabase.from('volunteers').select('*, members(first_name,last_name,role)').eq('org_id', orgId).eq('is_active', true).order('department'),
    insert: (data) => dbInsert('volunteers', data),
    update: (id, data) => dbUpdate('volunteers', data, { id }),
    delete: (id) => dbDelete('volunteers', { id }),
  },

  // Visitors
  visitors: {
    list: (orgId, followedUp = null) => {
      let q = supabase.from('visitors').select('*').eq('org_id', orgId);
      if (followedUp !== null) q = q.eq('followed_up', followedUp);
      return q.order('visit_date', { ascending: false });
    },
    insert: (data) => dbInsert('visitors', data),
    update: (id, data) => dbUpdate('visitors', data, { id }),
    delete: (id) => dbDelete('visitors', { id }),
    convert: (visitorId, orgId) => supabase.rpc('convert_visitor_to_member', { p_visitor_id: visitorId, p_org_id: orgId }),
  },

  // Newcomer class teachers
  ncTeachers: {
    list: (orgId) => supabase.from('newcomer_teachers').select('*').eq('org_id', orgId).order('name'),
    insert: (data) => dbInsert('newcomer_teachers', data),
    update: (id, data) => dbUpdate('newcomer_teachers', data, { id }),
    delete: (id) => dbDelete('newcomer_teachers', { id }),
  },

  // Newcomer class attendance
  ncClasses: {
    list: (orgId) => supabase.from('newcomer_classes')
      .select('*, visitors(first_name,last_name), newcomer_teachers(name)')
      .eq('org_id', orgId).order('date_attended', { ascending: false }),
    insert: (data) => dbInsert('newcomer_classes', data),
    delete: (id) => dbDelete('newcomer_classes', { id }),
  },

  // Newcomer lesson list (permission-scoped editing for visitors-writers)
  ncLessons: {
    save: (orgId, lessons, optional) =>
      supabase.rpc('set_newcomer_lessons', { p_org_id: orgId, p_lessons: lessons, p_optional: optional }),
  },

  // Welfare
  welfare: {
    list:   (orgId, status = null) => {
      let q = supabase.from('welfare').select('*').eq('org_id', orgId);
      if (status) q = q.eq('status', status);
      return q.order('welfare_date', { ascending: false });
    },
    insert: (data) => dbInsert('welfare', data),
    update: (id, data) => dbUpdate('welfare', data, { id }),
    delete: (id) => dbDelete('welfare', { id }),
  },

  // Education
  education: {
    list:   (orgId) => supabase.from('education').select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
    insert: (data) => dbInsert('education', data),
    update: (id, data) => dbUpdate('education', data, { id }),
    delete: (id) => dbDelete('education', { id }),
  },

  // Missions
  missions: {
    list:   (orgId) => supabase.from('missions').select('*').eq('org_id', orgId).order('start_date', { ascending: false }),
    insert: (data) => dbInsert('missions', data),
    update: (id, data) => dbUpdate('missions', data, { id }),
    delete: (id) => dbDelete('missions', { id }),
  },

  // Scholarships
  scholarships: {
    list:   (orgId) => supabase.from('scholarships').select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
    insert: (data) => dbInsert('scholarships', data),
    update: (id, data) => dbUpdate('scholarships', data, { id }),
    delete: (id) => dbDelete('scholarships', { id }),
  },

  // Communications
  communications: {
    list:   (orgId) => supabase.from('communications').select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
    insert: (data) => dbInsert('communications', data),
    update: (id, data) => dbUpdate('communications', data, { id }),
    delete: (id) => dbDelete('communications', { id }),
  },

  // Family Life
  familyLife: {
    list:   (orgId, type = null) => {
      let q = supabase.from('family_life').select('*').eq('org_id', orgId);
      if (type) q = q.eq('type', type);
      return q.order('event_date', { ascending: false });
    },
    insert: (data) => dbInsert('family_life', data),
    update: (id, data) => dbUpdate('family_life', data, { id }),
    delete: (id) => dbDelete('family_life', { id }),
  },

  // Finance — Accounts
  accounts: {
    list:   (orgId) => supabase.from('accounts').select('*').eq('org_id', orgId).eq('is_active', true).order('account_type,name'),
    insert: (data) => dbInsert('accounts', data),
    update: (id, data) => dbUpdate('accounts', data, { id }),
    delete: (id) => dbDelete('accounts', { id }),
  },

  // Finance — Transactions
  transactions: {
    list: (orgId, { limit = 100 } = {}) =>
      supabase.from('transactions')
        .select('*, debit_account:debit_account_id(name), credit_account:credit_account_id(name)')
        .eq('org_id', orgId)
        .order('transaction_date', { ascending: false })
        .limit(limit),
    insert: (data) => dbInsert('transactions', data),
    delete: (id) => dbDelete('transactions', { id }),
  },

  // Finance — Budgets
  budgets: {
    list:   (orgId) => supabase.from('budgets').select('*, budget_lines(*)').eq('org_id', orgId).order('fiscal_year', { ascending: false }),
    insert: (data) => dbInsert('budgets', data),
    update: (id, data) => dbUpdate('budgets', data, { id }),
    addLine: (data) => dbInsert('budget_lines', data),
    updateLine: (id, data) => dbUpdate('budget_lines', data, { id }),
    deleteLine: (id) => dbDelete('budget_lines', { id }),
  },

  // Finance — Payroll (Ghana model)
  payroll: {
    list: (orgId, period = null) => {
      let q = supabase.from('payroll').select('*').eq('org_id', orgId);
      if (period) q = q.eq('pay_period', period);
      return q.order('member_name');
    },
    get:    (id) => supabase.from('payroll').select('*').eq('id', id).single(),
    insert: (data) => dbInsert('payroll', data),
    update: (id, data) => dbUpdate('payroll', data, { id }),
    delete: (id) => dbDelete('payroll', { id }),
  },

  // Reconciliation
  reconciliations: {
    list:   (orgId) => supabase.from('reconciliations').select('*, accounts(name)').eq('org_id', orgId).order('period', { ascending: false }),
    get:    (id) => supabase.from('reconciliations').select('*, reconciliation_items(*), accounts(name)').eq('id', id).single(),
    insert: (data) => dbInsert('reconciliations', data),
    update: (id, data) => dbUpdate('reconciliations', data, { id }),
    delete: (id) => dbDelete('reconciliations', { id }),
    addItem:    (data) => dbInsert('reconciliation_items', data),
    updateItem: (id, data) => dbUpdate('reconciliation_items', data, { id }),
    deleteItem: (id) => dbDelete('reconciliation_items', { id }),
  },

  // Expenses
  expenses: {
    list: (orgId, status = null) => {
      let q = supabase.from('expenses').select('*').eq('org_id', orgId);
      if (status) q = q.eq('status', status);
      return q.order('expense_date', { ascending: false });
    },
    insert: (data) => dbInsert('expenses', data),
    update: (id, data) => dbUpdate('expenses', data, { id }),
    delete: (id) => dbDelete('expenses', { id }),
  },

  // Dashboard
  dashboard: {
    stats: (orgId) => supabase.rpc('get_dashboard_stats', { p_org_id: orgId }),
  },

  // Reconciliation snapshots (rich tool — JSON state per account+period)
  reconSnap: {
    listForOrg: (orgId) => supabase.from('recon_snapshots').select('*').eq('org_id', orgId),
    upsert: (orgId, account, period, state) =>
      supabase.from('recon_snapshots')
        .upsert({ org_id: orgId, account, period, state, updated_at: new Date().toISOString() },
                { onConflict: 'org_id,account,period' }),
    remove: (orgId, account, period) =>
      supabase.from('recon_snapshots').delete().match({ org_id: orgId, account, period }),
  },

  // Budget plan (rich tool — single JSON doc per org)
  budgetPlan: {
    get:    (orgId) => supabase.from('budget_plans').select('plan').eq('org_id', orgId).maybeSingle(),
    upsert: (orgId, plan) =>
      supabase.from('budget_plans')
        .upsert({ org_id: orgId, plan, updated_at: new Date().toISOString() }, { onConflict: 'org_id' }),
  },

  // SMS (Arkesel, server-side)
  sms: {
    settings: (orgId) => supabase.rpc('sms_settings_get', { p_org_id: orgId }),
    saveSettings: (orgId, enabled, senderId, sendOnGiving) =>
      supabase.rpc('sms_settings_set', { p_org_id: orgId, p_enabled: enabled, p_sender_id: senderId, p_send_on_giving: sendOnGiving }),
    send: (orgId, recipients, message) =>
      supabase.rpc('send_sms', { p_org_id: orgId, p_recipients: recipients, p_message: message }),
  },

  // Organizations
  org: {
    get:    (id) => supabase.from('organizations').select('*').eq('id', id).single(),
    update: (id, data) => supabase.from('organizations').update(data).eq('id', id),
    bySlug: (slug) => supabase.from('organizations').select('*').eq('slug', slug).single(),
  },
};
