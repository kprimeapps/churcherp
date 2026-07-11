// ChurchOS v2 — Main App Controller
const APP_BUILD = 'b35 · Pending Import type badge + filter';
const intOrNull = (id) => {
  const v = document.getElementById(id).value;
  return v !== '' ? parseInt(v, 10) : null;
};

// Nudge Free/Starter orgs toward an upgrade as they approach their member cap.
const PLAN_MEMBER_LIMIT = { free: 50, starter: 200 };  // pro/enterprise = unlimited
function checkPlanBanner() {
  const banner = document.getElementById('plan-banner');
  if (!banner) return;
  const plan = currentOrg?.plan;
  const limit = PLAN_MEMBER_LIMIT[plan];
  if (!limit) return;                              // unlimited plan
  if (sessionStorage.getItem('plan_banner_dismissed') === plan) return;
  const count = allMembers.length;
  if (count < Math.ceil(limit * 0.8)) return;      // only when ≥ 80% used
  const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
  const atLimit = count >= limit;
  document.getElementById('plan-banner-text').innerHTML = atLimit
    ? `<strong>${planName} plan limit reached</strong> — ${count}/${limit} members. Upgrade to add more:`
    : `You're using <strong>${count} of ${limit}</strong> members on the ${planName} plan. Upgrade for more:`;
  banner.style.display = 'flex';
  document.getElementById('plan-banner-x').onclick = () => {
    banner.style.display = 'none';
    sessionStorage.setItem('plan_banner_dismissed', plan);
  };
}
import { supabase, db, syncQueue, cachePut, cacheGet } from './db.js';
import { requireAuth, currentProfile, currentOrg, signOut } from './auth.js';
import {
  toast, openModal, closeModal, fmtDate, fmtMoney, fmtNum,
  initials, today, thisYear, thisMonth, debounce, buildTable,
  memberSelect, initOfflineBanner, navigate
} from './ui.js';
import { reconBoot, budgetBoot } from './finance-tools.js';
import {
  canSee, canWritePage, isOrgAdmin, pageAccess,
  ROLE_LABELS, ASSIGNABLE_ROLES, isKiosk, landingPage,
} from './permissions.js';

// ─── BOOT ─────────────────────────────────────────────────────────────────────
let ORG_ID, CURRENCY;
let allMembers = [];       // cached member list for autocomplete
let attRealtimeSub = null;

window.closeModal = closeModal; // expose for inline onclick

async function boot() {
  const session = await requireAuth('/index.html');
  if (!session) return;

  ORG_ID   = currentProfile.org_id;
  CURRENCY = currentOrg?.currency || 'USD';

  if (!ORG_ID) {
    window.location.href = '/index.html?onboard=1';
    return;
  }

  // Sidebar branding
  document.getElementById('brand-name').textContent = currentOrg?.name || 'ChurchOS';
  document.getElementById('brand-sub').textContent  = currentOrg?.sub_name || '';
  document.getElementById('sb-name').textContent = `${currentProfile.first_name || ''} ${currentProfile.last_name || ''}`.trim() || 'User';
  document.getElementById('sb-role').textContent = currentProfile.role || 'staff';
  document.getElementById('sb-avatar').textContent = initials(currentProfile.first_name, currentProfile.last_name);

  // RBAC: hide nav items this role can't access
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    if (!canSee(item.dataset.page)) item.classList.add('rbac-hidden');
  });

  // Kiosk mode (single-page roles like Usher): no sidebar, just a Sign out button
  if (isKiosk()) {
    document.body.classList.add('kiosk');
    const ks = document.getElementById('kiosk-signout');
    if (ks) { ks.style.display = ''; ks.addEventListener('click', () => signOut()); }
  }

  // Show the correct landing page immediately so no other page flashes first
  {
    const stored = sessionStorage.getItem('churchos_page');
    const initial = stored && canSee(stored) ? stored : landingPage();
    document.querySelectorAll('.erp-page').forEach(p => p.classList.toggle('active', p.id === initial));
    document.getElementById('topbar-title').textContent =
      document.querySelector(`.nav-item[data-page="${initial}"]`)?.dataset.title || '';
  }

  // Sidebar navigation
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => {
      const pageId = item.dataset.page;
      const title  = item.dataset.title || '';
      if (!canSee(pageId)) { toast('You don’t have access to that area', 'error'); return; }
      navigate(pageId, title);
      activatePage(pageId);
      window.__closeSidebar?.();
    });
  });

  // Dashboard stat links
  document.querySelectorAll('[data-page]').forEach(el => {
    if (!el.classList.contains('nav-item')) {
      el.addEventListener('click', e => {
        e.preventDefault();
        const pg = el.dataset.page;
        navigate(pg, el.textContent.replace('→','').trim());
        activatePage(pg);
        window.__closeSidebar?.();
      });
    }
  });

  // Mobile menu + tap-to-close backdrop
  const menuBtn = document.getElementById('menu-toggle');
  const sidebar = document.getElementById('sidebar');
  if (window.innerWidth <= 768) { menuBtn.style.display = 'flex'; }
  let backdrop = document.getElementById('sidebar-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'sidebar-backdrop';
    backdrop.className = 'sidebar-backdrop';
    document.body.appendChild(backdrop);
  }
  const openSidebar  = () => { sidebar.classList.add('open');  backdrop.classList.add('show'); };
  const closeSidebar = () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); };
  window.__closeSidebar = closeSidebar;
  menuBtn.addEventListener('click', () =>
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar());
  backdrop.addEventListener('click', closeSidebar);

  // Sign out
  document.getElementById('signout-btn').addEventListener('click', () => signOut());

  // Finance tabs
  document.querySelectorAll('.finance-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.finance-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ['ledger','budgets','payroll','accounts','reconciliation'].forEach(t => {
        document.getElementById(`ftab-${t}`).style.display = t === btn.dataset.ftab ? '' : 'none';
      });
      loadFinanceTab(btn.dataset.ftab);
    });
  });

  // QR page tabs
  document.querySelectorAll('#page-qr .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#page-qr .tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('#page-qr .tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab + '-panel').classList.add('active');
    });
  });

  initOfflineBanner();
  initDayCheckboxes();
  await prefetchMembers();
  checkPlanBanner();
  populateAllConfigTargets();   // fill configurable dropdowns from org settings
  initFormHandlers();
  initQRPage();
  initSettings();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  syncQueue();

  // When queued offline writes flush on reconnect, tell the user and refresh the
  // roster + current page so server ids/joins replace the local placeholders.
  window.addEventListener('churchos:synced', async e => {
    const n = e.detail?.count || 0;
    toast(`${n} offline change${n === 1 ? '' : 's'} synced`, 'success');
    await prefetchMembers();
    const cur = sessionStorage.getItem('churchos_page');
    if (cur) { loaded.delete(cur); activatePage(cur); }
  });

  // Load the last active page or dashboard
  let lastPage = sessionStorage.getItem('churchos_page') || landingPage();
  if (!canSee(lastPage)) lastPage = landingPage();
  navigate(lastPage, document.querySelector(`.nav-item[data-page="${lastPage}"]`)?.dataset.title || 'Dashboard');
  activatePage(lastPage);
}

// ─── PAGE ROUTER ──────────────────────────────────────────────────────────────
const loaded = new Set();
function activatePage(pageId) {
  // RBAC: block direct access to pages this role can't see
  if (!canSee(pageId)) {
    pageId = landingPage();
    navigate(pageId, document.querySelector(`.nav-item[data-page="${pageId}"]`)?.dataset.title || '');
  }
  // Mark page read-only (CSS hides add/edit/delete affordances) when no write access
  const pageEl = document.getElementById(pageId);
  if (pageEl) pageEl.classList.toggle('readonly', pageAccess(pageId) === 'read');

  if (loaded.has(pageId)) return; // data already loaded; realtime handles updates
  loaded.add(pageId);
  switch (pageId) {
    case 'page-dashboard':  loadDashboard(); break;
    case 'page-reports':    loadReports(); break;
    case 'page-members':    loadMembers(); break;
    case 'page-attendance': loadAttendance(); break;
    case 'page-groups':     loadGroups(); break;
    case 'page-giving':     loadGiving(); break;
    case 'page-volunteers': loadVolunteers(); break;
    case 'page-visitors':   loadVisitors(); break;
    case 'page-family':     loadFamily(); break;
    case 'page-comms':      loadComms(); break;
    case 'page-events':     loadEvents(); break;
    case 'page-welfare':    loadWelfare(); break;
    case 'page-education':  loadEducation(); break;
    case 'page-missions':   loadMissions(); break;
    case 'page-scholarship':loadScholarship(); break;
    case 'page-expenses':   loadExpenses(); break;
    case 'page-budget':     loadFinanceTab('ledger'); break;
    case 'page-qr':         loadQRPage(); break;
    case 'page-settings':   loadSettings(); break;
  }
}

// ─── PREFETCH MEMBERS (for autocomplete) ─────────────────────────────────────
async function prefetchMembers() {
  // Offline: hydrate the roster from the last cached snapshot so member pickers
  // (attendance, giving) still work.
  if (!navigator.onLine) {
    allMembers = (await cacheGet(`members:${ORG_ID}`)) || [];
    return;
  }
  // Supabase/PostgREST caps a single response at ~1000 rows, so page through
  // the full roster (large legacy orgs have several thousand members).
  const PAGE = 1000;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.members.list(ORG_ID, { active: true })
      .range(from, from + PAGE - 1);
    if (error) {
      // Network hiccup — fall back to cache rather than emptying the roster.
      const cached = await cacheGet(`members:${ORG_ID}`);
      if (cached) { allMembers = cached; return; }
      toast(error.message, 'error'); break;
    }
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  allMembers = all;
  cachePut(`members:${ORG_ID}`, all);   // snapshot for offline use

  // Populate group datalist
  const groups = [...new Set(allMembers.map(m => m.group_name).filter(Boolean))];
  const dl = document.getElementById('group-list');
  if (dl) dl.innerHTML = groups.map(g => `<option value="${g}">`).join('');

  // Group filter dropdown
  const gf = document.getElementById('members-group-filter');
  if (gf) {
    gf.innerHTML = '<option value="">All Groups</option>' + groups.map(g => `<option>${g}</option>`).join('');
    gf.addEventListener('change', () => renderMembers());
  }
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
let attChart = null, givingChart = null;
async function loadDashboard() {
  const [{ data: stats }, { data: trend }, { data: gvCats }] = await Promise.all([
    db.dashboard.stats(ORG_ID),
    db.attendance.trend(ORG_ID),
    db.giving.summary(ORG_ID),
  ]);

  // Member verification progress (show during a confirmation drive)
  db.reports.verifyCounts(ORG_ID).then(({ total, verified }) => {
    const card = document.getElementById('dash-verify-card');
    if (!card) return;
    if (!total) { card.style.display = 'none'; return; }
    const pct = Math.round(verified / total * 100);
    card.style.display = verified < total ? '' : 'none';   // hide once all verified
    document.getElementById('dash-verify-bar').style.width = pct + '%';
    document.getElementById('dash-verify-label').textContent =
      `${fmtNum(verified)} of ${fmtNum(total)} verified (${pct}%)`;
  });

  if (stats) {
    document.getElementById('ds-members').textContent  = fmtNum(stats.total_members);
    document.getElementById('ds-att').textContent      = fmtNum(stats.attendance_sunday);
    document.getElementById('ds-giving').textContent   = fmtMoney(stats.giving_month, CURRENCY);
    document.getElementById('ds-giving-currency').textContent = CURRENCY;
    document.getElementById('ds-visitors').textContent = fmtNum(stats.visitors_month);
    document.getElementById('ds-welfare').textContent  = fmtNum(stats.welfare_pending);
    document.getElementById('ds-qrpending').textContent= fmtNum(stats.qr_pending_import);
  }

  // Attendance trend chart
  const attCtx = document.getElementById('att-chart').getContext('2d');
  if (attChart) attChart.destroy();
  attChart = new Chart(attCtx, {
    type: 'bar',
    data: {
      labels: (trend || []).map(r => fmtDate(r.service_date)),
      datasets: [{ label: 'Attendance', data: (trend || []).map(r => r.cnt),
        backgroundColor: '#B8964A', borderRadius: 4 }],
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  // Giving by category chart
  const gvCtx = document.getElementById('giving-chart').getContext('2d');
  if (givingChart) givingChart.destroy();
  givingChart = new Chart(gvCtx, {
    type: 'doughnut',
    data: {
      labels: (gvCats || []).map(r => r.category),
      datasets: [{ data: (gvCats || []).map(r => r.total),
        backgroundColor: ['#B8964A','#0F2340','#2D6A4F','#8B2020','#1A56A0','#E2C06A'], borderWidth: 0 }],
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } } },
  });
}

// ─── REPORTS ────────────────────────────────────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const repCharts = {};
function repChart(id, config) {
  const el = document.getElementById(id);
  if (!el) return;
  if (repCharts[id]) repCharts[id].destroy();
  repCharts[id] = new Chart(el.getContext('2d'), config);
}
function lastSunday() {
  const d = new Date(); d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}
const repStore = {};   // holds last-computed report data for CSV export
function downloadCSV(filename, headers, rows) {
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename; a.click();
}

let reportsInit = false;
async function loadReports() {
  if (!reportsInit) {
    reportsInit = true;
    // Sub-tab switching
    document.querySelectorAll('#report-tabs .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#report-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.rtab;
        ['attendance','growth','giving','spending','groups'].forEach(t =>
          document.getElementById('rtab-' + t).style.display = t === tab ? '' : 'none');
        repLoadTab(tab);
      });
    });
    // Attendance controls
    populateAllConfigTargets(); // ensure rep-att-type + as-type filled
    document.getElementById('rep-att-type').innerHTML =
      listValues('service_types').map(t => `<option>${t}</option>`).join('');
    document.getElementById('rep-att-date').value = lastSunday();
    document.getElementById('rep-att-refresh').onclick = repAttendance;
    document.getElementById('rep-att-date').addEventListener('change', repAttendance);
    document.getElementById('rep-att-type').addEventListener('change', repAttendance);
    document.getElementById('rep-summary-btn').onclick = () => openSummaryModal('service');
    document.getElementById('rep-group-meeting-btn').onclick = () => openSummaryModal('group');
    // Only attendance-writers can record manual totals
    const canRecord = canWritePage('page-attendance');
    document.getElementById('rep-summary-btn').style.display = canRecord ? '' : 'none';
    document.getElementById('rep-group-meeting-btn').style.display = canRecord ? '' : 'none';
    document.getElementById('rep-growth-period').addEventListener('change', repGrowth);
    // Date ranges (default: Jan 1 this year → today)
    const yStart = `${new Date().getFullYear()}-01-01`, todayStr = today();
    ['rep-giving-start','rep-spend-start'].forEach(id => document.getElementById(id).value = yStart);
    ['rep-giving-end','rep-spend-end'].forEach(id => document.getElementById(id).value = todayStr);
    document.getElementById('rep-giving-apply').onclick = repGiving;
    document.getElementById('rep-spend-apply').onclick = repSpending;
    document.getElementById('rep-giving-csv').onclick = exportGivingCSV;
    document.getElementById('rep-spend-csv').onclick = exportSpendingCSV;
    document.getElementById('rep-att-csv').onclick = exportAttendanceCSV;
    document.getElementById('rep-groups-csv').onclick = exportGroupsCSV;
    initSummaryForm();
  }
  repLoadTab('attendance');
}

function repLoadTab(tab) {
  if (tab === 'attendance') repAttendance();
  else if (tab === 'growth') repGrowth();
  else if (tab === 'giving') repGiving();
  else if (tab === 'spending') repSpending();
  else if (tab === 'groups') repGroups();
}

// ── Attendance: present / absent / totals / trend ──
async function repAttendance() {
  const date = document.getElementById('rep-att-date').value;
  const type = document.getElementById('rep-att-type').value;
  if (!date) return;
  const [{ data: att }, { data: summaries }] = await Promise.all([
    db.attendance.forDate(ORG_ID, date, type),
    db.summaries.forDate(ORG_ID, date),
  ]);
  const present = new Map();   // member_id -> name
  let guestCount = 0;
  (att || []).forEach(r => {
    if (r.member_id) present.set(r.member_id, r.members ? `${r.members.first_name} ${r.members.last_name}` : 'Member');
    else guestCount++;
  });
  const activeMembers = allMembers.filter(m => m.is_active !== false);
  const absent = activeMembers.filter(m => !present.has(m.id));
  const manualTotal = (summaries || []).filter(s => s.service_type === type)
    .reduce((sum, s) => sum + Number(s.total_count), 0);
  const recordedTotal = present.size + guestCount + manualTotal;

  repStore.attendance = { date, type,
    present: [...present.values()].sort(),
    absent: absent.map(m => `${m.first_name} ${m.last_name}`) };
  document.getElementById('rep-att-present').textContent = fmtNum(present.size);
  document.getElementById('rep-att-absent').textContent  = fmtNum(absent.length);
  document.getElementById('rep-att-total').textContent   = fmtNum(recordedTotal);
  document.getElementById('rep-present-count').textContent = `(${present.size})`;
  document.getElementById('rep-absent-count').textContent  = `(${absent.length})`;

  document.getElementById('rep-present-tbody').innerHTML =
    [...present.values()].sort().map(n => `<tr><td class="td-name">${n}</td></tr>`).join('') ||
    '<tr><td class="tbl-empty">No members checked in</td></tr>';
  document.getElementById('rep-absent-tbody').innerHTML =
    absent.map(m => `<tr><td class="td-name">${m.first_name} ${m.last_name}</td></tr>`).join('') ||
    '<tr><td class="tbl-empty">Everyone present 🎉</td></tr>';

  // Manual totals list (all dates, this service type context shown)
  const { data: allSum } = await db.summaries.forDate(ORG_ID, date);
  buildTable(document.getElementById('rep-summary-tbody'), allSum || [], s => `
    <td>${fmtDate(s.summary_date)}</td><td>${s.service_type}</td>
    <td style="font-weight:600;">${fmtNum(s.total_count)}</td>
    <td>${fmtNum(s.male_count)}</td><td>${fmtNum(s.female_count)}</td><td>${fmtNum(s.children_count)}</td>
    <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteSummary('${s.id}')">Delete</button></td>`);

  await repAttendanceTrend(type);
}

