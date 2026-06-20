// ChurchOS v2 — Database layer with offline queue
// Wraps Supabase calls; queues mutations when offline and syncs on reconnect.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const { createClient } = window.supabase;
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── OFFLINE QUEUE (IndexedDB via a small wrapper) ───────────────────────────
const DB_NAME = 'churchos_offline';
const STORE   = 'queue';
let idb = null;

async function openIDB() {
  if (idb) return idb;
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => { idb = e.target.result; res(idb); };
    req.onerror   = e => rej(e.target.error);
  });
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
    return { data, queued: true };
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
    count:  (orgId) => supabase.from('members').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('is_active', true),
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

  // QR Registrations
  qrRegs: {
    list: (orgId, imported = false) =>
      supabase.from('qr_registrations').select('*').eq('org_id', orgId).eq('imported', imported).order('created_at', { ascending: false }),
    import: (regId, orgId) => supabase.rpc('import_qr_registration', { p_reg_id: regId, p_org_id: orgId }),
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
    insert: (data) => dbInsert('giving', data),
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

  // Finance — Payroll
  payroll: {
    list:   (orgId, period = null) => {
      let q = supabase.from('payroll').select('*').eq('org_id', orgId);
      if (period) q = q.eq('pay_period', period);
      return q.order('created_at', { ascending: false });
    },
    insert: (data) => dbInsert('payroll', data),
    update: (id, data) => dbUpdate('payroll', data, { id }),
    delete: (id) => dbDelete('payroll', { id }),
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

  // Organizations
  org: {
    get:    (id) => supabase.from('organizations').select('*').eq('id', id).single(),
    update: (id, data) => supabase.from('organizations').update(data).eq('id', id),
    bySlug: (slug) => supabase.from('organizations').select('*').eq('slug', slug).single(),
  },
};