async function repAttendanceTrend(type) {
  const end = new Date(); const start = new Date(); start.setDate(start.getDate() - 84); // ~12 weeks
  const startStr = start.toISOString().slice(0,10), endStr = end.toISOString().slice(0,10);
  const [{ data: att }, { data: sums }] = await Promise.all([
    db.reports.attendanceRange(ORG_ID, startStr, endStr),
    db.summaries.range(ORG_ID, startStr, endStr),
  ]);
  const byDate = {};
  (att || []).filter(r => r.service_type === type).forEach(r => { byDate[r.service_date] = (byDate[r.service_date]||0) + 1; });
  (sums || []).filter(r => !r.group_name && r.service_type === type).forEach(r => { byDate[r.summary_date] = (byDate[r.summary_date]||0) + Number(r.total_count); });
  const dates = Object.keys(byDate).sort();
  repChart('rep-att-trend-chart', {
    type: 'bar',
    data: { labels: dates.map(d => fmtDate(d)), datasets: [{ label: type, data: dates.map(d => byDate[d]), backgroundColor: 'rgba(184,150,74,.6)', borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
}

// ── Growth: membership + attendance over time ──
async function repGrowth() {
  const period = document.getElementById('rep-growth-period').value;
  const { data: members } = await db.reports.membersJoined(ORG_ID);
  const keyOf = d => period === 'year' ? d.slice(0,4) : d.slice(0,7);
  // cumulative membership by period
  const joins = (members || []).map(m => (m.date_joined || m.created_at || '').slice(0,10)).filter(Boolean).sort();
  const buckets = {};
  joins.forEach(d => { const k = keyOf(d); buckets[k] = (buckets[k]||0) + 1; });
  const keys = Object.keys(buckets).sort();
  let running = 0; const cum = keys.map(k => (running += buckets[k]));
  repChart('rep-membership-chart', {
    type: 'line',
    data: { labels: keys, datasets: [{ label: 'Total members', data: cum, borderColor: '#0F2340', backgroundColor: 'rgba(15,35,64,.1)', fill: true, tension: .3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
  // attendance over time (per-person + manual totals)
  const end = new Date(); const start = new Date(); start.setFullYear(start.getFullYear() - 1);
  const startStr = start.toISOString().slice(0,10), endStr = end.toISOString().slice(0,10);
  const [{ data: att }, { data: sums }] = await Promise.all([
    db.reports.attendanceRange(ORG_ID, startStr, endStr),
    db.summaries.range(ORG_ID, startStr, endStr),
  ]);
  const ab = {};
  (att || []).forEach(r => { const k = keyOf(r.service_date); ab[k] = (ab[k]||0) + 1; });
  (sums || []).filter(r => !r.group_name).forEach(r => { const k = keyOf(r.summary_date); ab[k] = (ab[k]||0) + Number(r.total_count); });
  const akeys = Object.keys(ab).sort();
  repChart('rep-attgrowth-chart', {
    type: 'bar',
    data: { labels: akeys, datasets: [{ label: 'Attendance', data: akeys.map(k => ab[k]), backgroundColor: 'rgba(184,150,74,.6)', borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
}

// month label list spanning a date range, e.g. ["2026-01", ...]
function monthKeys(start, end) {
  const keys = []; const d = new Date(start.slice(0,7) + '-01');
  const last = new Date(end.slice(0,7) + '-01');
  while (d <= last) { keys.push(d.toISOString().slice(0,7)); d.setMonth(d.getMonth() + 1); }
  return keys;
}

// ── Giving report ──
async function repGiving() {
  const start = document.getElementById('rep-giving-start').value;
  const end   = document.getElementById('rep-giving-end').value;
  if (!start || !end) return;
  const { data } = await db.reports.givingRange(ORG_ID, start, end);
  const rows = data || [];
  repStore.giving = { rows, start, end };
  const total = rows.reduce((s,r) => s + Number(r.amount), 0);
  const thisMonth = new Date().toISOString().slice(0,7);
  const monthTotal = rows.filter(r => r.given_date?.startsWith(thisMonth)).reduce((s,r) => s + Number(r.amount), 0);
  const givers = new Set(rows.filter(r => r.member_id).map(r => r.member_id)).size;
  document.getElementById('rep-giving-total').textContent  = fmtMoney(total, CURRENCY);
  document.getElementById('rep-giving-month').textContent  = fmtMoney(monthTotal, CURRENCY);
  document.getElementById('rep-giving-givers').textContent = fmtNum(givers);
  // by month (across range)
  const mk = monthKeys(start, end), byMonth = {};
  mk.forEach(k => byMonth[k] = 0);
  rows.forEach(r => { const k = (r.given_date||'').slice(0,7); if (k in byMonth) byMonth[k] += Number(r.amount); });
  repChart('rep-giving-month-chart', {
    type: 'bar', data: { labels: mk.map(k => `${MONTHS[+k.slice(5,7)-1]} ${k.slice(2,4)}`), datasets: [{ label: 'Giving', data: mk.map(k => byMonth[k]), backgroundColor: 'rgba(26,107,69,.55)', borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
  // by category
  const byCat = {}; rows.forEach(r => { byCat[r.category] = (byCat[r.category]||0) + Number(r.amount); });
  const cats = Object.entries(byCat).sort((a,b) => b[1]-a[1]);
  repStore.givingCats = cats; repStore.givingTotal = total;
  repChart('rep-giving-cat-chart', {
    type: 'doughnut', data: { labels: cats.map(c => c[0]), datasets: [{ data: cats.map(c => c[1]), backgroundColor: ['#B8964A','#0F2340','#1A6B45','#8B1F1F','#C9A84C','#5DADE2','#9898e0','#E2C06A'] }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 10 } } } } },
  });
  document.getElementById('rep-giving-tbody').innerHTML = cats.map(([c,v]) =>
    `<tr><td class="td-name">${c}</td><td style="font-weight:600;">${fmtMoney(v, CURRENCY)}</td><td>${total? Math.round(v/total*100):0}%</td></tr>`).join('')
    || '<tr><td class="tbl-empty" colspan="3">No giving recorded</td></tr>';
}
function exportGivingCSV() {
  const g = repStore.giving; if (!g) return;
  downloadCSV(`giving_${g.start}_to_${g.end}.csv`,
    ['Date','Member','Category','Method','Amount'],
    g.rows.sort((a,b)=>(a.given_date||'').localeCompare(b.given_date||''))
      .map(r => [r.given_date, r.member_name || '', r.category, r.payment_method, r.amount]));
}

// ── Spending report ──
async function repSpending() {
  const start = document.getElementById('rep-spend-start').value;
  const end   = document.getElementById('rep-spend-end').value;
  if (!start || !end) return;
  const { data } = await db.reports.expensesRange(ORG_ID, start, end);
  const rows = data || [];
  repStore.spending = { rows, start, end };
  const total = rows.reduce((s,r) => s + Number(r.amount), 0);
  const thisMonth = new Date().toISOString().slice(0,7);
  const monthTotal = rows.filter(r => r.expense_date?.startsWith(thisMonth)).reduce((s,r) => s + Number(r.amount), 0);
  document.getElementById('rep-spend-total').textContent = fmtMoney(total, CURRENCY);
  document.getElementById('rep-spend-month').textContent = fmtMoney(monthTotal, CURRENCY);
  const mk = monthKeys(start, end), byMonth = {};
  mk.forEach(k => byMonth[k] = 0);
  rows.forEach(r => { const k = (r.expense_date||'').slice(0,7); if (k in byMonth) byMonth[k] += Number(r.amount); });
  repChart('rep-spend-month-chart', {
    type: 'bar', data: { labels: mk.map(k => `${MONTHS[+k.slice(5,7)-1]} ${k.slice(2,4)}`), datasets: [{ label: 'Spending', data: mk.map(k => byMonth[k]), backgroundColor: 'rgba(139,31,31,.55)', borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
  const byCat = {}; rows.forEach(r => { byCat[r.category] = (byCat[r.category]||0) + Number(r.amount); });
  const cats = Object.entries(byCat).sort((a,b) => b[1]-a[1]);
  repChart('rep-spend-cat-chart', {
    type: 'doughnut', data: { labels: cats.map(c => c[0]), datasets: [{ data: cats.map(c => c[1]), backgroundColor: ['#8B1F1F','#0F2340','#B8964A','#1A6B45','#C9A84C','#5DADE2','#9898e0','#E2C06A'] }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 10 } } } } },
  });
  document.getElementById('rep-spend-tbody').innerHTML = cats.map(([c,v]) =>
    `<tr><td class="td-name">${c}</td><td style="font-weight:600;">${fmtMoney(v, CURRENCY)}</td><td>${total? Math.round(v/total*100):0}%</td></tr>`).join('')
    || '<tr><td class="tbl-empty" colspan="3">No spending recorded</td></tr>';
}
function exportSpendingCSV() {
  const g = repStore.spending; if (!g) return;
  downloadCSV(`spending_${g.start}_to_${g.end}.csv`,
    ['Date','Title','Category','Vendor','Amount'],
    g.rows.sort((a,b)=>(a.expense_date||'').localeCompare(b.expense_date||''))
      .map(r => [r.expense_date, r.title || '', r.category, r.vendor || '', r.amount]));
}

// ── Groups report ──
async function repGroups() {
  const { data: groups } = await db.groups.list(ORG_ID);
  const { data: meetings } = await db.summaries.groupMeetings(ORG_ID);
  const meetByGroup = {};
  (meetings || []).forEach(m => { (meetByGroup[m.group_name] = meetByGroup[m.group_name] || []).push(m); });
  // member counts per group from cached members
  const memberCounts = {};
  allMembers.forEach(m => { if (m.group_name) memberCounts[m.group_name] = (memberCounts[m.group_name]||0) + 1; });
  const names = new Set([...(groups||[]).map(g => g.name), ...Object.keys(meetByGroup), ...Object.keys(memberCounts)]);
  document.getElementById('rep-groups-tbody').innerHTML = [...names].sort().map(name => {
    const ms = meetByGroup[name] || [];
    const avg = ms.length ? Math.round(ms.reduce((s,x) => s+Number(x.total_count),0) / ms.length) : 0;
    const last = ms.length ? ms[0].summary_date : null;
    return `<tr><td class="td-name">${name}</td><td>${fmtNum(memberCounts[name]||0)}</td><td>${ms.length}</td><td>${ms.length?fmtNum(avg):'—'}</td><td>${last?fmtDate(last):'—'}</td></tr>`;
  }).join('') || '<tr><td class="tbl-empty" colspan="5">No groups yet</td></tr>';

  buildTable(document.getElementById('rep-groupmeetings-tbody'), meetings || [], m => `
    <td>${fmtDate(m.summary_date)}</td><td class="td-name">${m.group_name}</td>
    <td style="font-weight:600;">${fmtNum(m.total_count)}</td><td>${fmtNum(m.male_count)}</td><td>${fmtNum(m.female_count)}</td>
    <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteSummary('${m.id}')">Delete</button></td>`);

  repStore.groups = { names: [...names], meetByGroup, memberCounts, meetings: meetings || [] };
}

function exportAttendanceCSV() {
  const a = repStore.attendance; if (!a) return;
  const rows = [];
  a.present.forEach(n => rows.push([n, 'Present']));
  a.absent.forEach(n => rows.push([n, 'Absent']));
  downloadCSV(`attendance_${a.type}_${a.date}.csv`.replace(/\s+/g,'-'), ['Member','Status'], rows);
}
function exportGroupsCSV() {
  const g = repStore.groups; if (!g) return;
  const rows = g.names.sort().map(name => {
    const ms = g.meetByGroup[name] || [];
    const avg = ms.length ? Math.round(ms.reduce((s,x) => s+Number(x.total_count),0) / ms.length) : '';
    return [name, g.memberCounts[name]||0, ms.length, avg, ms.length ? ms[0].summary_date : ''];
  });
  downloadCSV('group_statistics.csv', ['Group','Members','Meetings','Avg attendance','Last meeting'], rows);
}

// ── Summary modal (service total OR group meeting) ──
function openSummaryModal(mode) {
  document.getElementById('attsummary-form').reset();
  document.getElementById('as-id').value = '';
  document.getElementById('as-mode').value = mode;
  document.getElementById('as-date').value = mode === 'service' ? (document.getElementById('rep-att-date').value || today()) : today();
  document.getElementById('as-title').textContent = mode === 'service' ? 'Record Service Total' : 'Record Group Meeting';
  document.getElementById('as-type-wrap').style.display = mode === 'service' ? '' : 'none';
  document.getElementById('as-group-wrap').style.display = mode === 'group' ? '' : 'none';
  document.getElementById('as-type').innerHTML = listValues('service_types').map(t => `<option>${t}</option>`).join('');
  if (mode === 'service') document.getElementById('as-type').value = document.getElementById('rep-att-type').value;
  const groups = [...new Set(allMembers.map(m => m.group_name).filter(Boolean))];
  document.getElementById('as-group').innerHTML = groups.map(g => `<option>${g}</option>`).join('') || '<option value="">(no groups)</option>';
  openModal('modal-attsummary');
}
window.asRecalc = () => {
  const m = +document.getElementById('as-male').value || 0;
  const f = +document.getElementById('as-female').value || 0;
  const c = +document.getElementById('as-children').value || 0;
  if (m || f || c) document.getElementById('as-total').value = m + f + c;
};
function initSummaryForm() {
  document.getElementById('attsummary-form').addEventListener('submit', async e => {
    e.preventDefault();
    const mode = document.getElementById('as-mode').value;
    const data = {
      org_id: ORG_ID,
      summary_date: document.getElementById('as-date').value,
      service_type: mode === 'group' ? 'Group Meeting' : document.getElementById('as-type').value,
      group_name: mode === 'group' ? (document.getElementById('as-group').value || null) : null,
      total_count: intOrNull('as-total') || 0,
      male_count: intOrNull('as-male') || 0,
      female_count: intOrNull('as-female') || 0,
      children_count: intOrNull('as-children') || 0,
      notes: document.getElementById('as-notes').value.trim() || null,
    };
    const { error } = await db.summaries.insert(data);
    if (error) { toast(error.code === '23505' ? 'A total for that date/service already exists' : error.message, 'error'); return; }
    toast('Saved', 'success');
    closeModal('modal-attsummary');
    repLoadTab(mode === 'group' ? 'groups' : 'attendance');
  });
}
window.deleteSummary = async (id) => {
  if (!confirm('Delete this record?')) return;
  await db.summaries.delete(id);
  const tab = document.querySelector('#report-tabs .tab-btn.active')?.dataset.rtab || 'attendance';
  repLoadTab(tab);
};

// ── Member giving history ──
window.viewMemberGiving = async (id) => {
  const m = membersData.find(x => x.id === id) || allMembers.find(x => x.id === id);
  document.getElementById('mg-title').textContent = m ? `Giving — ${m.first_name} ${m.last_name}` : 'Giving History';
  const { data } = await db.reports.givingByMember(ORG_ID, id);
  const rows = data || [];
  const total = rows.reduce((s,r) => s + Number(r.amount), 0);
  document.getElementById('mg-total').textContent = fmtMoney(total, CURRENCY);
  document.getElementById('mg-count').textContent = fmtNum(rows.length);
  document.getElementById('mg-tbody').innerHTML = rows.map(r =>
    `<tr><td>${fmtDate(r.given_date)}</td><td>${r.category}</td><td>${r.payment_method}</td><td style="font-weight:600;">${fmtMoney(r.amount, CURRENCY)}</td></tr>`).join('')
    || '<tr><td class="tbl-empty" colspan="4">No giving recorded</td></tr>';
  openModal('modal-member-giving');
};

// ─── MEMBERS ──────────────────────────────────────────────────────────────────
let membersData = [];
async function loadMembers() {
  membersData = [];
  const tbody = document.getElementById('members-tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="tbl-empty"><div class="loading-state"><div class="spinner"></div>Loading…</div></td></tr>';
  const { data, error } = await db.members.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  membersData = data || [];
  renderMembers();

  // Search
  const search = document.getElementById('members-search');
  search.addEventListener('input', debounce(async () => {
    const { data } = await db.members.list(ORG_ID, { search: search.value, active: null });
    membersData = data || [];
    renderMembers();
  }, 350));

  document.getElementById('members-verify-filter').addEventListener('change', renderMembers);

  // Add button
  document.getElementById('member-add-btn').onclick = () => openMemberModal();

  // Member autocomplete for attendance
  memberSelect(document.getElementById('af-member-name'), () => allMembers, m => {
    document.getElementById('af-member-id').value = m.id;
    document.getElementById('af-guest-fields').style.display = 'none';
  });
  memberSelect(document.getElementById('gf-member-name'), () => allMembers, m => {
    document.getElementById('gf-member-id').value = m.id;
  });
  memberSelect(document.getElementById('volf-member-name'), () => allMembers, m => document.getElementById('volf-member-id').value = m.id);
  memberSelect(document.getElementById('wff-member-name'), () => allMembers, m => document.getElementById('wff-member-id').value = m.id);
  memberSelect(document.getElementById('eduf-member-name'), () => allMembers, m => document.getElementById('eduf-member-id').value = m.id);
  memberSelect(document.getElementById('schf-member-name'), () => allMembers, m => document.getElementById('schf-member-id').value = m.id);
  memberSelect(document.getElementById('flf-member-name'), () => allMembers, m => document.getElementById('flf-member-id').value = m.id);
  memberSelect(document.getElementById('prf-member-name'), () => allMembers, m => {
    document.getElementById('prf-member-id').value = m.id;
    document.getElementById('prf-name').value = `${m.first_name} ${m.last_name}`;
  });
}

function renderMembers() {
  const search = document.getElementById('members-search')?.value?.toLowerCase() || '';
  const group  = document.getElementById('members-group-filter')?.value || '';
  const verify = document.getElementById('members-verify-filter')?.value || '';
  let rows = membersData;
  if (search) rows = rows.filter(m => `${m.first_name} ${m.last_name} ${m.phone||''} ${m.membership_no||''}`.toLowerCase().includes(search));
  if (group)  rows = rows.filter(m => m.group_name === group);
  if (verify === 'verified')   rows = rows.filter(m => m.member_confirmed);
  if (verify === 'unverified') rows = rows.filter(m => !m.member_confirmed);

  buildTable(document.getElementById('members-tbody'), rows, m => `
    <td><div style="display:flex;align-items:center;gap:.6rem;">
      <div class="member-photo">${initials(m.first_name, m.last_name)}</div>
      <span class="td-name">${m.first_name} ${m.last_name}</span>
      ${m.member_confirmed ? '' : '<span class="badge badge-gold" title="Not yet verified">⚠ Unverified</span>'}
    </div></td>
    <td>${m.membership_no || '—'}</td>
    <td>${m.group_name ? `<span class="badge badge-gold">${m.group_name}</span>` : '—'}</td>
    <td>${m.role || '—'}</td>
    <td>${m.phone || '—'}</td>
    <td>${fmtDate(m.date_joined)}</td>
    <td class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="viewMemberGiving('${m.id}')">Giving</button>
      ${canWritePage('page-qr') ? `<button class="btn btn-ghost btn-sm" onclick="showMemberQR('${m.id}')">QR</button>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="editMember('${m.id}')">Edit</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteMember('${m.id}')">Delete</button>
    </td>`);

  const unverified = membersData.filter(m => !m.member_confirmed).length;
  document.getElementById('member-count-bar').innerHTML =
    `Showing ${rows.length} of ${membersData.length} members` +
    (unverified ? ` · <strong style="color:var(--gold-dark)">${unverified} unverified</strong> (pending confirmation)` : '');
}

function openMemberModal(m = null) {
  document.getElementById('member-modal-title').textContent = m ? 'Edit Member' : 'Add Member';
  document.getElementById('mf-id').value       = m?.id || '';
  document.getElementById('mf-first').value    = m?.first_name || '';
  document.getElementById('mf-last').value     = m?.last_name || '';
  document.getElementById('mf-phone').value    = m?.phone || '';
  document.getElementById('mf-phone2').value   = m?.phone2 || '';
  document.getElementById('mf-email').value    = m?.email || '';
  document.getElementById('mf-mno').value      = m?.membership_no || '';
  document.getElementById('mf-gender').value   = m?.gender || '';
  document.getElementById('mf-role').value     = m?.role || '';
  document.getElementById('mf-group').value    = m?.group_name || '';
  document.getElementById('mf-dob').value      = m?.date_of_birth || '';
  document.getElementById('mf-joined').value   = m?.date_joined || '';
  document.getElementById('mf-notes').value    = m?.notes || '';
  document.getElementById('mf-other').value    = m?.other_names || '';
  document.getElementById('mf-marital').value  = m?.marital_status || '';
  document.getElementById('mf-residence').value= m?.residence || '';
  document.getElementById('mf-detail').value   = m?.detailed_residence || '';
  document.getElementById('mf-verified').checked = !!m?.member_confirmed;
  // Employment
  document.getElementById('mf-occupation').value  = m?.occupation || '';
  document.getElementById('mf-employer').value    = m?.employer || '';
  setSelectValue('mf-emp-type', m?.employment_type || '');
  // Sacraments
  document.getElementById('mf-baptised').checked       = !!m?.baptised;
  document.getElementById('mf-baptism-date').value     = m?.baptism_date || '';
  document.getElementById('mf-baptism-place').value    = m?.baptism_place || '';
  document.getElementById('mf-confirmed').checked      = !!m?.confirmed;
  document.getElementById('mf-confirm-date').value     = m?.confirmation_date || '';
  document.getElementById('mf-confirm-place').value    = m?.confirmation_place || '';
  openModal('modal-member');
}

window.editMember = async (id) => {
  const m = membersData.find(x => x.id === id);
  if (m) openMemberModal(m);
};

window.deleteMember = async (id) => {
  if (!confirm('Delete this member? This cannot be undone.')) return;
  const { error } = await db.members.delete(id);
  if (error) { toast(error.message, 'error'); return; }
  toast('Member deleted', 'success');
  membersData = membersData.filter(m => m.id !== id);
  allMembers  = allMembers.filter(m => m.id !== id);
  renderMembers();
};

// ─── ATTENDANCE ───────────────────────────────────────────────────────────────
let attData = [];
async function loadAttendance() {
  const dateEl = document.getElementById('att-date');
  const typeEl = document.getElementById('att-type');
  dateEl.value = today();
  typeEl.value = 'Sunday Service';

  document.getElementById('att-add-btn').onclick = () => openModal('modal-att');
  document.getElementById('online-add-btn').onclick = () => {
    document.getElementById('online-form').reset();
    document.getElementById('onf-id').value = '';
    openModal('modal-online');
  };

  dateEl.addEventListener('change', () => { fetchAttendance(); fetchOnline(); });
  typeEl.addEventListener('change', () => { fetchAttendance(); fetchOnline(); });

  await fetchAttendance();
  await fetchOnline();
  subscribeAttendanceRealtime();
}

// ─── ONLINE ATTENDANCE ─────────────────────────────────────────────────────
let onlineData = [];
async function fetchOnline() {
  const date = document.getElementById('att-date').value;
  const type = document.getElementById('att-type').value;
  const { data, error } = await db.online.forDate(ORG_ID, date, type);
  if (error) { toast(error.message, 'error'); return; }
  onlineData = data || [];
  const total = onlineData.reduce((s, r) => s + Number(r.count), 0);
  document.getElementById('online-total').textContent = fmtNum(total);
  buildTable(document.getElementById('online-tbody'), onlineData, r => `
    <td class="td-name" data-label="Channel">${r.channel}</td>
    <td style="font-weight:600;" data-label="Viewers">${fmtNum(r.count)}</td>
    <td class="text-sm text-muted" data-label="Notes">${r.notes || '—'}</td>
    <td class="td-actions" data-label="">
      <button class="btn btn-ghost btn-sm" onclick="editOnline('${r.id}')">Edit</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteOnline('${r.id}')">Delete</button>
    </td>`);
}

window.editOnline = (id) => {
  const r = onlineData.find(x => x.id === id);
  if (!r) return;
  document.getElementById('onf-id').value = r.id;
  document.getElementById('onf-channel').value = r.channel;
  document.getElementById('onf-count').value = r.count;
  document.getElementById('onf-notes').value = r.notes || '';
  openModal('modal-online');
};

window.deleteOnline = async (id) => {
  if (!confirm('Remove this online channel entry?')) return;
  await db.online.delete(id);
  await fetchOnline();
};

async function fetchAttendance() {
  const date = document.getElementById('att-date').value;
  const type = document.getElementById('att-type').value;
  document.getElementById('att-subtitle').textContent = `${type} — ${fmtDate(date)}`;

  const cacheKey = `attendance:${ORG_ID}:${date}:${type}`;
  if (!navigator.onLine) {
    attData = (await cacheGet(cacheKey)) || [];
    renderAttendance();
    return;
  }
  const { data, error } = await db.attendance.forDate(ORG_ID, date, type);
  if (error) {
    const cached = await cacheGet(cacheKey);
    attData = cached || [];
    renderAttendance();
    if (!cached) toast(error.message, 'error');
    return;
  }
  attData = data || [];
  cachePut(cacheKey, attData);
  renderAttendance();
}

function renderAttendance() {
  const badge = document.getElementById('att-live-badge');
  badge.style.display = 'inline-flex';

  buildTable(document.getElementById('att-tbody'), attData, r => {
    const name = r.members
      ? `${r.members.first_name} ${r.members.last_name}`
      : r.guest_name || '—';
    const role = r.members?.role || r.guest_role || r.group_name || '—';
    const methodBadge = r.check_in_method === 'qr'
      ? '<span class="badge badge-blue">QR</span>'
      : '<span class="badge badge-gray">Manual</span>';
    return `
      <td class="td-name" data-label="Name">${name}</td>
      <td data-label="Role / Group">${role}</td>
      <td data-label="Method">${methodBadge}</td>
      <td class="text-sm text-muted" data-label="Time">${new Date(r.created_at).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</td>
      <td class="td-actions" data-label=""><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteAtt('${r.id}')">✕</button></td>`;
  });
  document.getElementById('att-count').textContent = `${attData.length} recorded`;
}

function subscribeAttendanceRealtime() {
  if (attRealtimeSub) attRealtimeSub.unsubscribe();
  attRealtimeSub = supabase
    .channel('attendance-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'attendance', filter: `org_id=eq.${ORG_ID}` }, payload => {
      const date = document.getElementById('att-date').value;
      if (payload.new.service_date === date) {
        attData.unshift(payload.new);
        renderAttendance();
        document.getElementById('att-live-badge').style.display = 'inline-flex';
      }
    })
    .subscribe();
}

window.deleteAtt = async (id) => {
  if (!confirm('Remove this attendance record?')) return;
  const { error } = await db.attendance.delete(id);
  if (error) { toast(error.message, 'error'); return; }
  attData = attData.filter(r => r.id !== id);
  renderAttendance();
};

// ─── GROUPS ───────────────────────────────────────────────────────────────────
let groupsData = [];
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function initDayCheckboxes() {
  const container = document.getElementById('day-checkboxes');
  if (!container) return;
  DAY_NAMES.forEach((d, i) => {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:.3rem;font-size:.8rem;cursor:pointer;';
    label.innerHTML = `<input type="checkbox" value="${i}" name="meeting_day"/> ${d}`;
    container.appendChild(label);
  });
}

async function loadGroups() {
  const { data, error } = await db.groups.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  groupsData = data || [];
  renderGroups();
  document.getElementById('group-add-btn').onclick = () => {
    document.getElementById('group-modal-title').textContent = 'Add Group';
    document.getElementById('group-form').reset();
    document.getElementById('grf-id').value = '';
    openModal('modal-group');
  };
}

function renderGroups() {
  const grid = document.getElementById('groups-grid');
  if (!groupsData.length) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🫂</div><h3>No groups yet</h3><p>Create your first group to get started.</p></div>';
    return;
  }
  grid.innerHTML = groupsData.map(g => {
    const days = (g.meeting_days || []).map(d => DAY_NAMES[d]).join(', ');
    const leader = g.members ? `${g.members.first_name} ${g.members.last_name}` : '—';
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div><h3 style="margin-bottom:.2rem;">${g.name}</h3><div class="text-sm text-muted">${g.description || ''}</div></div>
        <div style="display:flex;gap:.35rem;">
          <button class="btn btn-ghost btn-sm" onclick="editGroup('${g.id}')">Edit</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteGroup('${g.id}')">Delete</button>
        </div>
      </div>
      <div style="margin-top:.85rem;display:flex;gap:.6rem;flex-wrap:wrap;">
        ${days ? `<span class="badge badge-gold">${days}</span>` : ''}
        <span class="badge badge-gray">Leader: ${leader}</span>
        ${g.is_active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-gray">Inactive</span>'}
      </div>
    </div>`;
  }).join('');
}

window.editGroup = (id) => {
  const g = groupsData.find(x => x.id === id);
  if (!g) return;
  document.getElementById('group-modal-title').textContent = 'Edit Group';
  document.getElementById('grf-id').value   = g.id;
  document.getElementById('grf-name').value = g.name;
  document.getElementById('grf-desc').value = g.description || '';
  document.querySelectorAll('#day-checkboxes input').forEach(cb => {
    cb.checked = (g.meeting_days || []).includes(Number(cb.value));
  });
  openModal('modal-group');
};

window.deleteGroup = async (id) => {
  if (!confirm('Delete this group?')) return;
  const { error } = await db.groups.delete(id);
  if (error) { toast(error.message, 'error'); return; }
  groupsData = groupsData.filter(g => g.id !== id);
  renderGroups();
};

// ─── GIVING ───────────────────────────────────────────────────────────────────
let givingData = [];
async function loadGiving() {
  const yearEl = document.getElementById('giving-year');
  const currentYear = new Date().getFullYear();
  yearEl.innerHTML = [0,1,2].map(i => `<option value="${currentYear-i}">${currentYear-i}</option>`).join('');
  yearEl.value = String(currentYear);
  yearEl.addEventListener('change', () => fetchGiving());
  document.getElementById('giving-add-btn').onclick = () => {
    document.getElementById('giving-form').reset();
    document.getElementById('gf-date').value = today();
    document.getElementById('gf-member-id').value = '';
    openModal('modal-giving');
  };
  await fetchGiving();
}

async function fetchGiving() {
  const year = document.getElementById('giving-year').value;
  const cacheKey = `giving:${ORG_ID}:${year}`;
  if (!navigator.onLine) {
    givingData = (await cacheGet(cacheKey)) || [];
    renderGiving();
    return;
  }
  const { data, error } = await db.giving.list(ORG_ID, { year });
  if (error) {
    const cached = await cacheGet(cacheKey);
    givingData = cached || [];
    renderGiving();
    if (!cached) toast(error.message, 'error');
    return;
  }
  givingData = data || [];
  cachePut(cacheKey, givingData);
  renderGiving();
}

function renderGiving() {
  const now = new Date();
  const thisMonthStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const total = givingData.reduce((s,r) => s + Number(r.amount), 0);
  const monthTotal = givingData.filter(r => r.given_date?.startsWith(thisMonthStr)).reduce((s,r) => s + Number(r.amount), 0);
  const givers = new Set(givingData.filter(r => r.member_id).map(r => r.member_id)).size;

  document.getElementById('gv-total').textContent  = fmtMoney(total, CURRENCY);
  document.getElementById('gv-month').textContent  = fmtMoney(monthTotal, CURRENCY);
  document.getElementById('gv-givers').textContent = fmtNum(givers);

  buildTable(document.getElementById('giving-tbody'), givingData, r => {
    const name = r.members ? `${r.members.first_name} ${r.members.last_name}` : r.member_name || 'Anonymous';
    return `
      <td class="td-name">${name}</td>
      <td style="color:var(--green);font-weight:500;">${fmtMoney(r.amount, CURRENCY)}</td>
      <td><span class="badge badge-gold">${r.category}</span></td>
      <td>${r.payment_method}</td>
      <td>${fmtDate(r.given_date)}</td>
      <td class="text-sm text-muted">${r.notes || '—'}</td>
      <td class="td-actions">
        <button class="btn btn-ghost btn-sm" onclick="showGivingReceipt('${r.id}')">Receipt</button>
        <button class="btn btn-ghost btn-sm" onclick="editGiving('${r.id}')">Edit</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteGiving('${r.id}')">Delete</button>
      </td>`;
  });
}

window.editGiving = (id) => {
  const r = givingData.find(x => x.id === id);
  if (!r) return;
  const name = r.members ? `${r.members.first_name} ${r.members.last_name}` : r.member_name || '';
  document.getElementById('gf-member-name').value = name;
  document.getElementById('gf-member-id').value   = r.member_id || '';
  document.getElementById('gf-amount').value       = r.amount;
  setSelectValue('gf-cat', r.category);
  document.getElementById('gf-method').value       = r.payment_method;
  document.getElementById('gf-date').value         = r.given_date;
  document.getElementById('gf-notes').value        = r.notes || '';
  // stash id for update
  document.getElementById('gf-member-id').dataset.editId = id;
  openModal('modal-giving');
};

window.showGivingReceipt = (id) => {
  const r = givingData.find(x => x.id === id);
  if (!r) return;
  const name = r.members ? `${r.members.first_name} ${r.members.last_name}` : r.member_name || 'Anonymous';
  document.getElementById('rc-org').textContent    = currentOrg?.name || 'Church';
  document.getElementById('rc-no').textContent     = r.id.slice(0,8).toUpperCase();
  document.getElementById('rc-name').textContent   = name;
  document.getElementById('rc-date').textContent   = fmtDate(r.given_date);
  document.getElementById('rc-cat').textContent    = r.category;
  document.getElementById('rc-method').textContent = r.payment_method;
  document.getElementById('rc-amount').textContent = fmtMoney(r.amount, CURRENCY);
  document.getElementById('rc-notes').textContent  = r.notes ? `Note: ${r.notes}` : '';
  openModal('modal-receipt');
};

window.printReceipt = () => {
  const content = document.getElementById('receipt-content').innerHTML;
  const w = window.open('', '_blank');
  w.document.write(`<html><head><title>Receipt</title><style>
    body{font-family:sans-serif;padding:2rem;max-width:400px;margin:auto;}
    table{width:100%;border-collapse:collapse;}
    td{padding:.3rem 0;}
    hr{border:none;border-top:1px solid #ddd;margin:.5rem 0;}
  </style></head><body>${content}<script>window.print();window.close();<\/script></body></html>`);
  w.document.close();
};

window.saveReceiptImage = async () => {
  const el = document.getElementById('receipt-content');
  // Use html2canvas if available, otherwise fall back to print
  if (window.html2canvas) {
    const canvas = await html2canvas(el, { backgroundColor: '#ffffff' });
    const a = document.createElement('a');
    a.download = `receipt-${Date.now()}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  } else {
    toast('Tip: Use Print → Save as PDF for PDF format', 'default');
    window.printReceipt();
  }
};

window.deleteGiving = async (id) => {
  if (!confirm('Delete this giving record?')) return;
  const { error } = await db.giving.delete(id);
  if (error) { toast(error.message, 'error'); return; }
  givingData = givingData.filter(r => r.id !== id);
  renderGiving();
};

// ─── VOLUNTEERS ───────────────────────────────────────────────────────────────
let volData = [];
async function loadVolunteers() {
  document.getElementById('vol-add-btn').onclick = () => {
    document.getElementById('volunteer-form').reset();
    document.getElementById('volf-id').value = '';
    document.getElementById('volf-date').value = today();
    openModal('modal-volunteer');
  };
  document.getElementById('vol-dept-filter').addEventListener('change', renderVolunteers);
  const { data, error } = await db.volunteers.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  volData = data || [];
  const depts = [...new Set(volData.map(v => v.department))];
  const df = document.getElementById('vol-dept-filter');
  df.innerHTML = '<option value="">All Departments</option>' + depts.map(d => `<option>${d}</option>`).join('');
  renderVolunteers();
}

function renderVolunteers() {
  const dept = document.getElementById('vol-dept-filter').value;
  const rows = dept ? volData.filter(v => v.department === dept) : volData;
  buildTable(document.getElementById('vol-tbody'), rows, v => {
    const name = v.members ? `${v.members.first_name} ${v.members.last_name}` : '—';
    return `
      <td class="td-name">${name}</td>
      <td>${v.department}</td>
      <td>${v.role || '—'}</td>
      <td>${fmtDate(v.joined_date)}</td>
      <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteVol('${v.id}')">Remove</button></td>`;
  });
}

window.deleteVol = async (id) => {
  if (!confirm('Remove this volunteer?')) return;
  const { error } = await db.volunteers.delete(id);
  if (error) { toast(error.message, 'error'); return; }
  volData = volData.filter(v => v.id !== id);
  renderVolunteers();
};

// ─── VISITORS ─────────────────────────────────────────────────────────────────
const VIS_STATUS = {
  new_visitor: { label: 'New Visitor', cls: 'badge-gray' },
  in_classes:  { label: 'In Classes',  cls: 'badge-gold' },
  completed:   { label: 'Completed Classes', cls: 'badge-blue' },
  full_member: { label: 'Full Member', cls: 'badge-green' },
};
const NEXT_STATUS = { new_visitor: 'in_classes', in_classes: 'completed', completed: 'full_member' };

function denominationLabel() {
  const d = currentOrg?.denomination;
  return d ? `Already a member of ${d}?` : 'Already a member of this denomination?';
}

let visTabInit = false;
let visData = [];
async function loadVisitors() {
  if (!visTabInit) {
    visTabInit = true;
    document.querySelectorAll('#vis-tabs .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#vis-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const t = btn.dataset.vtab;
        ['visitors','classes','teachers'].forEach(x =>
          document.getElementById('vtab-' + x).style.display = x === t ? '' : 'none');
        if (t === 'classes') loadClasses();
        if (t === 'teachers') loadTeachers();
      });
    });
    document.getElementById('teacher-add-btn').onclick = () => openTeacherModal();
    document.getElementById('class-add-btn').onclick = () => openClassModal();
    const lessonsBtn = document.getElementById('lessons-manage-btn');
    if (canWritePage('page-visitors')) {
      lessonsBtn.style.display = '';
      lessonsBtn.onclick = () => openLessonsModal();
      initLessonsModal();
    }
    initNewcomerForms();
  }
  document.getElementById('vis-add-btn').onclick = () => openVisitorModal();
  ['vis-purpose-filter','vis-status-filter','vis-gender-filter'].forEach(id =>
    document.getElementById(id).addEventListener('change', renderVisitors));
  document.getElementById('vis-search').addEventListener('input', debounce(renderVisitors, 250));
  const { data, error } = await db.visitors.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  visData = data || [];
  // stats
  const c = s => visData.filter(v => (v.status || 'new_visitor') === s).length;
  document.getElementById('vs-new').textContent       = fmtNum(c('new_visitor'));
  document.getElementById('vs-classes').textContent   = fmtNum(c('in_classes'));
  document.getElementById('vs-completed').textContent = fmtNum(c('completed'));
  document.getElementById('vs-members').textContent   = fmtNum(c('full_member'));
  renderVisitors();
}

function renderVisitors() {
  const q = document.getElementById('vis-search').value.toLowerCase();
  const pf = document.getElementById('vis-purpose-filter').value;
  const sf = document.getElementById('vis-status-filter').value;
  const gf = document.getElementById('vis-gender-filter').value;
  let rows = visData;
  if (q)  rows = rows.filter(v => `${v.first_name} ${v.last_name||''} ${v.phone||''}`.toLowerCase().includes(q));
  if (pf) rows = rows.filter(v => v.purpose === pf);
  if (sf) rows = rows.filter(v => (v.status || 'new_visitor') === sf);
  if (gf) rows = rows.filter(v => v.gender === gf);
  buildTable(document.getElementById('vis-tbody'), rows, v => {
    const st = VIS_STATUS[v.status || 'new_visitor'] || VIS_STATUS.new_visitor;
    const next = NEXT_STATUS[v.status || 'new_visitor'];
    const purposeBadge = v.purpose === 'Joining' ? '<span class="badge badge-green">Joining</span>' : '<span class="badge badge-blue">Visiting</span>';
    const advance = next && next !== 'full_member'
      ? `<button class="btn btn-ghost btn-sm" onclick="advanceVisitor('${v.id}','${next}')">→ ${VIS_STATUS[next].label}</button>` : '';
    const convert = (v.status === 'completed' || v.purpose === 'Joining') && v.status !== 'full_member'
      ? `<button class="btn btn-ghost btn-sm" style="color:var(--green)" onclick="convertVisitor('${v.id}')">Make Member</button>` : '';
    return `
      <td class="td-name">${v.first_name} ${v.last_name || ''}</td>
      <td>${purposeBadge}</td>
      <td><span class="badge ${st.cls}">${st.label}</span></td>
      <td>${v.phone || '—'}</td>
      <td>${fmtDate(v.visit_date)}</td>
      <td class="td-actions">
        ${advance}${convert}
        <button class="btn btn-ghost btn-sm" onclick="editVisitor('${v.id}')">Edit</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteVisitor('${v.id}')">Delete</button>
      </td>`;
  });
}

function openVisitorModal(v = null) {
  document.getElementById('visitor-form').reset();
  document.getElementById('visitor-modal-title').textContent = v ? 'Edit Visitor' : 'Register Visitor';
  document.getElementById('visf-already-label').textContent = denominationLabel();
  document.getElementById('visf-id').value = v?.id || '';
  document.getElementById('visf-first').value = v?.first_name || '';
  document.getElementById('visf-last').value = v?.last_name || '';
  document.getElementById('visf-phone').value = v?.phone || '';
  document.getElementById('visf-date').value = v?.visit_date || today();
  document.getElementById('visf-gender').value = v?.gender || '';
  document.getElementById('visf-age').value = v?.age ?? '';
  document.getElementById('visf-purpose').value = v?.purpose || 'Visiting';
  document.getElementById('visf-status').value = v?.status || 'new_visitor';
  document.getElementById('visf-already').checked = !!v?.already_member;
  document.getElementById('visf-followed').checked = !!v?.followed_up;
  document.getElementById('visf-how').value = v?.how_heard || '';
  document.getElementById('visf-notes').value = v?.notes || '';
  openModal('modal-visitor');
}

window.editVisitor = (id) => { const v = visData.find(x => x.id === id); if (v) openVisitorModal(v); };

window.advanceVisitor = async (id, status) => {
  const { error } = await db.visitors.update(id, { status });
  if (error) { toast(error.message, 'error'); return; }
  toast(`Moved to ${VIS_STATUS[status].label}`, 'success');
  loaded.delete('page-visitors'); loadVisitors();
};

window.convertVisitor = async (id) => {
  if (!confirm('Create a member record from this visitor? They can complete their details via the confirm-your-data portal.')) return;
  const { error } = await db.visitors.convert(id, ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  toast('Member created — pending data confirmation', 'success');
  await prefetchMembers();
  loaded.delete('page-visitors'); loadVisitors();
};

window.deleteVisitor = async (id) => {
  if (!confirm('Delete this visitor record?')) return;
  await db.visitors.delete(id);
  loaded.delete('page-visitors'); loadVisitors();
};

// ─── NEWCOMER TEACHERS ───────────────────────────────────────────────────────
let teachersData = [];
async function loadTeachers() {
  const { data, error } = await db.ncTeachers.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  teachersData = data || [];
  const grid = document.getElementById('teachers-grid');
  grid.innerHTML = teachersData.map(t => `
    <div class="card" style="margin:0;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div><strong>${t.name}</strong><div class="text-sm text-muted">${t.phone || '—'}</div></div>
        <span class="badge badge-${t.is_active ? 'green' : 'gray'}">${t.is_active ? 'Active' : 'Inactive'}</span>
      </div>
      <div style="margin-top:.65rem;display:flex;gap:.4rem;">
        <button class="btn btn-ghost btn-sm" onclick="editTeacher('${t.id}')">Edit</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteTeacher('${t.id}')">Remove</button>
      </div>
    </div>`).join('') || '<p class="text-sm text-muted">No teachers yet.</p>';
}
function openTeacherModal(t = null) {
  document.getElementById('teacher-form').reset();
  document.getElementById('teacher-modal-title').textContent = t ? 'Edit Teacher' : 'Add Teacher';
  document.getElementById('tf-id').value = t?.id || '';
  document.getElementById('tf-name').value = t?.name || '';
  document.getElementById('tf-phone').value = t?.phone || '';
  document.getElementById('tf-active').checked = t ? t.is_active : true;
  openModal('modal-teacher');
}
window.editTeacher = (id) => { const t = teachersData.find(x => x.id === id); if (t) openTeacherModal(t); };
window.deleteTeacher = async (id) => {
  if (!confirm('Remove this teacher?')) return;
  await db.ncTeachers.delete(id);
  loadTeachers();
};

// ─── NEWCOMER CLASSES ────────────────────────────────────────────────────────
let classesData = [];
async function loadClasses() {
  const { data, error } = await db.ncClasses.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  classesData = data || [];
  const required = requiredLessons();
  // distinct lessons attended per visitor
  const lessonsByVisitor = {};
  classesData.forEach(c => { (lessonsByVisitor[c.visitor_id] = lessonsByVisitor[c.visitor_id] || new Set()).add(c.lesson); });
  const reqAttended = id => [...(lessonsByVisitor[id] || [])].filter(l => required.includes(l)).length;
  // progress for joining newcomers (in_classes / completed)
  const learners = visData.filter(v => ['in_classes','completed'].includes(v.status));
  document.getElementById('class-progress-tbody').innerHTML = learners.map(v => {
    const st = VIS_STATUS[v.status || 'new_visitor'];
    return `<tr>
      <td class="td-name">${v.first_name} ${v.last_name || ''}</td>
      <td>${reqAttended(v.id)} / ${required.length} required</td>
      <td><span class="badge ${st.cls}">${st.label}</span></td>
      <td class="td-actions"><button class="btn btn-ghost btn-sm" onclick="openClassModal('${v.id}')">Record</button></td>
    </tr>`;
  }).join('') || '<tr><td class="tbl-empty" colspan="4">No newcomers in classes yet</td></tr>';

  buildTable(document.getElementById('class-recent-tbody'), classesData.slice(0, 50), c => {
    const name = c.visitors ? `${c.visitors.first_name} ${c.visitors.last_name || ''}` : '—';
    return `<td>${fmtDate(c.date_attended)}</td><td class="td-name">${name}</td><td>${c.lesson}</td>
      <td>${c.newcomer_teachers?.name || '—'}</td>
      <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteClass('${c.id}')">Delete</button></td>`;
  });
}

function openClassModal(visitorId = '') {
  document.getElementById('class-form').reset();
  document.getElementById('cf-id').value = '';
  document.getElementById('cf-date').value = today();
  // newcomers eligible for classes (joining / in classes / completed)
  const learners = visData.filter(v => v.purpose === 'Joining' || ['in_classes','completed'].includes(v.status));
  document.getElementById('cf-visitor').innerHTML = learners.map(v =>
    `<option value="${v.id}">${v.first_name} ${v.last_name || ''}</option>`).join('') || '<option value="">(no joining newcomers)</option>';
  if (visitorId) document.getElementById('cf-visitor').value = visitorId;
  // lessons from configurable list
  populateAllConfigTargets();
  // teachers
  const active = teachersData.filter(t => t.is_active);
  document.getElementById('cf-lead').innerHTML = '<option value="">—</option>' +
    active.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  document.getElementById('cf-support').innerHTML = active.map(t =>
    `<label style="display:flex;align-items:center;gap:.5rem;font-size:.85rem;"><input type="checkbox" class="cf-support-cb" value="${t.name}"/> ${t.name}</label>`).join('') || '<span class="text-sm text-muted">No teachers added yet.</span>';
  openModal('modal-class');
}
window.openClassModal = openClassModal;

window.deleteClass = async (id) => {
  if (!confirm('Delete this class attendance record?')) return;
  await db.ncClasses.delete(id);
  loadClasses();
};

function initNewcomerForms() {
  document.getElementById('teacher-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('tf-id').value;
    const data = {
      org_id: ORG_ID,
      name:   document.getElementById('tf-name').value.trim(),
      phone:  document.getElementById('tf-phone').value.trim() || null,
      is_active: document.getElementById('tf-active').checked,
    };
    const { error } = id ? await db.ncTeachers.update(id, data) : await db.ncTeachers.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Teacher saved', 'success');
    closeModal('modal-teacher');
    loadTeachers();
  });

  document.getElementById('class-form').addEventListener('submit', async e => {
    e.preventDefault();
    const visitorId = document.getElementById('cf-visitor').value;
    if (!visitorId) { toast('Select a newcomer', 'error'); return; }
    const supporting = [...document.querySelectorAll('.cf-support-cb:checked')].map(c => c.value);
    const data = {
      org_id: ORG_ID,
      visitor_id: visitorId,
      lesson: document.getElementById('cf-lesson').value,
      date_attended: document.getElementById('cf-date').value,
      lead_teacher_id: document.getElementById('cf-lead').value || null,
      supporting_teachers: supporting,
      notes: document.getElementById('cf-notes').value.trim() || null,
    };
    const { error } = await db.ncClasses.insert(data);
    if (error) { toast(error.code === '23505' ? 'That lesson is already recorded for this newcomer' : error.message, 'error'); return; }
    // Auto-advance status based on lessons attended
    await advanceClassProgress(visitorId);
    toast('Attendance recorded', 'success');
    closeModal('modal-class');
    loaded.delete('page-visitors');
    await loadVisitors();
    loadClasses();
  });
}

async function advanceClassProgress(visitorId) {
  const required = requiredLessons();
  const { data } = await db.ncClasses.list(ORG_ID);
  const attended = new Set((data || []).filter(c => c.visitor_id === visitorId).map(c => c.lesson));
  const reqDone = required.filter(l => attended.has(l)).length;
  const v = visData.find(x => x.id === visitorId);
  let newStatus = null;
  if (required.length && reqDone >= required.length) newStatus = 'completed';
  else if (!v || v.status === 'new_visitor') newStatus = 'in_classes';
  if (newStatus && (!v || v.status !== newStatus) && v?.status !== 'full_member') {
    await db.visitors.update(visitorId, { status: newStatus });
  }
}

// ─── FAMILY LIFE ──────────────────────────────────────────────────────────────
async function loadFamily() {
  document.getElementById('fl-add-btn').onclick = () => {
    document.getElementById('family-form').reset();
    document.getElementById('flf-id').value = '';
    document.getElementById('flf-date').value = today();
    openModal('modal-family');
  };
  document.getElementById('fl-type-filter').addEventListener('change', fetchFamily);
  await fetchFamily();
}

async function fetchFamily() {
  const type = document.getElementById('fl-type-filter').value;
  const { data, error } = await db.familyLife.list(ORG_ID, type || null);
  if (error) { toast(error.message, 'error'); return; }
  buildTable(document.getElementById('fl-tbody'), data || [], r => `
    <td><span class="badge badge-gold">${r.type}</span></td>
    <td class="td-name">${r.member_name || '—'}</td>
    <td>${r.description || '—'}</td>
    <td>${fmtDate(r.event_date)}</td>
    <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteFl('${r.id}')">Delete</button></td>`);
}

window.deleteFl = async (id) => {
  if (!confirm('Delete this record?')) return;
  await db.familyLife.delete(id);
  await fetchFamily();
};

// ─── COMMUNICATIONS ───────────────────────────────────────────────────────────
// Phone numbers of members in an audience (only those with a number on record).
function audienceMembers(audience) {
  const has = m => m.phone && m.phone.trim();
  const txt = m => `${m.role || ''} ${m.group_name || ''}`.toLowerCase();
  return allMembers.filter(m => {
    if (!has(m)) return false;
    if (audience === 'leaders') return /elder|deacon|pastor|presbyter|leader/.test(txt(m));
    if (audience === 'youth')   return /youth|young/.test(txt(m));
    return true; // 'all'
  });
}
function audienceRecipients(audience) {
  return audienceMembers(audience).map(m => m.phone.trim());
}
function updateCommsSmsHint() {
  const isSms = document.getElementById('cf-channel').value === 'sms';
  document.getElementById('cf-sms-note').style.display = isSms ? '' : 'none';
  const countEl = document.getElementById('cf-sms-count');
  if (!isSms) { countEl.style.display = 'none'; return; }
  const n = audienceRecipients(document.getElementById('cf-audience').value).length;
  const len = document.getElementById('cf-body').value.length;
  const parts = Math.max(1, Math.ceil(len / 160));
  countEl.style.display = '';
  countEl.textContent = `${n} recipient(s) · ${len} chars · ${parts} SMS part(s) each`;
}

async function loadComms() {
  document.getElementById('comms-add-btn').onclick = () => {
    document.getElementById('comms-form').reset();
    document.getElementById('cf-id').value = '';
    updateCommsSmsHint();
    openModal('modal-comms');
  };
  ['cf-channel','cf-audience','cf-body'].forEach(id =>
    document.getElementById(id).addEventListener('input', updateCommsSmsHint));
  await fetchComms();
}

async function fetchComms() {
  const { data, error } = await db.communications.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  const list = document.getElementById('comms-list');
  if (!data?.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📢</div><h3>No messages yet</h3></div>';
    return;
  }
  list.innerHTML = data.map(c => `
    <div class="card" style="display:flex;justify-content:space-between;gap:1rem;">
      <div>
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.4rem;">
          <h3 style="font-size:.95rem;">${c.title}</h3>
          <span class="badge badge-gray">${c.type}</span>
          <span class="badge badge-blue">${c.audience}</span>
        </div>
        <p style="font-size:.84rem;color:var(--ink2);">${c.body ? c.body.slice(0,160) + (c.body.length>160?'…':'') : ''}</p>
        <div class="text-xs text-muted" style="margin-top:.4rem;">${fmtDate(c.created_at)}</div>
      </div>
      <button class="btn btn-ghost btn-sm" style="color:var(--red);flex-shrink:0;" onclick="deleteComm('${c.id}')">Delete</button>
    </div>`).join('');
}

window.deleteComm = async (id) => {
  if (!confirm('Delete this message?')) return;
  await db.communications.delete(id);
  await fetchComms();
};

// ─── EVENTS ───────────────────────────────────────────────────────────────────
let eventsCache = [];
async function loadEvents() {
  document.getElementById('evt-add-btn').onclick = () => {
    document.getElementById('event-form').reset();
    document.getElementById('evtf-id').value = '';
    openModal('modal-event');
  };
  document.getElementById('evt-type-filter').addEventListener('change', fetchEvents);
  await fetchEvents();
}

window.editEvt = (id) => {
  const e = eventsCache.find(x => x.id === id);
  if (!e) return;
  document.getElementById('evtf-id').value = e.id;
  document.getElementById('evtf-title').value = e.title;
  setSelectValue('evtf-type', e.event_type);
  document.getElementById('evtf-loc').value = e.location || '';
  document.getElementById('evtf-start').value = e.start_date ? e.start_date.slice(0,16) : '';
  document.getElementById('evtf-end').value = e.end_date ? e.end_date.slice(0,16) : '';
  document.getElementById('evtf-participants').value = e.num_participants ?? '';
  document.getElementById('evtf-desc').value = e.description || '';
  openModal('modal-event');
};

async function fetchEvents() {
  const { data, error } = await db.events.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  buildTable(document.getElementById('evt-tbody'), data || [], e => `
    <td class="td-name">${e.title}</td>
    <td><span class="badge badge-gold">${e.event_type}</span></td>
    <td>${fmtDate(e.start_date)}</td>
    <td>${e.location || '—'}</td>
    <td>${e.num_participants != null ? fmtNum(e.num_participants) : '—'}</td>
    <td class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="editEvt('${e.id}')">Edit</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteEvt('${e.id}')">Delete</button>
    </td>`);
  eventsCache = data || [];
}

window.deleteEvt = async (id) => {
  if (!confirm('Delete this event?')) return;
  await db.events.delete(id);
  await fetchEvents();
};

// ─── WELFARE ──────────────────────────────────────────────────────────────────
async function loadWelfare() {
  document.getElementById('wf-add-btn').onclick = () => {
    document.getElementById('welfare-form').reset();
    document.getElementById('wff-id').value = '';
    document.getElementById('wff-date').value = today();
    openModal('modal-welfare');
  };
  document.getElementById('wf-status-filter').addEventListener('change', fetchWelfare);
  await fetchWelfare();
}

async function fetchWelfare() {
  const status = document.getElementById('wf-status-filter').value;
  const { data, error } = await db.welfare.list(ORG_ID, status || null);
  if (error) { toast(error.message, 'error'); return; }
  buildTable(document.getElementById('wf-tbody'), data || [], w => `
    <td class="td-name">${w.member_name || '—'}</td>
    <td>${w.type}</td>
    <td>${w.amount ? fmtMoney(w.amount, CURRENCY) : '—'}</td>
    <td>${fmtDate(w.welfare_date)}</td>
    <td><span class="badge welfare-status-${w.status}">${w.status}</span></td>
    <td class="td-actions">
      <select class="form-control" style="width:auto;min-height:32px;font-size:.76rem;padding:.2rem .5rem;" onchange="updateWelfareStatus('${w.id}',this.value)">
        ${['pending','approved','disbursed','closed'].map(s=>`<option value="${s}"${s===w.status?' selected':''}>${s}</option>`).join('')}
      </select>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteWelfare('${w.id}')">Delete</button>
    </td>`);
}

window.updateWelfareStatus = async (id, status) => {
  const { error } = await db.welfare.update(id, { status });
  if (error) { toast(error.message, 'error'); return; }
  toast('Status updated', 'success');
};

window.deleteWelfare = async (id) => {
  if (!confirm('Delete this welfare case?')) return;
  await db.welfare.delete(id);
  await fetchWelfare();
};

// ─── EDUCATION ────────────────────────────────────────────────────────────────
async function loadEducation() {
  document.getElementById('edu-add-btn').onclick = () => {
    document.getElementById('education-form').reset();
    document.getElementById('eduf-id').value = '';
    openModal('modal-education');
  };
  const { data, error } = await db.education.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  buildTable(document.getElementById('edu-tbody'), data || [], e => `
    <td class="td-name">${e.member_name || '—'}</td>
    <td>${e.program}</td>
    <td>${e.institution || '—'}</td>
    <td>${e.year || '—'}</td>
    <td><span class="badge badge-blue">${e.status}</span></td>
    <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteEdu('${e.id}')">Delete</button></td>`);
}

window.deleteEdu = async (id) => {
  if (!confirm('Delete?')) return;
  await db.education.delete(id);
  await loadEducation();
};

// ─── CONFIGURABLE LISTS (admin-managed dropdown options) ─────────────────────
// Stored per-org in organizations.settings.lists.<key>. No schema change ever.
const CONFIG_LISTS = {
  coordinating_groups: {
    label: 'Mission Coordinating Groups',
    defaults: ['M&E Committee','BSPG','JY','YPG','YAF','MF','WF','Others'],
    targets: [{ select: 'misf-group', blank: true }],
  },
  welfare_types: {
    label: 'Welfare Types',
    defaults: ['Bereavement','Hospital','Financial Assistance','Food','Invalid/Homebound','Marriage','Child Naming','Accident','Other'],
    targets: [{ select: 'wff-type' }],
  },
  event_types: {
    label: 'Event Types',
    defaults: ['Service','Meeting','Outreach','Concert','Conference','ESR','DSS','Other'],
    targets: [{ select: 'evtf-type' }],
  },
  giving_categories: {
    label: 'Giving Categories',
    defaults: ['Tithe','Offering','Pledge','Donation','Building Fund','Missions','Special'],
    targets: [{ select: 'gf-cat' }],
  },
  member_roles: {
    label: 'Member Roles',
    defaults: ['General','Elder','Deacon','Youth','Children','Visitor'],
    targets: [{ datalist: 'member-roles-list' }],
  },
  employment_types: {
    label: 'Employment Status',
    defaults: ['Active','Unemployed','Retired','Self-employed','Student'],
    targets: [{ select: 'mf-emp-type', blank: true }],
  },
  newcomer_lessons: {
    label: 'Newcomer Class Lessons',
    defaults: ['Part 1','Part 2','Study 1','Study 2','Study 3','Study 4','Study 5','Conclusion','Holy Communion','Baptism'],
    targets: [{ select: 'cf-lesson' }],
  },
  service_types: {
    label: 'Attendance Service Types',
    defaults: ['Sunday Service','Prayer Meeting','Group Meeting','Special Service'],
    targets: [{ select: 'att-type' }],
  },
  visitor_sources: {
    label: 'Visitor Sources (How heard)',
    defaults: ['Friend / Family','Social Media','Flyer / Poster','Walked in','Website','Invited to event','Other'],
    targets: [{ datalist: 'visitor-sources-list' }],
  },
  education_programs: {
    label: 'Education Programs',
    defaults: ['Primary','JHS','SHS','Tertiary','Vocational / Technical','Apprenticeship','Other'],
    targets: [{ datalist: 'education-programs-list' }],
  },
  education_status: {
    label: 'Education Status',
    defaults: ['Enrolled','Completed','Withdrawn','Deferred'],
    targets: [{ select: 'eduf-status' }],
  },
  scholarship_status: {
    label: 'Scholarship Status',
    defaults: ['Active','Completed','Suspended'],
    targets: [{ select: 'schf-status' }],
  },
};

function listValues(key) {
  const s = currentOrg?.settings || {};
  const v = (s.lists && s.lists[key]) || s[key];   // s[key] = legacy coordinating_groups
  return Array.isArray(v) && v.length ? v : CONFIG_LISTS[key].defaults;
}

// Newcomer lessons that are optional (excluded from the completion requirement)
function optionalLessons() { return currentOrg?.settings?.lists?.newcomer_optional_lessons || []; }
function requiredLessons() { return listValues('newcomer_lessons').filter(l => !optionalLessons().includes(l)); }
window.toggleOptionalLesson = async (name) => {
  const opt = optionalLessons().slice();
  const i = opt.indexOf(name);
  if (i >= 0) opt.splice(i, 1); else opt.push(name);
  await saveList('newcomer_optional_lessons', opt);
  renderListChips('newcomer_lessons');
};

// ── Lessons editor modal (permission-scoped; usable by Missions Coordinator) ──
let lessonsDraft = [], lessonsOptDraft = [];
function renderLessonsDraft() {
  document.getElementById('lessons-list').innerHTML = lessonsDraft.map((l, i) => {
    const isOpt = lessonsOptDraft.includes(l);
    return `<div style="display:flex;align-items:center;gap:.5rem;">
      <span style="flex:1;">${l}</span>
      <button type="button" onclick="window._lessonToggleOpt(${i})" style="background:${isOpt?'rgba(184,150,74,.18)':'none'};border:1px solid var(--border);color:${isOpt?'var(--gold-dark)':'var(--ink3)'};border-radius:6px;cursor:pointer;font-size:.66rem;padding:.1rem .4rem;">${isOpt?'optional':'required'}</button>
      <button type="button" onclick="window._lessonRemove(${i})" class="btn btn-ghost btn-sm" style="color:var(--red);padding:.1rem .35rem;">✕</button>
    </div>`;
  }).join('') || '<p class="text-sm text-muted" style="margin:0;">No lessons yet.</p>';
}
window._lessonToggleOpt = (i) => {
  const l = lessonsDraft[i];
  const j = lessonsOptDraft.indexOf(l);
  if (j >= 0) lessonsOptDraft.splice(j, 1); else lessonsOptDraft.push(l);
  renderLessonsDraft();
};
window._lessonRemove = (i) => {
  const l = lessonsDraft.splice(i, 1)[0];
  lessonsOptDraft = lessonsOptDraft.filter(x => x !== l);
  renderLessonsDraft();
};
function openLessonsModal() {
  lessonsDraft = listValues('newcomer_lessons').slice();
  lessonsOptDraft = optionalLessons().slice();
  document.getElementById('lessons-new').value = '';
  renderLessonsDraft();
  openModal('modal-lessons');
}
function initLessonsModal() {
  const addBtn = document.getElementById('lessons-add-btn');
  const input = document.getElementById('lessons-new');
  const add = () => {
    const v = input.value.trim();
    if (!v) return;
    if (!lessonsDraft.includes(v)) lessonsDraft.push(v);
    input.value = '';
    renderLessonsDraft();
    input.focus();
  };
  addBtn.onclick = add;
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  document.getElementById('lessons-save-btn').onclick = async () => {
    const { error } = await db.ncLessons.save(ORG_ID, lessonsDraft, lessonsOptDraft);
    if (error) { toast(error.message, 'error'); return; }
    // keep local org settings in sync
    const lists = { ...((currentOrg.settings || {}).lists || {}),
      newcomer_lessons: lessonsDraft, newcomer_optional_lessons: lessonsOptDraft };
    currentOrg.settings = { ...(currentOrg.settings || {}), lists };
    toast('Lessons saved', 'success');
    closeModal('modal-lessons');
    populateAllConfigTargets();
    if (document.getElementById('lists-container')) renderListChips('newcomer_lessons');
    loadClasses();
  };
}

// Populate every select/datalist bound to a configurable list.
function populateAllConfigTargets() {
  Object.entries(CONFIG_LISTS).forEach(([key, def]) => {
    const values = listValues(key);
    def.targets.forEach(t => {
      if (t.select) {
        const sel = document.getElementById(t.select);
        if (!sel) return;
        const cur = sel.value;
        sel.innerHTML = (t.blank ? '<option value="">—</option>' : '') +
          values.map(v => `<option>${v}</option>`).join('');
        if (cur) setSelectValue(t.select, cur);
      } else if (t.datalist) {
        const dl = document.getElementById(t.datalist);
        if (dl) dl.innerHTML = values.map(v => `<option value="${v}">`).join('');
      }
    });
  });
}

// Set a select's value, adding the option first if missing (so editing a record
// whose value was later removed from the list still displays correctly).
function setSelectValue(selectId, value) {
  const sel = document.getElementById(selectId);
  if (!sel || value == null) return;
  if (![...sel.options].some(o => o.value === value)) {
    sel.insertAdjacentHTML('beforeend', `<option>${value}</option>`);
  }
  sel.value = value;
}

// ─── MISSIONS ─────────────────────────────────────────────────────────────────
const populateMissionGroups = populateAllConfigTargets;

let missionsCache = [];
async function loadMissions() {
  document.getElementById('mis-add-btn').onclick = () => {
    document.getElementById('mission-form').reset();
    document.getElementById('misf-id').value = '';
    populateMissionGroups();
    openModal('modal-mission');
  };
  const { data, error } = await db.missions.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  missionsCache = data || [];
  buildTable(document.getElementById('mis-tbody'), missionsCache, m => `
    <td class="td-name">${m.title}</td>
    <td>${m.coordinating_group || '—'}</td>
    <td>${m.location || '—'}</td>
    <td>${fmtDate(m.start_date)}</td>
    <td>${m.participants != null ? fmtNum(m.participants) : '—'}</td>
    <td>${m.persons_reached != null ? fmtNum(m.persons_reached) : '—'}</td>
    <td>${m.souls_won != null ? fmtNum(m.souls_won) : '—'}</td>
    <td><span class="badge badge-${m.status==='active'?'green':m.status==='completed'?'blue':'gray'}">${m.status}</span></td>
    <td class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="editMis('${m.id}')">Edit</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteMis('${m.id}')">Delete</button>
    </td>`);
}

window.editMis = (id) => {
  const m = missionsCache.find(x => x.id === id);
  if (!m) return;
  populateMissionGroups();
  document.getElementById('misf-id').value = m.id;
  document.getElementById('misf-title').value = m.title || '';
  // Include a legacy/removed group as an option so it still shows when editing
  const sel = document.getElementById('misf-group');
  if (m.coordinating_group && ![...sel.options].some(o => o.value === m.coordinating_group)) {
    sel.insertAdjacentHTML('beforeend', `<option>${m.coordinating_group}</option>`);
  }
  sel.value = m.coordinating_group || '';
  document.getElementById('misf-loc').value = m.location || '';
  document.getElementById('misf-start').value = m.start_date || '';
  document.getElementById('misf-end').value = m.end_date || '';
  document.getElementById('misf-participants').value = m.participants ?? '';
  document.getElementById('misf-reached').value = m.persons_reached ?? '';
  document.getElementById('misf-souls').value = m.souls_won ?? '';
  document.getElementById('misf-budget').value = m.budget ?? '';
  document.getElementById('misf-status').value = m.status || 'active';
  document.getElementById('misf-notes').value = m.notes || '';
  openModal('modal-mission');
};

window.deleteMis = async (id) => {
  if (!confirm('Delete?')) return;
  await db.missions.delete(id);
  await loadMissions();
};

// ─── SCHOLARSHIP ──────────────────────────────────────────────────────────────
async function loadScholarship() {
  document.getElementById('sch-add-btn').onclick = () => {
    document.getElementById('scholarship-form').reset();
    document.getElementById('schf-id').value = '';
    openModal('modal-scholarship');
  };
  const { data, error } = await db.scholarships.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  buildTable(document.getElementById('sch-tbody'), data || [], s => `
    <td class="td-name">${s.member_name || '—'}</td>
    <td>${s.institution || '—'}</td>
    <td>${s.field_of_study || '—'}</td>
    <td>${s.academic_year || '—'}</td>
    <td>${s.amount ? fmtMoney(s.amount, CURRENCY) : '—'}</td>
    <td><span class="badge badge-${(s.status||'').toLowerCase()==='active'?'green':(s.status||'').toLowerCase()==='completed'?'blue':'gray'}">${s.status}</span></td>
    <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteSch('${s.id}')">Delete</button></td>`);
}

window.deleteSch = async (id) => {
  if (!confirm('Delete?')) return;
  await db.scholarships.delete(id);
  await loadScholarship();
};

// ─── EXPENSES ─────────────────────────────────────────────────────────────────
let expData = [];
async function loadExpenses() {
  document.getElementById('exp-add-btn').onclick = () => {
    document.getElementById('expense-form').reset();
    document.getElementById('expf-id').value = '';
    document.getElementById('expf-date').value = today();
    openModal('modal-expense');
  };
  document.getElementById('exp-status-filter').addEventListener('change', fetchExpenses);
  await fetchExpenses();
}

async function fetchExpenses() {
  const status = document.getElementById('exp-status-filter').value;
  const { data, error } = await db.expenses.list(ORG_ID, status || null);
  if (error) { toast(error.message, 'error'); return; }
  expData = data || [];
  const now = new Date();
  const m = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const monthExp  = expData.filter(e => e.expense_date?.startsWith(m));
  const monthTotal = monthExp.reduce((s,e) => s+Number(e.amount),0);
  const paidTotal  = monthExp.filter(e => e.status==='paid').reduce((s,e) => s+Number(e.amount),0);
  const pendCount  = expData.filter(e => e.status==='pending').length;
  document.getElementById('exp-month').textContent        = fmtMoney(monthTotal, CURRENCY);
  document.getElementById('exp-pending-count').textContent = fmtNum(pendCount);
  document.getElementById('exp-paid').textContent          = fmtMoney(paidTotal, CURRENCY);

  buildTable(document.getElementById('exp-tbody'), expData, e => `
    <td class="td-name">${e.title}</td>
    <td>${e.category}</td>
    <td style="color:var(--red);font-weight:500;">${fmtMoney(e.amount, CURRENCY)}</td>
    <td>${e.vendor || '—'}</td>
    <td>${fmtDate(e.expense_date)}</td>
    <td><span class="badge badge-${e.status==='paid'?'green':e.status==='approved'?'blue':e.status==='rejected'?'red':'gold'}">${e.status}</span></td>
    <td class="td-actions">
      ${e.status==='pending'?`<button class="btn btn-ghost btn-sm" onclick="approveExp('${e.id}')">Approve</button>`:''}
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteExp('${e.id}')">Delete</button>
    </td>`);
}

window.approveExp = async (id) => {
  const { error } = await db.expenses.update(id, { status: 'approved' });
  if (error) { toast(error.message, 'error'); return; }
  toast('Approved', 'success');
  await fetchExpenses();
};

window.deleteExp = async (id) => {
  if (!confirm('Delete this expense?')) return;
  await db.expenses.delete(id);
  await fetchExpenses();
};

// ─── FINANCE ──────────────────────────────────────────────────────────────────
let accountsCache = [];
async function loadFinanceTab(tab) {
  switch (tab) {
    case 'ledger':   await loadLedger();   break;
    case 'budgets':        await budgetBoot();         break;
    case 'payroll':        await loadPayroll();        break;
    case 'accounts':       await loadAccounts();       break;
    case 'reconciliation': await reconBoot();          break;
  }
}

async function loadAccounts() {
  document.getElementById('acct-add-btn').onclick = () => {
    document.getElementById('account-form').reset();
    openModal('modal-account');
  };
  const { data, error } = await db.accounts.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  accountsCache = data || [];
  buildTable(document.getElementById('acct-tbody'), accountsCache, a => `
    <td class="mono text-sm">${a.code || '—'}</td>
    <td class="td-name">${a.name}</td>
    <td><span class="badge badge-gray">${a.account_type}</span></td>
    <td style="font-weight:500;">${fmtMoney(a.balance, CURRENCY)}</td>
    <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteAcct('${a.id}')">Delete</button></td>`);
  populateAccountSelects();
}

function populateAccountSelects() {
  const opts = accountsCache.map(a => `<option value="${a.id}">${a.code ? a.code+' — ' : ''}${a.name}</option>`).join('');
  document.getElementById('txnf-debit').innerHTML  = opts;
  document.getElementById('txnf-credit').innerHTML = opts;
}

window.deleteAcct = async (id) => {
  if (!confirm('Delete this account?')) return;
  await db.accounts.delete(id);
  await loadAccounts();
};

async function loadLedger() {
  document.getElementById('txn-add-btn').onclick = async () => {
    document.getElementById('txn-form').reset();
    if (!accountsCache.length) await loadAccounts();
    document.getElementById('txnf-date').value = today();
    openModal('modal-txn');
  };
  const { data, error } = await db.transactions.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  buildTable(document.getElementById('txn-tbody'), data || [], t => `
    <td>${fmtDate(t.transaction_date)}</td>
    <td class="td-name">${t.description}</td>
    <td class="ledger-debit">${t.debit_account?.name || '—'}</td>
    <td class="ledger-credit">${t.credit_account?.name || '—'}</td>
    <td style="font-weight:500;">${fmtMoney(t.amount, CURRENCY)}</td>
    <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteTxn('${t.id}')">Void</button></td>`);
}

window.deleteTxn = async (id) => {
  if (!confirm('Void this entry? This will reverse the account balances.')) return;
  await db.transactions.delete(id);
  await loadLedger();
};

async function loadBudgets() {
  document.getElementById('budget-add-btn').onclick = () => openBudgetModal();
  const { data, error } = await db.budgets.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  const list = document.getElementById('budgets-list');
  budgetsCache = data || [];
  if (!data?.length) { list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💰</div><h3>No budgets yet</h3></div>'; return; }
  list.innerHTML = data.map(b => {
    const lines = b.budget_lines || [];
    const total = lines.reduce((s,l) => s+Number(l.amount),0);
    const spent = lines.reduce((s,l) => s+Number(l.spent),0);
    const pct = total > 0 ? Math.min(100, Math.round(spent/total*100)) : 0;
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.75rem;">
        <div><h3 style="margin-bottom:.15rem;">${b.name}</h3><div class="text-sm text-muted">${b.fiscal_year} · <span class="badge badge-${b.status==='active'?'green':'gray'}">${b.status}</span></div></div>
        <div style="text-align:right;"><div class="text-sm text-muted">Total</div><div style="font-weight:600;font-size:1.05rem;">${fmtMoney(total,CURRENCY)}</div></div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;font-size:.76rem;color:var(--ink3);margin-bottom:.25rem;"><span>Spent: ${fmtMoney(spent,CURRENCY)}</span><span>${pct}%</span></div>
        <div class="budget-bar"><div class="budget-bar-fill${pct>=100?' over':''}" style="width:${pct}%"></div></div>
      </div>
      <div style="margin-top:.85rem;display:flex;gap:.5rem;">
        <button class="btn btn-outline btn-sm" onclick="viewBudgetLines('${b.id}')">Manage Lines</button>
        <button class="btn btn-ghost btn-sm" onclick="editBudget('${b.id}')">Edit</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteBudget('${b.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

function openBudgetModal() {
  const name = prompt('Budget name (e.g. "2025 Annual Budget"):');
  if (!name) return;
  const year = prompt('Fiscal year:', new Date().getFullYear().toString());
  if (!year) return;
  db.budgets.insert({ org_id: ORG_ID, name, fiscal_year: year, currency: CURRENCY }).then(({ error }) => {
    if (error) { toast(error.message, 'error'); return; }
    toast('Budget created', 'success');
    loaded.delete('page-budget');
    loadFinanceTab('budgets');
  });
}

window.deleteBudget = async (id) => {
  if (!confirm('Delete this budget and all its lines?')) return;
  await db.budgets.update(id, { status: 'closed' });
  await loadBudgets();
};

let budgetsCache = [];
window.editBudget = (id) => {
  const b = budgetsCache.find(x => x.id === id);
  if (!b) return;
  const name = prompt('Budget name:', b.name);
  if (!name) return;
  const year = prompt('Fiscal year:', b.fiscal_year);
  if (!year) return;
  const statusOpts = ['draft','approved','active','closed'];
  const status = prompt(`Status (${statusOpts.join('/')}):`, b.status);
  if (!status || !statusOpts.includes(status)) { toast('Invalid status', 'error'); return; }
  db.budgets.update(id, { name, fiscal_year: year, status }).then(({ error }) => {
    if (error) { toast(error.message, 'error'); return; }
    toast('Budget updated', 'success');
    loaded.delete('page-budget');
    loadBudgets();
  });
};

window.viewBudgetLines = async (id) => {
  const b = budgetsCache.find(x => x.id === id);
  if (!b) return;
  const lines = b.budget_lines || [];
  const lineList = lines.map(l => `${l.category}: ${fmtMoney(l.amount, CURRENCY)} (spent: ${fmtMoney(l.spent, CURRENCY)})`).join('\n') || '(no lines yet)';
  const action = prompt(`Budget: ${b.name}\n\nLines:\n${lineList}\n\nEnter "add [category] [amount]" or "delete [category]" or cancel:`);
  if (!action) return;
  const addMatch = action.match(/^add\s+(.+?)\s+([\d.]+)$/i);
  const delMatch = action.match(/^delete\s+(.+)$/i);
  if (addMatch) {
    const { error } = await db.budgets.addLine({ budget_id: id, org_id: ORG_ID, category: addMatch[1].trim(), amount: parseFloat(addMatch[2]) });
    if (error) { toast(error.message, 'error'); return; }
    toast('Line added', 'success');
  } else if (delMatch) {
    const line = lines.find(l => l.category.toLowerCase() === delMatch[1].trim().toLowerCase());
    if (!line) { toast('Line not found', 'error'); return; }
    await db.budgets.deleteLine(line.id);
    toast('Line deleted', 'success');
  } else {
    toast('Unrecognised command', 'error'); return;
  }
  loaded.delete('page-budget');
  loadBudgets();
};

// ─── GHANA PAYROLL CALCULATIONS ──────────────────────────────────────────────
function calcGhanaPAYE(monthlyTaxable) {
  const bands = [
    { limit: 490,   rate: 0 },
    { limit: 110,   rate: 0.05 },
    { limit: 130,   rate: 0.10 },
    { limit: 3000,  rate: 0.175 },
    { limit: 16395, rate: 0.25 },
    { limit: Infinity, rate: 0.30 },
  ];
  let tax = 0, rem = Math.max(0, monthlyTaxable);
  for (const b of bands) {
    if (rem <= 0) break;
    const taxable = isFinite(b.limit) ? Math.min(rem, b.limit) : rem;
    tax += taxable * b.rate;
    rem -= taxable;
  }
  return +tax.toFixed(2);
}

window.calcPayroll = () => {
  const basic = parseFloat(document.getElementById('prf-basic').value) || 0;
  const allowRows = document.querySelectorAll('#prf-allowances-list .allowance-row');
  let allowTotal = 0;
  allowRows.forEach(row => { allowTotal += parseFloat(row.querySelector('.allow-amount').value) || 0; });
  const gross = basic + allowTotal;
  const ssnitEmp = +(basic * 0.055).toFixed(2);
  const ssnitEr  = +(basic * 0.13).toFixed(2);
  const tier2    = +(basic * 0.05).toFixed(2);
  const taxable  = gross - ssnitEmp;
  const paye     = calcGhanaPAYE(taxable);
  const deductRows = document.querySelectorAll('#prf-other-deductions-list .deduction-row');
  let otherDeduct = 0;
  deductRows.forEach(row => { otherDeduct += parseFloat(row.querySelector('.deduct-amount').value) || 0; });
  const totalDeduct = ssnitEmp + paye + otherDeduct;
  const net = gross - totalDeduct;
  document.getElementById('prf-ssnit-emp').value = ssnitEmp.toFixed(2);
  document.getElementById('prf-ssnit-er').value  = ssnitEr.toFixed(2);
  document.getElementById('prf-tier2').value      = tier2.toFixed(2);
  document.getElementById('prf-paye').value       = paye.toFixed(2);
  document.getElementById('prf-disp-gross').textContent  = fmtMoney(gross, CURRENCY);
  document.getElementById('prf-disp-deduct').textContent = fmtMoney(totalDeduct, CURRENCY);
  document.getElementById('prf-disp-net').textContent    = fmtMoney(net, CURRENCY);
};

window.addAllowanceRow = () => {
  const div = document.createElement('div');
  div.className = 'allowance-row form-row';
  div.innerHTML = `<div class="form-group"><input type="text" class="form-control allow-name" placeholder="Name (e.g. Housing)"/></div>
    <div class="form-group"><input type="number" class="form-control allow-amount" placeholder="Amount" step="0.01" oninput="calcPayroll()"/></div>
    <button type="button" onclick="this.parentElement.remove();calcPayroll()" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:1.1rem;padding:.5rem;">✕</button>`;
  document.getElementById('prf-allowances-list').appendChild(div);
};

window.addDeductionRow = () => {
  const div = document.createElement('div');
  div.className = 'deduction-row form-row';
  div.innerHTML = `<div class="form-group"><input type="text" class="form-control deduct-name" placeholder="Name (e.g. Loan)"/></div>
    <div class="form-group"><input type="number" class="form-control deduct-amount" placeholder="Amount" step="0.01" oninput="calcPayroll()"/></div>
    <button type="button" onclick="this.parentElement.remove();calcPayroll()" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:1.1rem;padding:.5rem;">✕</button>`;
  document.getElementById('prf-other-deductions-list').appendChild(div);
};

let payrollCache = [];

function openPayrollModal(p = null) {
  document.getElementById('prf-modal-title').textContent = p ? 'Edit Payroll' : 'Staff Payroll';
  document.getElementById('prf-id').value = p?.id || '';
  document.getElementById('prf-member-id').value = p?.member_id || '';
  document.getElementById('prf-member-name').value = '';
  document.getElementById('prf-name').value = p?.member_name || '';
  document.getElementById('prf-role').value = p?.staff_role || '';
  document.getElementById('prf-period').value = p?.pay_period || document.getElementById('payroll-period').value;
  document.getElementById('prf-payment-date').value = p?.payment_date || '';
  document.getElementById('prf-basic').value = p?.basic_salary || '';
  document.getElementById('prf-bank-name').value = p?.bank_name || '';
  document.getElementById('prf-bank-branch').value = p?.bank_branch || '';
  document.getElementById('prf-bank-acct').value = p?.bank_account_no || '';
  document.getElementById('prf-bank-acct-name').value = p?.bank_account_name || '';
  document.getElementById('prf-notes').value = p?.notes || '';
  // Rebuild allowances
  const alList = document.getElementById('prf-allowances-list');
  alList.innerHTML = '';
  (p?.allowances || []).forEach(a => {
    window.addAllowanceRow();
    const last = alList.lastElementChild;
    last.querySelector('.allow-name').value = a.name;
    last.querySelector('.allow-amount').value = a.amount;
  });
  // Rebuild other deductions
  const odList = document.getElementById('prf-other-deductions-list');
  odList.innerHTML = '';
  (p?.other_deductions || []).forEach(d => {
    window.addDeductionRow();
    const last = odList.lastElementChild;
    last.querySelector('.deduct-name').value = d.name;
    last.querySelector('.deduct-amount').value = d.amount;
  });
  calcPayroll();
  openModal('modal-payroll');
}

async function loadPayroll() {
  const pe = document.getElementById('payroll-period');
  if (!pe.options.length) {
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      pe.innerHTML += `<option value="${val}">${val}</option>`;
    }
  }
  document.getElementById('payroll-add-btn').onclick = () => openPayrollModal();
  pe.addEventListener('change', fetchPayroll);
  memberSelect(document.getElementById('prf-member-name'), () => allMembers, m => {
    document.getElementById('prf-member-id').value = m.id;
    document.getElementById('prf-name').value = `${m.first_name} ${m.last_name}`;
  });
  await fetchPayroll();
}

async function fetchPayroll() {
  const period = document.getElementById('payroll-period').value;
  const { data, error } = await db.payroll.list(ORG_ID, period);
  if (error) { toast(error.message, 'error'); return; }
  payrollCache = data || [];
  const totalNet = payrollCache.reduce((s,p) => s+Number(p.net_salary),0);
  buildTable(document.getElementById('payroll-tbody'), payrollCache, p => `
    <td class="td-name">${p.member_name}</td>
    <td>${p.staff_role || '—'}</td>
    <td>${fmtMoney(p.basic_salary, CURRENCY)}</td>
    <td>${fmtMoney(p.gross_salary, CURRENCY)}</td>
    <td style="color:var(--red);">${fmtMoney(p.total_deductions, CURRENCY)}</td>
    <td style="color:var(--green);font-weight:600;">${fmtMoney(p.net_salary, CURRENCY)}</td>
    <td><span class="badge badge-${p.status==='paid'?'green':'gold'}">${p.status}</span></td>
    <td class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="editPayroll('${p.id}')">Edit</button>
      ${p.status!=='paid'?`<button class="btn btn-ghost btn-sm" onclick="markPayrollPaid('${p.id}')">Mark Paid</button>`:''}
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deletePayroll('${p.id}')">Delete</button>
    </td>`);
}

window.editPayroll = (id) => {
  const p = payrollCache.find(x => x.id === id);
  if (p) openPayrollModal(p);
};

window.markPayrollPaid = async (id) => {
  await db.payroll.update(id, { status: 'paid', payment_date: today() });
  await fetchPayroll();
};

window.deletePayroll = async (id) => {
  if (!confirm('Delete payroll record?')) return;
  await db.payroll.delete(id);
  await fetchPayroll();
};

// ─── QR PAGE ──────────────────────────────────────────────────────────────────
function initQRPage() {
  const slug = currentOrg?.slug || '';
  const origin = window.location.origin;
  const link = `${origin}/qr/register/?org=${slug}`;
  const linkEl = document.getElementById('qr-open-link');
  if (linkEl) linkEl.href = link;
  document.getElementById('qr-copy-link')?.addEventListener('click', () => {
    navigator.clipboard.writeText(link).then(() => toast('Link copied!', 'success'));
  });
  document.getElementById('qr-link-members')?.addEventListener('click', async () => {
    const { data, error } = await db.qrRegs.linkToMembers(ORG_ID);
    if (error) { toast(error.message, 'error'); return; }
    toast(`Linked ${data ?? 0} QR registration(s) to members`, 'success');
  });
  document.getElementById('qr-selfci-btn')?.addEventListener('click', openSelfCheckinQR);
}

// ─── QR IMAGE HELPERS (render / branded card / print / save) ─────────────────
// Render a QR into a container element from arbitrary text.
function renderQRInto(elId, text) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  new QRCode(el, { text, width: 220, height: 220,
    colorDark: '#000000', colorLight: '#FFFFFF', correctLevel: QRCode.CorrectLevel.H });
}

// Compose a branded, printable card (navy frame + white quiet-zone + caption lines).
function buildQRCard(qrEl, lines) {
  const canvas = qrEl.querySelector('canvas') || qrEl.querySelector('img');
  if (!canvas) return null;
  const qrW = 220, qrH = 220;
  const pad = 32, quiet = 22, textH = 30 + lines.length * 24;
  const panelW = qrW + quiet * 2, panelH = qrH + quiet * 2;
  const out = document.createElement('canvas');
  out.width = panelW + pad * 2;
  out.height = panelH + pad * 2 + textH;
  const ctx = out.getContext('2d');
  // White card, gold top accent, black-on-white QR (scans most reliably).
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, out.width, out.height);
  ctx.fillStyle = '#B8964A'; ctx.fillRect(0, 0, out.width, 8);
  const px = pad, py = pad + 8;
  if (canvas.tagName === 'CANVAS') ctx.drawImage(canvas, px + quiet, py + quiet, qrW, qrH);
  const baseY = py + panelH;
  ctx.textAlign = 'center';
  lines.forEach((ln, i) => {
    ctx.fillStyle = i === 0 ? '#0F2340' : '#6B7280';
    ctx.font = i === 0 ? 'bold 18px serif' : '13px sans-serif';
    ctx.fillText(ln, out.width / 2, baseY + 30 + i * 22);
  });
  return out;
}

function saveQRCard(qrEl, lines, filename) {
  const out = buildQRCard(qrEl, lines);
  if (!out) { toast('QR not ready yet', 'error'); return; }
  const a = document.createElement('a');
  a.download = filename; a.href = out.toDataURL('image/png'); a.click();
}

function printQRCard(qrEl, lines) {
  const out = buildQRCard(qrEl, lines);
  if (!out) { toast('QR not ready yet', 'error'); return; }
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print', 'error'); return; }
  w.document.write(`<img src="${out.toDataURL('image/png')}" style="max-width:100%;" onload="window.print()"/>`);
  w.document.close();
}

// ── Member QR: regenerable, permanent per-member code ──
window.showMemberQR = async (memberId) => {
  const m = membersData.find(x => x.id === memberId) || allMembers.find(x => x.id === memberId);
  const { data: qrId, error } = await db.qrRegs.memberQr(memberId, ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  const name = m ? `${m.first_name} ${m.last_name || ''}`.trim() : 'Member';
  const meta = [m?.role, m?.membership_no ? '# ' + m.membership_no : ''].filter(Boolean).join(' · ') || '—';
  document.getElementById('mqr-name').textContent = name;
  document.getElementById('mqr-meta').textContent = meta;
  document.getElementById('mqr-id').textContent   = qrId;
  renderQRInto('mqr-canvas', qrId);
  const lines = [name, meta === '—' ? '' : meta, qrId].filter(Boolean);
  const fname = `qr-${name.replace(/\s+/g, '-') || 'member'}.png`;
  const qrEl = document.getElementById('mqr-canvas');
  document.getElementById('mqr-print').onclick = () => printQRCard(qrEl, lines);
  document.getElementById('mqr-save').onclick  = () => saveQRCard(qrEl, lines, fname);
  openModal('modal-member-qr');
};

// ── Self Check-In QR: one posted code the congregation scans ──
function renderSelfCheckinQR() {
  const type = document.getElementById('sci-type').value || 'Sunday Service';
  const url = `${window.location.origin}/qr/checkin/?org=${currentOrg?.slug || ''}&type=${encodeURIComponent(type)}`;
  renderQRInto('sci-canvas', url);
  const lines = [currentOrg?.name || 'Self Check-In', type, 'Scan to check in'];
  const qrEl = document.getElementById('sci-canvas');
  document.getElementById('sci-print').onclick = () => printQRCard(qrEl, lines);
  document.getElementById('sci-save').onclick  = () => saveQRCard(qrEl, lines, `self-checkin-${type.replace(/\s+/g, '-')}.png`);
}
function openSelfCheckinQR() {
  const sel = document.getElementById('sci-type');
  sel.innerHTML = listValues('service_types').map(t => `<option>${t}</option>`).join('');
  sel.onchange = renderSelfCheckinQR;
  renderSelfCheckinQR();
  openModal('modal-selfci');
}

let qrPendingData = [];
// Classify a registration's stored type/role into 'visitor' vs 'member'.
// New sign-ups store 'Newcomer/Visitor' or 'Member'; legacy rows store
// 'Visitor','General','Elder',… — anything visitor/newcomer-ish is a visitor.
function regType(role) {
  return /visitor|newcomer/i.test(role || '') ? 'visitor' : 'member';
}
function renderQRPending() {
  const filter = document.getElementById('qr-pending-filter').value;
  const rows = qrPendingData.filter(r => filter === 'all' || regType(r.role) === filter);
  const countEl = document.getElementById('qr-pending-filter-count');
  countEl.textContent = `${rows.length} of ${qrPendingData.length}`;
  buildTable(document.getElementById('qr-pending-tbody'), rows, r => {
    const isVisitor = regType(r.role) === 'visitor';
    const badge = `<span class="badge ${isVisitor ? 'badge-gray' : 'badge-blue'}">${r.role || '—'}</span>`;
    return `
    <td class="mono text-sm">${r.id}</td>
    <td class="td-name">${r.first_name} ${r.last_name || ''}</td>
    <td>${r.phone || '—'}</td>
    <td>${r.membership_no || '—'}</td>
    <td>${badge}</td>
    <td class="text-sm text-muted">${fmtDate(r.created_at)}</td>
    <td class="td-actions">
      <button class="btn btn-primary btn-sm" onclick="importQRReg('${r.id}')">Import to Members</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="dismissQRReg('${r.id}')">Dismiss</button>
    </td>`;
  });
}

async function loadQRPage() {
  const [{ data: pending }, { data: todayQR }] = await Promise.all([
    db.qrRegs.list(ORG_ID, false),
    supabase.from('attendance')
      .select('*, members(first_name,last_name,role)')
      .eq('org_id', ORG_ID).eq('service_date', today())
      .in('check_in_method', ['qr','qr_self'])
      .order('created_at', { ascending: false }),
  ]);

  qrPendingData = pending || [];
  document.getElementById('qr-pending-count').textContent = fmtNum(qrPendingData.length);
  document.getElementById('qr-today-count').textContent   = fmtNum(todayQR?.length || 0);

  const filterEl = document.getElementById('qr-pending-filter');
  filterEl.onchange = renderQRPending;
  renderQRPending();

  buildTable(document.getElementById('qr-today-tbody'), todayQR || [], r => {
    const name = r.members ? `${r.members.first_name} ${r.members.last_name || ''}`.trim() : (r.guest_name || '—');
    const role = r.members?.role || r.guest_role || '—';
    const src  = r.check_in_method === 'qr_self'
      ? '<span class="badge badge-gray">Self</span>'
      : '<span class="badge badge-blue">Scan</span>';
    return `
      <td class="td-name">${name} ${src}</td>
      <td>${role}</td>
      <td class="text-sm text-muted">${new Date(r.created_at).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</td>`;
  });

  // Subscribe to live QR check-ins (operator scan, manual entry, and self-scan)
  supabase.channel('qr-live')
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'attendance', filter:`org_id=eq.${ORG_ID}` }, p => {
      if (['qr','qr_self'].includes(p.new.check_in_method)) loadQRPage();
    }).subscribe();
}

window.importQRReg = async (id) => {
  const { error } = await db.qrRegs.import(id, ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  toast('Member imported successfully', 'success');
  await prefetchMembers();
  loaded.delete('page-qr');
  loadQRPage();
};

window.dismissQRReg = async (id) => {
  if (!confirm('Mark as imported without adding to members?')) return;
  await supabase.from('qr_registrations').update({ imported: true }).eq('id', id);
  loaded.delete('page-qr');
  loadQRPage();
};

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function initSettings() {
  document.getElementById('save-org-btn')?.addEventListener('click', saveOrgSettings);
  document.getElementById('copy-qr-link-btn')?.addEventListener('click', () => {
    const link = document.getElementById('qr-link-display2').textContent;
    navigator.clipboard.writeText(link).then(() => toast('Copied!', 'success'));
  });
  document.getElementById('sms-save-btn')?.addEventListener('click', async () => {
    const { error } = await db.sms.saveSettings(
      ORG_ID,
      document.getElementById('sms-enabled').checked,
      document.getElementById('sms-sender').value.trim(),
      document.getElementById('sms-on-giving').checked,
    );
    if (error) { toast(error.message, 'error'); return; }
    toast('SMS settings saved', 'success');
    loadSmsSettings();
  });
}

function loadSettings() {
  const org = currentOrg;
  if (!org) return;
  document.getElementById('set-org-name').value     = org.name || '';
  document.getElementById('set-org-sub').value      = org.sub_name || '';
  document.getElementById('set-org-denom').value    = org.denomination || '';
  document.getElementById('set-org-slug').value     = org.slug || '';
  document.getElementById('set-org-currency').value = org.currency || 'USD';
  document.getElementById('set-email').textContent  = currentProfile ? (currentProfile.id ? '(signed in)' : '—') : '—';
  document.getElementById('set-role').textContent   = ROLE_LABELS[currentProfile?.role] || currentProfile?.role || '—';
  document.getElementById('set-plan').textContent   = org.plan || 'free';
  document.getElementById('set-plan-badge').textContent = (org.plan || 'free').charAt(0).toUpperCase() + (org.plan || 'free').slice(1);
  document.getElementById('qr-reset-code').textContent = org.qr_reset_code || '—';
  const link = `${window.location.origin}/qr/register/?org=${org.slug}`;
  document.getElementById('qr-link-display2').textContent = link;
  const buildEl = document.getElementById('set-build');
  if (buildEl) buildEl.textContent = APP_BUILD;

  // Org settings are editable by full-access roles only
  const canEditOrg = isOrgAdmin() || pageAccess('page-settings') === 'write';
  document.getElementById('save-org-btn').style.display = canEditOrg ? '' : 'none';
  ['set-org-name','set-org-sub','set-org-denom','set-org-currency'].forEach(id => {
    document.getElementById(id).disabled = !canEditOrg;
  });

  // Team & roles — admins/owners only
  if (isOrgAdmin()) {
    document.getElementById('team-section').style.display = '';
    loadTeam();
  } else {
    document.getElementById('team-section').style.display = 'none';
  }

  // Configurable lists (coordinating groups) — anyone who can edit org settings
  document.getElementById('lists-section').style.display = canEditOrg ? '' : 'none';
  if (canEditOrg) loadLists();

  // SMS config — anyone who can write comms
  const canSms = canWritePage('page-comms');
  document.getElementById('sms-section').style.display = canSms ? '' : 'none';
  if (canSms) loadSmsSettings();
}

async function loadSmsSettings() {
  const { data, error } = await db.sms.settings(ORG_ID);
  if (error) { document.getElementById('sms-status').textContent = error.message; return; }
  document.getElementById('sms-sender').value    = data?.sender_id || 'ChurchOS';
  document.getElementById('sms-enabled').checked  = !!data?.enabled;
  document.getElementById('sms-on-giving').checked = !!data?.send_on_giving;
  document.getElementById('sms-status').innerHTML = data?.configured
    ? '<span style="color:var(--green);font-weight:600;">API key configured ✓</span>'
    : '<span style="color:var(--red);">No API key set — contact support</span>';
}

function loadLists() {
  const container = document.getElementById('lists-container');
  container.innerHTML = Object.entries(CONFIG_LISTS).map(([key, def]) => `
    <div style="margin-bottom:1.25rem;">
      <h4 style="margin:0 0 .5rem;font-size:.9rem;">${def.label}</h4>
      <div id="lst-${key}" style="display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:.6rem;"></div>
      <form data-key="${key}" class="lst-add-form" style="display:flex;gap:.5rem;flex-wrap:wrap;">
        <input type="text" class="form-control lst-new" placeholder="Add an option…" style="flex:1;min-width:160px;"/>
        <button type="submit" class="btn btn-outline btn-sm" style="min-height:40px;">Add</button>
      </form>
    </div>`).join('');
  Object.keys(CONFIG_LISTS).forEach(renderListChips);
  container.querySelectorAll('.lst-add-form').forEach(form => {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const key = form.dataset.key;
      const input = form.querySelector('.lst-new');
      const val = input.value.trim();
      if (!val) return;
      const items = listValues(key).slice();
      if (items.some(x => x.toLowerCase() === val.toLowerCase())) { toast('Already in the list', 'error'); return; }
      items.push(val);
      await saveList(key, items);
      input.value = '';
    });
  });
}

function renderListChips(key) {
  const box = document.getElementById('lst-' + key);
  if (!box) return;
  const opt = key === 'newcomer_lessons' ? optionalLessons() : [];
  box.innerHTML = listValues(key).map(v => {
    const esc = v.replace(/'/g, "\\'");
    const isOpt = opt.includes(v);
    const optToggle = key === 'newcomer_lessons'
      ? `<button onclick="toggleOptionalLesson('${esc}')" title="Toggle optional" style="background:${isOpt?'rgba(184,150,74,.18)':'none'};border:1px solid var(--border);color:${isOpt?'var(--gold-dark)':'var(--ink3)'};border-radius:6px;cursor:pointer;font-size:.66rem;padding:0 .35rem;">${isOpt?'optional':'required'}</button>`
      : '';
    return `<span class="role-pill" style="display:inline-flex;align-items:center;gap:.4rem;">${v}${optToggle}
       <button onclick="removeListItem('${key}','${esc}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.9rem;line-height:1;">✕</button>
     </span>`;
  }).join('');
}

async function saveList(key, items) {
  const lists = { ...((currentOrg.settings || {}).lists || {}), [key]: items };
  const settings = { ...(currentOrg.settings || {}), lists };
  const { error } = await db.org.update(currentOrg.id, { settings });
  if (error) { toast(error.message, 'error'); return; }
  currentOrg.settings = settings;        // keep local copy in sync
  toast('Saved', 'success');
  renderListChips(key);
  populateAllConfigTargets();            // refresh the live dropdowns
}

window.removeListItem = async (key, value) => {
  await saveList(key, listValues(key).filter(v => v !== value));
};

let teamInit = false;
async function loadTeam() {
  // One-time: populate invite role select + wire the invite form
  if (!teamInit) {
    teamInit = true;
    document.getElementById('inv-role').innerHTML =
      ASSIGNABLE_ROLES.map(r => `<option value="${r}">${ROLE_LABELS[r]}</option>`).join('');
    document.getElementById('invite-form').addEventListener('submit', async e => {
      e.preventDefault();
      const email = document.getElementById('inv-email').value.trim().toLowerCase();
      const role  = document.getElementById('inv-role').value;
      if (!email) return;
      const { error } = await db.team.invite(ORG_ID, email, role);
      if (error) {
        toast(error.code === '23505' ? 'That email is already invited' : error.message, 'error');
        return;
      }
      toast('Invite added', 'success');
      document.getElementById('inv-email').value = '';
      loadInvites();
    });
  }
  loadInvites();

  const { data, error } = await db.team.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  const tbody = document.getElementById('team-tbody');
  tbody.innerHTML = (data || []).map(u => {
    const name = `${u.first_name || ''} ${u.last_name || ''}`.trim() || '(no name)';
    const isSelf = u.id === currentProfile.id;
    const isOwner = u.role === 'owner';
    // Owners can't be re-roled here; you can't change your own role
    const locked = isOwner || isSelf;
    const opts = ASSIGNABLE_ROLES.map(r =>
      `<option value="${r}"${u.role === r ? ' selected' : ''}>${ROLE_LABELS[r]}</option>`).join('');
    const cell = locked
      ? `<span class="role-pill">${ROLE_LABELS[u.role] || u.role}${isSelf ? ' · you' : ''}</span>`
      : `<select class="form-control" style="min-height:34px;font-size:.8rem;padding:.2rem .5rem;width:auto;" onchange="assignRole('${u.id}', this.value)">${opts}</select>`;
    return `<tr><td class="td-name">${name}</td><td class="text-sm text-muted">${isSelf ? '(you)' : ''}</td><td>${cell}</td></tr>`;
  }).join('');
}

window.assignRole = async (userId, role) => {
  const { error } = await db.team.setRole(userId, role);
  if (error) { toast(error.message, 'error'); loadTeam(); return; }
  toast('Role updated', 'success');
};

async function loadInvites() {
  const { data, error } = await db.team.invites(ORG_ID);
  const box = document.getElementById('invite-list');
  if (error) { box.innerHTML = ''; return; }
  if (!data?.length) { box.innerHTML = '<p class="text-xs text-muted" style="margin:0;">No pending invites.</p>'; return; }
  box.innerHTML = '<div class="text-xs text-muted" style="margin-bottom:.35rem;">Pending invites</div>' +
    data.map(i => `
      <div style="display:flex;align-items:center;gap:.5rem;padding:.35rem 0;border-bottom:1px solid var(--border);">
        <span style="flex:1;font-size:.84rem;">${i.email}</span>
        <span class="role-pill">${ROLE_LABELS[i.role] || i.role}</span>
        <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="revokeInvite('${i.id}')">Revoke</button>
      </div>`).join('');
}

window.revokeInvite = async (id) => {
  const { error } = await db.team.revokeInvite(id);
  if (error) { toast(error.message, 'error'); return; }
  toast('Invite revoked', 'success');
  loadInvites();
};

async function saveOrgSettings() {
  const btn = document.getElementById('save-org-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const { error } = await db.org.update(currentOrg.id, {
    name:        document.getElementById('set-org-name').value.trim(),
    sub_name:    document.getElementById('set-org-sub').value.trim() || null,
    denomination:document.getElementById('set-org-denom').value.trim() || null,
    currency:    document.getElementById('set-org-currency').value,
  });
  btn.disabled = false; btn.textContent = 'Save Changes';
  if (error) { toast(error.message, 'error'); return; }
  toast('Settings saved', 'success');
  document.getElementById('brand-name').textContent = document.getElementById('set-org-name').value;
}

// ─── FORM HANDLERS ────────────────────────────────────────────────────────────
function initFormHandlers() {
  // Member form
  document.getElementById('member-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('mf-id').value;
    const data = {
      org_id: ORG_ID,
      first_name:    document.getElementById('mf-first').value.trim(),
      last_name:     document.getElementById('mf-last').value.trim(),
      phone:         document.getElementById('mf-phone').value.trim() || null,
      phone2:        document.getElementById('mf-phone2').value.trim() || null,
      email:         document.getElementById('mf-email').value.trim() || null,
      membership_no: document.getElementById('mf-mno').value.trim() || null,
      gender:        document.getElementById('mf-gender').value || null,
      role:          document.getElementById('mf-role').value.trim() || 'General',
      group_name:    document.getElementById('mf-group').value.trim() || null,
      date_of_birth:      document.getElementById('mf-dob').value || null,
      date_joined:        document.getElementById('mf-joined').value || null,
      notes:              document.getElementById('mf-notes').value.trim() || null,
      other_names:        document.getElementById('mf-other').value.trim() || null,
      marital_status:     document.getElementById('mf-marital').value || null,
      residence:          document.getElementById('mf-residence').value.trim() || null,
      detailed_residence: document.getElementById('mf-detail').value.trim() || null,
      member_confirmed:   document.getElementById('mf-verified').checked,
      confirmed_at:       document.getElementById('mf-verified').checked ? new Date().toISOString() : null,
      occupation:         document.getElementById('mf-occupation').value.trim() || null,
      employer:           document.getElementById('mf-employer').value.trim() || null,
      employment_type:    document.getElementById('mf-emp-type').value || null,
      baptised:           document.getElementById('mf-baptised').checked,
      baptism_date:       document.getElementById('mf-baptism-date').value || null,
      baptism_place:      document.getElementById('mf-baptism-place').value.trim() || null,
      confirmed:          document.getElementById('mf-confirmed').checked,
      confirmation_date:  document.getElementById('mf-confirm-date').value || null,
      confirmation_place: document.getElementById('mf-confirm-place').value.trim() || null,
    };
    const btn = document.getElementById('mf-submit');
    btn.disabled = true;
    const { error } = id ? await db.members.update(id, data) : await db.members.insert(data);
    btn.disabled = false;
    if (error) { toast(error.message, 'error'); return; }
    toast(id ? 'Member updated' : 'Member added', 'success');
    closeModal('modal-member');
    await prefetchMembers();
    loaded.delete('page-members');
    loadMembers();
  });

  // Attendance form
  document.getElementById('att-form').addEventListener('submit', async e => {
    e.preventDefault();
    const memberId   = document.getElementById('af-member-id').value;
    const memberName = document.getElementById('af-member-name').value;
    const date = document.getElementById('att-date').value;
    const type = document.getElementById('att-type').value;
    const data = {
      org_id: ORG_ID,
      service_date: date,
      service_type: type,
      check_in_method: 'manual',
      notes: document.getElementById('af-notes').value || null,
      group_name: document.getElementById('af-group').value || null,
    };
    if (memberId) {
      data.member_id = memberId;
    } else {
      data.guest_name = memberName;
      data.guest_role = document.getElementById('af-guest-role').value || null;
    }
    let res, error;
    try { res = await db.attendance.insert(data); } catch (err) { error = err; }
    if (error) { toast(error.message, 'error'); return; }
    closeModal('modal-att');
    document.getElementById('att-form').reset();
    document.getElementById('af-member-id').value = '';

    if (res?.queued && res.data) {
      // Offline: realtime won't fire — add the row locally so the steward sees it.
      const row = res.data;
      if (row.member_id) {
        const m = allMembers.find(x => x.id === row.member_id);
        if (m) row.members = { first_name: m.first_name, last_name: m.last_name, role: m.role };
      }
      if (document.getElementById('att-date').value === row.service_date &&
          document.getElementById('att-type').value === row.service_type) {
        attData.unshift(row); renderAttendance();
      }
      toast('Attendance saved offline — will sync', 'success');
    } else {
      toast('Attendance recorded', 'success');
    }
  });

  // Online attendance form
  document.getElementById('online-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('onf-id').value;
    const data = {
      org_id:       ORG_ID,
      service_date: document.getElementById('att-date').value,
      service_type: document.getElementById('att-type').value,
      channel:      document.getElementById('onf-channel').value.trim(),
      count:        parseInt(document.getElementById('onf-count').value, 10) || 0,
      notes:        document.getElementById('onf-notes').value.trim() || null,
    };
    const { error } = id ? await db.online.update(id, data) : await db.online.insert(data);
    if (error) {
      toast(error.code === '23505' ? 'That channel is already recorded for this service' : error.message, 'error');
      return;
    }
    toast('Online attendance saved', 'success');
    closeModal('modal-online');
    await fetchOnline();
  });

  // Giving form
  document.getElementById('giving-form').addEventListener('submit', async e => {
    e.preventDefault();
    const memberId   = document.getElementById('gf-member-id').value;
    const memberName = document.getElementById('gf-member-name').value;
    const editId     = document.getElementById('gf-member-id').dataset.editId || '';
    const data = {
      org_id:         ORG_ID,
      member_id:      memberId || null,
      member_name:    memberId ? memberName : (memberName || null),
      amount:         parseFloat(document.getElementById('gf-amount').value),
      currency:       CURRENCY,
      category:       document.getElementById('gf-cat').value,
      payment_method: document.getElementById('gf-method').value,
      given_date:     document.getElementById('gf-date').value,
      notes:          document.getElementById('gf-notes').value || null,
    };
    let saved, queued, error;
    try {
      const res = editId ? await db.giving.update(editId, data) : await db.giving.insert(data);
      saved = res.data; queued = res.queued;
    } catch (err) { error = err; }
    if (error) { toast(error.message, 'error'); return; }
    delete document.getElementById('gf-member-id').dataset.editId;
    closeModal('modal-giving');

    if (queued) {
      // Offline: the write is queued. Show it locally + print the receipt now;
      // it syncs to Supabase on reconnect.
      toast(editId ? 'Update saved offline — will sync' : 'Gift saved offline — will sync', 'success');
      if (!editId && saved) { givingData.unshift(saved); renderGiving(); showGivingReceipt(saved.id); }
      return;
    }

    toast(editId ? 'Gift updated' : 'Gift recorded', 'success');
    givingData = [];
    loaded.delete('page-giving');
    await fetchGiving();
    // Auto-show printable receipt for new entries
    if (!editId && saved?.id && givingData.some(g => g.id === saved.id)) {
      showGivingReceipt(saved.id);
    }
  });

  // Group form
  document.getElementById('group-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id   = document.getElementById('grf-id').value;
    const days = [...document.querySelectorAll('#day-checkboxes input:checked')].map(c => Number(c.value));
    const data = { org_id: ORG_ID, name: document.getElementById('grf-name').value.trim(), description: document.getElementById('grf-desc').value.trim() || null, meeting_days: days };
    const { error } = id ? await db.groups.update(id, data) : await db.groups.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast(id ? 'Group updated' : 'Group created', 'success');
    closeModal('modal-group');
    groupsData = [];
    loaded.delete('page-groups');
    await loadGroups();
  });

  // Volunteer form
  document.getElementById('volunteer-form').addEventListener('submit', async e => {
    e.preventDefault();
    const data = {
      org_id:     ORG_ID,
      member_id:  document.getElementById('volf-member-id').value || null,
      department: document.getElementById('volf-dept').value.trim(),
      role:       document.getElementById('volf-role').value.trim() || null,
      joined_date:document.getElementById('volf-date').value || today(),
    };
    const { error } = await db.volunteers.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Volunteer added', 'success');
    closeModal('modal-volunteer');
    loaded.delete('page-volunteers');
    await loadVolunteers();
  });

  // Visitor form
  document.getElementById('visitor-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('visf-id').value;
    const data = {
      org_id:         ORG_ID,
      first_name:     document.getElementById('visf-first').value.trim(),
      last_name:      document.getElementById('visf-last').value.trim() || null,
      phone:          document.getElementById('visf-phone').value.trim() || null,
      visit_date:     document.getElementById('visf-date').value,
      gender:         document.getElementById('visf-gender').value || null,
      age:            intOrNull('visf-age'),
      purpose:        document.getElementById('visf-purpose').value,
      status:         document.getElementById('visf-status').value,
      already_member: document.getElementById('visf-already').checked,
      followed_up:    document.getElementById('visf-followed').checked,
      how_heard:      document.getElementById('visf-how').value.trim() || null,
      notes:          document.getElementById('visf-notes').value.trim() || null,
    };
    const { error } = id ? await db.visitors.update(id, data) : await db.visitors.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Visitor saved', 'success');
    closeModal('modal-visitor');
    loaded.delete('page-visitors'); loadVisitors();
  });

  // Welfare form
  document.getElementById('welfare-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('wff-id').value;
    const memberName = document.getElementById('wff-member-name').value;
    const data = {
      org_id:      ORG_ID,
      member_id:   document.getElementById('wff-member-id').value || null,
      member_name: memberName || null,
      type:        document.getElementById('wff-type').value,
      description: document.getElementById('wff-desc').value || null,
      amount:      parseFloat(document.getElementById('wff-amount').value) || null,
      currency:    CURRENCY,
      welfare_date:document.getElementById('wff-date').value,
      status:      document.getElementById('wff-status').value,
    };
    const { error } = id ? await db.welfare.update(id, data) : await db.welfare.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Welfare case saved', 'success');
    closeModal('modal-welfare');
    await fetchWelfare();
  });

  // Education form
  document.getElementById('education-form').addEventListener('submit', async e => {
    e.preventDefault();
    const memberName = document.getElementById('eduf-member-name').value;
    const data = {
      org_id:     ORG_ID,
      member_id:  document.getElementById('eduf-member-id').value || null,
      member_name:memberName || null,
      program:    document.getElementById('eduf-prog').value.trim(),
      institution:document.getElementById('eduf-inst').value.trim() || null,
      year:       document.getElementById('eduf-year').value.trim() || null,
      status:     document.getElementById('eduf-status').value,
    };
    const { error } = await db.education.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Education record added', 'success');
    closeModal('modal-education');
    loaded.delete('page-education');
    await loadEducation();
  });

  // Mission form
  document.getElementById('mission-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('misf-id').value;
    const data = {
      org_id:             ORG_ID,
      title:              document.getElementById('misf-title').value.trim(),
      coordinating_group: document.getElementById('misf-group').value || null,
      location:           document.getElementById('misf-loc').value.trim() || null,
      start_date:         document.getElementById('misf-start').value || null,
      end_date:           document.getElementById('misf-end').value || null,
      participants:       intOrNull('misf-participants'),
      persons_reached:    intOrNull('misf-reached'),
      souls_won:          intOrNull('misf-souls'),
      budget:             parseFloat(document.getElementById('misf-budget').value) || null,
      currency:           CURRENCY,
      status:             document.getElementById('misf-status').value,
      notes:              document.getElementById('misf-notes').value || null,
    };
    const { error } = id ? await db.missions.update(id, data) : await db.missions.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Mission saved', 'success');
    closeModal('modal-mission');
    loaded.delete('page-missions');
    await loadMissions();
  });

  // Scholarship form
  document.getElementById('scholarship-form').addEventListener('submit', async e => {
    e.preventDefault();
    const memberName = document.getElementById('schf-member-name').value;
    const data = {
      org_id:        ORG_ID,
      member_id:     document.getElementById('schf-member-id').value || null,
      member_name:   memberName || null,
      institution:   document.getElementById('schf-inst').value.trim() || null,
      field_of_study:document.getElementById('schf-field').value.trim() || null,
      academic_year: document.getElementById('schf-year').value.trim() || null,
      amount:        parseFloat(document.getElementById('schf-amount').value) || null,
      currency:      CURRENCY,
      status:        document.getElementById('schf-status').value,
    };
    const { error } = await db.scholarships.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Scholarship added', 'success');
    closeModal('modal-scholarship');
    loaded.delete('page-scholarship');
    await loadScholarship();
  });

  // Family life form
  document.getElementById('family-form').addEventListener('submit', async e => {
    e.preventDefault();
    const memberName = document.getElementById('flf-member-name').value;
    const data = {
      org_id:      ORG_ID,
      type:        document.getElementById('flf-type').value,
      event_date:  document.getElementById('flf-date').value,
      member_id:   document.getElementById('flf-member-id').value || null,
      member_name: memberName || null,
      description: document.getElementById('flf-desc').value || null,
      notes:       document.getElementById('flf-notes').value || null,
    };
    const { error } = await db.familyLife.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Record added', 'success');
    closeModal('modal-family');
    await fetchFamily();
  });

  // Event form
  document.getElementById('event-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('evtf-id').value;
    const data = {
      org_id:     ORG_ID,
      title:      document.getElementById('evtf-title').value.trim(),
      event_type: document.getElementById('evtf-type').value,
      location:   document.getElementById('evtf-loc').value.trim() || null,
      start_date: document.getElementById('evtf-start').value,
      end_date:   document.getElementById('evtf-end').value || null,
      num_participants: document.getElementById('evtf-participants').value !== ''
        ? parseInt(document.getElementById('evtf-participants').value, 10) : null,
      description:document.getElementById('evtf-desc').value.trim() || null,
    };
    const { error } = id ? await db.events.update(id, data) : await db.events.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Event saved', 'success');
    closeModal('modal-event');
    await fetchEvents();
  });

  // Communications form
  document.getElementById('comms-form').addEventListener('submit', async e => {
    e.preventDefault();
    const audience = document.getElementById('cf-audience').value;
    const channel  = document.getElementById('cf-channel').value;
    const body     = document.getElementById('cf-body').value.trim();
    const data = {
      org_id:   ORG_ID,
      title:    document.getElementById('cf-title').value.trim(),
      body:     body || null,
      type:     channel === 'sms' ? 'sms' : document.getElementById('cf-type').value,
      audience,
      sent_at:  new Date().toISOString(),
    };

    // Send SMS first (needs network + config); only log the message if it sends.
    if (channel === 'sms') {
      if (!body) { toast('Enter a message body to send by SMS', 'error'); return; }
      if (!navigator.onLine) { toast('SMS needs an internet connection', 'error'); return; }
      const recipients = audienceRecipients(audience);
      if (!recipients.length) { toast('No members with a phone number in this audience', 'error'); return; }
      const { data: res, error: smsErr } = await db.sms.send(ORG_ID, recipients, body);
      if (smsErr) { toast(smsErr.message, 'error'); return; }
      toast(`SMS sent to ${res?.count ?? recipients.length} recipient(s)`, 'success');
    }

    const { error } = await db.communications.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    if (channel !== 'sms') toast('Message published', 'success');
    closeModal('modal-comms');
    await fetchComms();
  });

  // Expense form
  document.getElementById('expense-form').addEventListener('submit', async e => {
    e.preventDefault();
    const data = {
      org_id:       ORG_ID,
      title:        document.getElementById('expf-title').value.trim(),
      amount:       parseFloat(document.getElementById('expf-amount').value),
      currency:     CURRENCY,
      category:     document.getElementById('expf-cat').value,
      vendor:       document.getElementById('expf-vendor').value.trim() || null,
      expense_date: document.getElementById('expf-date').value,
      notes:        document.getElementById('expf-notes').value.trim() || null,
    };
    const { error } = await db.expenses.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Expense recorded', 'success');
    closeModal('modal-expense');
    await fetchExpenses();
  });

  // Transaction form
  document.getElementById('txn-form').addEventListener('submit', async e => {
    e.preventDefault();
    const data = {
      org_id:            ORG_ID,
      description:       document.getElementById('txnf-desc').value.trim(),
      debit_account_id:  document.getElementById('txnf-debit').value,
      credit_account_id: document.getElementById('txnf-credit').value,
      amount:            parseFloat(document.getElementById('txnf-amount').value),
      transaction_date:  document.getElementById('txnf-date').value,
      category:          document.getElementById('txnf-cat').value || null,
      reference_no:      document.getElementById('txnf-ref').value || null,
    };
    const { error } = await db.transactions.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Entry posted', 'success');
    closeModal('modal-txn');
    await loadLedger();
  });

  // Account form
  document.getElementById('account-form').addEventListener('submit', async e => {
    e.preventDefault();
    const data = {
      org_id:       ORG_ID,
      code:         document.getElementById('acctf-code').value.trim() || null,
      name:         document.getElementById('acctf-name').value.trim(),
      account_type: document.getElementById('acctf-type').value,
    };
    const { error } = await db.accounts.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Account added', 'success');
    closeModal('modal-account');
    await loadAccounts();
  });

  // Payroll form (Ghana model)
  document.getElementById('payroll-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id         = document.getElementById('prf-id').value;
    const memberName = document.getElementById('prf-name').value.trim() || document.getElementById('prf-member-name').value.trim();
    const basic      = parseFloat(document.getElementById('prf-basic').value) || 0;
    // Collect allowances
    const allowances = [...document.querySelectorAll('#prf-allowances-list .allowance-row')].map(row => ({
      name:   row.querySelector('.allow-name').value.trim() || 'Allowance',
      amount: parseFloat(row.querySelector('.allow-amount').value) || 0,
    }));
    const allowTotal = allowances.reduce((s,a) => s + a.amount, 0);
    const gross = basic + allowTotal;
    const ssnitEmp = +(basic * 0.055).toFixed(2);
    const ssnitEr  = +(basic * 0.13).toFixed(2);
    const tier2    = +(basic * 0.05).toFixed(2);
    const paye     = calcGhanaPAYE(gross - ssnitEmp);
    // Collect other deductions
    const otherDeductions = [...document.querySelectorAll('#prf-other-deductions-list .deduction-row')].map(row => ({
      name:   row.querySelector('.deduct-name').value.trim() || 'Deduction',
      amount: parseFloat(row.querySelector('.deduct-amount').value) || 0,
    }));
    const otherTotal   = otherDeductions.reduce((s,d) => s + d.amount, 0);
    const totalDeduct  = ssnitEmp + paye + otherTotal;
    const netSalary    = gross - totalDeduct;
    const data = {
      org_id:           ORG_ID,
      member_id:        document.getElementById('prf-member-id').value || null,
      member_name:      memberName,
      staff_role:       document.getElementById('prf-role').value.trim() || null,
      basic_salary:     basic,
      allowances,
      gross_salary:     +gross.toFixed(2),
      ssnit_employee:   ssnitEmp,
      ssnit_employer:   ssnitEr,
      tier2,
      paye,
      other_deductions: otherDeductions,
      total_deductions: +totalDeduct.toFixed(2),
      net_salary:       +netSalary.toFixed(2),
      bank_name:        document.getElementById('prf-bank-name').value.trim() || null,
      bank_branch:      document.getElementById('prf-bank-branch').value.trim() || null,
      bank_account_no:  document.getElementById('prf-bank-acct').value.trim() || null,
      bank_account_name:document.getElementById('prf-bank-acct-name').value.trim() || null,
      currency:         CURRENCY,
      pay_period:       document.getElementById('prf-period').value,
      payment_date:     document.getElementById('prf-payment-date').value || null,
      notes:            document.getElementById('prf-notes').value || null,
    };
    const { error } = id ? await db.payroll.update(id, data) : await db.payroll.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast(id ? 'Payroll updated' : 'Payroll entry added', 'success');
    closeModal('modal-payroll');
    await fetchPayroll();
  });
}

// ─── RECONCILIATION ──────────────────────────────────────────────────────────
let reconData = [], activeReconId = null, reconInit = false;

async function loadReconciliation() {
  document.getElementById('recon-add-btn').onclick = async () => {
    // Populate account select
    if (!accountsCache.length) await loadAccounts();
    const sel = document.getElementById('reconf-account');
    sel.innerHTML = '<option value="">Select account…</option>' +
      accountsCache.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
    document.getElementById('recon-form').reset();
    openModal('modal-recon');
  };
  document.getElementById('recon-back-btn').onclick = () => {
    document.getElementById('recon-list-view').style.display = '';
    document.getElementById('recon-detail-view').style.display = 'none';
    activeReconId = null;
    fetchReconciliations();
  };
  document.getElementById('recon-mark-done-btn').onclick = async () => {
    if (!activeReconId || !confirm('Mark reconciliation as complete?')) return;
    await db.reconciliations.update(activeReconId, { status: 'reconciled' });
    toast('Marked as reconciled', 'success');
    document.getElementById('recon-back-btn').click();
  };
  // Register form listeners only once
  if (!reconInit) {
    reconInit = true;
    document.getElementById('recon-form').addEventListener('submit', async e => {
      e.preventDefault();
      const data = {
        org_id:            ORG_ID,
        period:            document.getElementById('reconf-period').value,
        account_id:        document.getElementById('reconf-account').value || null,
        statement_balance: parseFloat(document.getElementById('reconf-stmt-bal').value),
        book_balance:      parseFloat(document.getElementById('reconf-book-bal').value),
        notes:             document.getElementById('reconf-notes').value || null,
      };
      const { error } = await db.reconciliations.insert(data);
      if (error) { toast(error.message, 'error'); return; }
      toast('Reconciliation created', 'success');
      closeModal('modal-recon');
      await fetchReconciliations();
    });
    document.getElementById('recon-item-form').addEventListener('submit', async e => {
      e.preventDefault();
      const data = {
        reconciliation_id: activeReconId,
        org_id:            ORG_ID,
        description:       document.getElementById('reconif-desc').value.trim(),
        amount:            parseFloat(document.getElementById('reconif-amount').value),
        item_date:         document.getElementById('reconif-date').value || null,
        item_type:         document.getElementById('reconif-type').value,
      };
      const { error } = await db.reconciliations.addItem(data);
      if (error) { toast(error.message, 'error'); return; }
      closeModal('modal-recon-item');
      await openReconDetail(activeReconId);
    });
  }
  await fetchReconciliations();
}

async function fetchReconciliations() {
  const tbody = document.getElementById('recon-tbody');
  const { data, error } = await db.reconciliations.list(ORG_ID);
  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="tbl-empty" style="color:var(--red);">
      Could not load reconciliations. If this is the first time, run migration <code>004_updates.sql</code> in Supabase.<br>(${error.message})</td></tr>`;
    return;
  }
  reconData = data || [];
  if (!reconData.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="tbl-empty">No reconciliations yet. Click <strong>+ New Reconciliation</strong> to start.</td></tr>`;
    return;
  }
  buildTable(document.getElementById('recon-tbody'), reconData, r => `
    <td>${r.period}</td>
    <td>${r.accounts?.name || '—'}</td>
    <td>${fmtMoney(r.statement_balance, CURRENCY)}</td>
    <td>${fmtMoney(r.book_balance, CURRENCY)}</td>
    <td style="color:${Math.abs(r.difference)<0.01?'var(--green)':'var(--red)'};">${fmtMoney(r.difference, CURRENCY)}</td>
    <td><span class="badge badge-${r.status==='reconciled'?'green':'gold'}">${r.status}</span></td>
    <td class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="openReconDetail('${r.id}')">Open</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteRecon('${r.id}')">Delete</button>
    </td>`);
}

window.openReconDetail = async (id) => {
  activeReconId = id;
  const { data, error } = await db.reconciliations.get(id);
  if (error) { toast(error.message, 'error'); return; }
  document.getElementById('recon-list-view').style.display = 'none';
  document.getElementById('recon-detail-view').style.display = '';
  document.getElementById('recon-detail-title').textContent = `${data.period} — ${data.accounts?.name || 'Account'}`;
  const diff = data.difference ?? (data.statement_balance - data.book_balance);
  const diffEl = document.getElementById('recon-detail-diff');
  diffEl.textContent = `Difference: ${fmtMoney(diff, CURRENCY)}`;
  diffEl.style.color = Math.abs(diff) < 0.01 ? 'var(--green)' : 'var(--red)';
  const items = data.reconciliation_items || [];
  const bookItems = items.filter(i => i.item_type === 'book');
  const stmtItems = items.filter(i => i.item_type === 'statement');
  const renderItems = (tbody, rows) => buildTable(document.getElementById(tbody), rows, i => `
    <td>${fmtDate(i.item_date)}</td>
    <td>${i.description}</td>
    <td>${fmtMoney(i.amount, CURRENCY)}</td>
    <td><input type="checkbox" ${i.cleared?'checked':''} onchange="toggleReconItem('${i.id}',this.checked)"/></td>
    <td><button class="btn btn-ghost btn-sm" style="color:var(--red);padding:.1rem .4rem;" onclick="deleteReconItem('${i.id}')">✕</button></td>`);
  renderItems('recon-book-tbody', bookItems);
  renderItems('recon-stmt-tbody', stmtItems);
};

window.addReconItem = (type) => {
  document.getElementById('recon-item-title').textContent = type === 'book' ? 'Add Book Item' : 'Add Statement Item';
  document.getElementById('reconif-type').value = type;
  document.getElementById('recon-item-form').reset();
  document.getElementById('reconif-type').value = type;
  openModal('modal-recon-item');
};

window.toggleReconItem = async (id, cleared) => {
  await db.reconciliations.updateItem(id, { cleared });
};

window.deleteReconItem = async (id) => {
  await db.reconciliations.deleteItem(id);
  await openReconDetail(activeReconId);
};

window.deleteRecon = async (id) => {
  if (!confirm('Delete this reconciliation?')) return;
  await db.reconciliations.delete(id);
  await fetchReconciliations();
};

// ─── CSV IMPORT ──────────────────────────────────────────────────────────────
let csvRows = [];

function initCSVImport() {
  const input = document.getElementById('member-csv-input');
  if (!input) return;
  input.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target.result;
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) { toast('CSV must have a header row and at least one data row', 'error'); return; }
      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g,'').toLowerCase());
      csvRows = lines.slice(1).map(line => {
        const vals = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g) || line.split(',');
        const row = {};
        headers.forEach((h, i) => { row[h] = (vals[i] || '').trim().replace(/^"|"$/g,''); });
        return row;
      }).filter(r => r.first_name);
      // Preview
      const head = document.getElementById('csv-preview-head');
      const tbody = document.getElementById('csv-preview-tbody');
      const displayCols = ['first_name','last_name','phone','email','membership_no','gender','role','group_name'];
      head.innerHTML = `<tr>${displayCols.map(c=>`<th>${c}</th>`).join('')}</tr>`;
      tbody.innerHTML = csvRows.slice(0,20).map(r =>
        `<tr>${displayCols.map(c=>`<td>${r[c]||'—'}</td>`).join('')}</tr>`
      ).join('');
      document.getElementById('csv-row-count').textContent =
        `${csvRows.length} rows found${csvRows.length>20?' (showing first 20)':''}`;
      openModal('modal-csv-preview');
    };
    reader.readAsText(file);
    input.value = '';
  });

  document.getElementById('csv-import-confirm-btn').addEventListener('click', async () => {
    if (!csvRows.length) return;
    const btn = document.getElementById('csv-import-confirm-btn');
    btn.disabled = true; btn.textContent = 'Importing…';
    let ok = 0, fail = 0;
    for (const row of csvRows) {
      const data = {
        org_id:       ORG_ID,
        first_name:   row.first_name,
        last_name:    row.last_name || '',
        phone:        row.phone || null,
        email:        row.email || null,
        membership_no:row.membership_no || null,
        gender:       ['Male','Female','Other'].includes(row.gender) ? row.gender : null,
        date_of_birth:row.date_of_birth || null,
        date_joined:  row.date_joined || null,
        role:         row.role || 'General',
        group_name:   row.group_name || null,
        notes:        row.notes || null,
      };
      const { error } = await db.members.insert(data);
      error ? fail++ : ok++;
    }
    btn.disabled = false; btn.textContent = 'Import All';
    toast(`Imported ${ok} members${fail?`, ${fail} failed`:''}`, ok>0?'success':'error');
    closeModal('modal-csv-preview');
    csvRows = [];
    await prefetchMembers();
    loaded.delete('page-members');
    if (document.getElementById('page-members').classList.contains('active')) loadMembers();
  });
}

// ─── START ────────────────────────────────────────────────────────────────────
async function bootExtras() {
  initCSVImport();
}

boot().then(bootExtras).catch(console.error);
