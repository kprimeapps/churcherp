// ChurchOS v2 — Main App Controller
import { supabase, db, syncQueue } from './db.js';
import { requireAuth, currentProfile, currentOrg, signOut } from './auth.js';
import {
  toast, openModal, closeModal, fmtDate, fmtMoney, fmtNum,
  initials, today, thisYear, thisMonth, debounce, buildTable,
  memberSelect, initOfflineBanner, navigate
} from './ui.js';

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

  // Sidebar navigation
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => {
      const pageId = item.dataset.page;
      const title  = item.dataset.title || '';
      navigate(pageId, title);
      activatePage(pageId);
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
      });
    }
  });

  // Mobile menu
  const menuBtn = document.getElementById('menu-toggle');
  const sidebar = document.getElementById('sidebar');
  if (window.innerWidth <= 768) { menuBtn.style.display = 'flex'; }
  menuBtn.addEventListener('click', () => sidebar.classList.toggle('open'));

  // Sign out
  document.getElementById('signout-btn').addEventListener('click', () => signOut());

  // Finance tabs
  document.querySelectorAll('.finance-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.finance-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ['ledger','budgets','payroll','accounts'].forEach(t => {
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
  initFormHandlers();
  initQRPage();
  initSettings();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  syncQueue();

  // Load the last active page or dashboard
  const lastPage = sessionStorage.getItem('churchos_page') || 'page-dashboard';
  navigate(lastPage, document.querySelector(`.nav-item[data-page="${lastPage}"]`)?.dataset.title || 'Dashboard');
  activatePage(lastPage);
}

// ─── PAGE ROUTER ──────────────────────────────────────────────────────────────
const loaded = new Set();
function activatePage(pageId) {
  if (loaded.has(pageId)) return; // data already loaded; realtime handles updates
  loaded.add(pageId);
  switch (pageId) {
    case 'page-dashboard':  loadDashboard(); break;
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
  const { data } = await db.members.list(ORG_ID, { active: true });
  allMembers = data || [];

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

  // Add button
  document.getElementById('member-add-btn').onclick = () => openMemberModal();

  // Member autocomplete for attendance
  memberSelect(document.getElementById('af-member-name'), allMembers, m => {
    document.getElementById('af-member-id').value = m.id;
    document.getElementById('af-guest-fields').style.display = 'none';
  });
  memberSelect(document.getElementById('gf-member-name'), allMembers, m => {
    document.getElementById('gf-member-id').value = m.id;
  });
  memberSelect(document.getElementById('volf-member-name'), allMembers, m => document.getElementById('volf-member-id').value = m.id);
  memberSelect(document.getElementById('wff-member-name'), allMembers, m => document.getElementById('wff-member-id').value = m.id);
  memberSelect(document.getElementById('eduf-member-name'), allMembers, m => document.getElementById('eduf-member-id').value = m.id);
  memberSelect(document.getElementById('schf-member-name'), allMembers, m => document.getElementById('schf-member-id').value = m.id);
  memberSelect(document.getElementById('flf-member-name'), allMembers, m => document.getElementById('flf-member-id').value = m.id);
  memberSelect(document.getElementById('prf-member-name'), allMembers, m => {
    document.getElementById('prf-member-id').value = m.id;
    document.getElementById('prf-name').value = `${m.first_name} ${m.last_name}`;
  });
}

function renderMembers() {
  const search = document.getElementById('members-search')?.value?.toLowerCase() || '';
  const group  = document.getElementById('members-group-filter')?.value || '';
  let rows = membersData;
  if (search) rows = rows.filter(m => `${m.first_name} ${m.last_name} ${m.phone||''} ${m.membership_no||''}`.toLowerCase().includes(search));
  if (group)  rows = rows.filter(m => m.group_name === group);

  buildTable(document.getElementById('members-tbody'), rows, m => `
    <td><div style="display:flex;align-items:center;gap:.6rem;">
      <div class="member-photo">${initials(m.first_name, m.last_name)}</div>
      <span class="td-name">${m.first_name} ${m.last_name}</span>
    </div></td>
    <td>${m.membership_no || '—'}</td>
    <td>${m.group_name ? `<span class="badge badge-gold">${m.group_name}</span>` : '—'}</td>
    <td>${m.role || '—'}</td>
    <td>${m.phone || '—'}</td>
    <td>${fmtDate(m.date_joined)}</td>
    <td class="td-actions">
      <button class="btn btn-ghost btn-sm" onclick="editMember('${m.id}')">Edit</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteMember('${m.id}')">Delete</button>
    </td>`);

  document.getElementById('member-count-bar').textContent = `Showing ${rows.length} of ${membersData.length} members`;
}

function openMemberModal(m = null) {
  document.getElementById('member-modal-title').textContent = m ? 'Edit Member' : 'Add Member';
  document.getElementById('mf-id').value       = m?.id || '';
  document.getElementById('mf-first').value    = m?.first_name || '';
  document.getElementById('mf-last').value     = m?.last_name || '';
  document.getElementById('mf-phone').value    = m?.phone || '';
  document.getElementById('mf-email').value    = m?.email || '';
  document.getElementById('mf-mno').value      = m?.membership_no || '';
  document.getElementById('mf-gender').value   = m?.gender || '';
  document.getElementById('mf-role').value     = m?.role || '';
  document.getElementById('mf-group').value    = m?.group_name || '';
  document.getElementById('mf-dob').value      = m?.date_of_birth || '';
  document.getElementById('mf-joined').value   = m?.date_joined || '';
  document.getElementById('mf-notes').value    = m?.notes || '';
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

  dateEl.addEventListener('change', () => { loaded.delete('page-attendance-data'); fetchAttendance(); });
  typeEl.addEventListener('change', () => { loaded.delete('page-attendance-data'); fetchAttendance(); });

  await fetchAttendance();
  subscribeAttendanceRealtime();
}

async function fetchAttendance() {
  const date = document.getElementById('att-date').value;
  const type = document.getElementById('att-type').value;
  document.getElementById('att-subtitle').textContent = `${type} — ${fmtDate(date)}`;

  const { data, error } = await db.attendance.forDate(ORG_ID, date, type);
  if (error) { toast(error.message, 'error'); return; }
  attData = data || [];
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
      <td class="td-name">${name}</td>
      <td>${role}</td>
      <td>${methodBadge}</td>
      <td class="text-sm text-muted">${new Date(r.created_at).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</td>
      <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteAtt('${r.id}')">✕</button></td>`;
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
  const { data, error } = await db.giving.list(ORG_ID, { year });
  if (error) { toast(error.message, 'error'); return; }
  givingData = data || [];
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
      <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteGiving('${r.id}')">Delete</button></td>`;
  });
}

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
let visData = [];
async function loadVisitors() {
  document.getElementById('vis-add-btn').onclick = () => {
    document.getElementById('visitor-form').reset();
    document.getElementById('visf-id').value = '';
    document.getElementById('visf-date').value = today();
    openModal('modal-visitor');
  };
  document.getElementById('vis-filter').addEventListener('change', fetchVisitors);
  await fetchVisitors();
}

async function fetchVisitors() {
  const fu = document.getElementById('vis-filter').value;
  const param = fu === '' ? null : fu === 'true';
  const { data, error } = await db.visitors.list(ORG_ID, param);
  if (error) { toast(error.message, 'error'); return; }
  visData = data || [];
  buildTable(document.getElementById('vis-tbody'), visData, v => `
    <td class="td-name">${v.first_name} ${v.last_name || ''}</td>
    <td>${v.phone || '—'}</td>
    <td>${fmtDate(v.visit_date)}</td>
    <td>${v.how_heard || '—'}</td>
    <td>${v.followed_up ? '<span class="badge badge-green">Done</span>' : '<span class="badge badge-gold">Pending</span>'}</td>
    <td class="td-actions">
      ${!v.followed_up ? `<button class="btn btn-ghost btn-sm" onclick="markFollowedUp('${v.id}')">✓ Follow up</button>` : ''}
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteVisitor('${v.id}')">Delete</button>
    </td>`);
}

window.markFollowedUp = async (id) => {
  const { error } = await db.visitors.update(id, { followed_up: true, follow_up_date: today() });
  if (error) { toast(error.message, 'error'); return; }
  toast('Marked as followed up', 'success');
  await fetchVisitors();
};

window.deleteVisitor = async (id) => {
  if (!confirm('Delete this visitor record?')) return;
  await db.visitors.delete(id);
  await fetchVisitors();
};

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
async function loadComms() {
  document.getElementById('comms-add-btn').onclick = () => {
    document.getElementById('comms-form').reset();
    document.getElementById('cf-id').value = '';
    openModal('modal-comms');
  };
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
async function loadEvents() {
  document.getElementById('evt-add-btn').onclick = () => {
    document.getElementById('event-form').reset();
    document.getElementById('evtf-id').value = '';
    openModal('modal-event');
  };
  document.getElementById('evt-type-filter').addEventListener('change', fetchEvents);
  await fetchEvents();
}

async function fetchEvents() {
  const { data, error } = await db.events.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  buildTable(document.getElementById('evt-tbody'), data || [], e => `
    <td class="td-name">${e.title}</td>
    <td><span class="badge badge-gold">${e.event_type}</span></td>
    <td>${fmtDate(e.start_date)}</td>
    <td>${e.location || '—'}</td>
    <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteEvt('${e.id}')">Delete</button></td>`);
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

// ─── MISSIONS ─────────────────────────────────────────────────────────────────
async function loadMissions() {
  document.getElementById('mis-add-btn').onclick = () => {
    document.getElementById('mission-form').reset();
    document.getElementById('misf-id').value = '';
    openModal('modal-mission');
  };
  const { data, error } = await db.missions.list(ORG_ID);
  if (error) { toast(error.message, 'error'); return; }
  buildTable(document.getElementById('mis-tbody'), data || [], m => `
    <td class="td-name">${m.title}</td>
    <td>${m.missionary_name || '—'}</td>
    <td>${m.location || '—'}</td>
    <td>${fmtDate(m.start_date)}</td>
    <td>${m.budget ? fmtMoney(m.budget, CURRENCY) : '—'}</td>
    <td><span class="badge badge-${m.status==='active'?'green':m.status==='completed'?'blue':'gray'}">${m.status}</span></td>
    <td class="td-actions"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteMis('${m.id}')">Delete</button></td>`);
}

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
    <td><span class="badge badge-${s.status==='active'?'green':s.status==='completed'?'blue':'gray'}">${s.status}</span></td>
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
    case 'budgets':  await loadBudgets();  break;
    case 'payroll':  await loadPayroll();  break;
    case 'accounts': await loadAccounts(); break;
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
        <button class="btn btn-outline btn-sm" onclick="viewBudgetLines('${b.id}')">View Lines</button>
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

window.viewBudgetLines = async (id) => {
  toast('Budget line editing: select the budget and manage lines here.', 'default');
};

async function loadPayroll() {
  const pe = document.getElementById('payroll-period');
  if (!pe.options.length) {
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      pe.innerHTML += `<option value="${val}">${val}</option>`;
    }
  }
  document.getElementById('payroll-add-btn').onclick = () => {
    document.getElementById('payroll-form').reset();
    document.getElementById('prf-id').value = '';
    document.getElementById('prf-period').value = pe.value;
    openModal('modal-payroll');
  };
  pe.addEventListener('change', fetchPayroll);
  await fetchPayroll();
}

async function fetchPayroll() {
  const period = document.getElementById('payroll-period').value;
  const { data, error } = await db.payroll.list(ORG_ID, period);
  if (error) { toast(error.message, 'error'); return; }
  buildTable(document.getElementById('payroll-tbody'), data || [], p => `
    <td class="td-name">${p.member_name}</td>
    <td>${p.staff_role || '—'}</td>
    <td>${fmtMoney(p.gross_amount, CURRENCY)}</td>
    <td style="color:var(--red);">${fmtMoney(p.deductions, CURRENCY)}</td>
    <td style="color:var(--green);font-weight:600;">${fmtMoney(p.net_amount, CURRENCY)}</td>
    <td>${p.pay_period}</td>
    <td><span class="badge badge-${p.status==='paid'?'green':'gold'}">${p.status}</span></td>
    <td class="td-actions">
      ${p.status!=='paid'?`<button class="btn btn-ghost btn-sm" onclick="markPayrollPaid('${p.id}')">Mark Paid</button>`:''}
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deletePayroll('${p.id}')">Delete</button>
    </td>`);
}

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
}

async function loadQRPage() {
  const [{ data: pending }, { data: todayQR }] = await Promise.all([
    db.qrRegs.list(ORG_ID, false),
    supabase.from('attendance').select('*').eq('org_id', ORG_ID).eq('service_date', today()).eq('check_in_method','qr').order('created_at', { ascending: false }),
  ]);

  document.getElementById('qr-pending-count').textContent = fmtNum(pending?.length || 0);
  document.getElementById('qr-today-count').textContent   = fmtNum(todayQR?.length || 0);

  buildTable(document.getElementById('qr-pending-tbody'), pending || [], r => `
    <td class="mono text-sm">${r.id}</td>
    <td class="td-name">${r.first_name} ${r.last_name || ''}</td>
    <td>${r.phone || '—'}</td>
    <td>${r.membership_no || '—'}</td>
    <td><span class="badge badge-gold">${r.role || '—'}</span></td>
    <td class="text-sm text-muted">${fmtDate(r.created_at)}</td>
    <td class="td-actions">
      <button class="btn btn-primary btn-sm" onclick="importQRReg('${r.id}')">Import to Members</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="dismissQRReg('${r.id}')">Dismiss</button>
    </td>`);

  buildTable(document.getElementById('qr-today-tbody'), todayQR || [], r => `
    <td class="td-name">${r.guest_name || '—'}</td>
    <td>${r.guest_role || '—'}</td>
    <td class="text-sm text-muted">${new Date(r.created_at).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</td>`);

  // Subscribe to live QR check-ins
  supabase.channel('qr-live')
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'attendance', filter:`org_id=eq.${ORG_ID}` }, p => {
      if (p.new.check_in_method === 'qr') loadQRPage();
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
  document.getElementById('set-role').textContent   = currentProfile?.role || '—';
  document.getElementById('set-plan').textContent   = org.plan || 'free';
  document.getElementById('set-plan-badge').textContent = (org.plan || 'free').charAt(0).toUpperCase() + (org.plan || 'free').slice(1);
  document.getElementById('qr-reset-code').textContent = org.qr_reset_code || '—';
  const link = `${window.location.origin}/qr/register/?org=${org.slug}`;
  document.getElementById('qr-link-display2').textContent = link;
}

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
      email:         document.getElementById('mf-email').value.trim() || null,
      membership_no: document.getElementById('mf-mno').value.trim() || null,
      gender:        document.getElementById('mf-gender').value || null,
      role:          document.getElementById('mf-role').value.trim() || 'General',
      group_name:    document.getElementById('mf-group').value.trim() || null,
      date_of_birth: document.getElementById('mf-dob').value || null,
      date_joined:   document.getElementById('mf-joined').value || null,
      notes:         document.getElementById('mf-notes').value.trim() || null,
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
    const { error } = await db.attendance.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Attendance recorded', 'success');
    closeModal('modal-att');
    document.getElementById('att-form').reset();
    document.getElementById('af-member-id').value = '';
  });

  // Giving form
  document.getElementById('giving-form').addEventListener('submit', async e => {
    e.preventDefault();
    const memberId   = document.getElementById('gf-member-id').value;
    const memberName = document.getElementById('gf-member-name').value;
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
    const { error } = await db.giving.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Gift recorded', 'success');
    closeModal('modal-giving');
    givingData = [];
    loaded.delete('page-giving');
    await fetchGiving();
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
      org_id:     ORG_ID,
      first_name: document.getElementById('visf-first').value.trim(),
      last_name:  document.getElementById('visf-last').value.trim() || null,
      phone:      document.getElementById('visf-phone').value.trim() || null,
      visit_date: document.getElementById('visf-date').value,
      how_heard:  document.getElementById('visf-how').value.trim() || null,
      notes:      document.getElementById('visf-notes').value.trim() || null,
    };
    const { error } = id ? await db.visitors.update(id, data) : await db.visitors.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Visitor saved', 'success');
    closeModal('modal-visitor');
    await fetchVisitors();
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
      org_id:          ORG_ID,
      title:           document.getElementById('misf-title').value.trim(),
      missionary_name: document.getElementById('misf-name').value.trim() || null,
      location:        document.getElementById('misf-loc').value.trim() || null,
      start_date:      document.getElementById('misf-start').value || null,
      end_date:        document.getElementById('misf-end').value || null,
      budget:          parseFloat(document.getElementById('misf-budget').value) || null,
      currency:        CURRENCY,
      status:          document.getElementById('misf-status').value,
      notes:           document.getElementById('misf-notes').value || null,
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
    const data = {
      org_id:   ORG_ID,
      title:    document.getElementById('cf-title').value.trim(),
      body:     document.getElementById('cf-body').value.trim() || null,
      type:     document.getElementById('cf-type').value,
      audience: document.getElementById('cf-audience').value,
      sent_at:  new Date().toISOString(),
    };
    const { error } = await db.communications.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Message published', 'success');
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

  // Payroll form
  document.getElementById('payroll-form').addEventListener('submit', async e => {
    e.preventDefault();
    const memberName = document.getElementById('prf-name').value.trim() || document.getElementById('prf-member-name').value.trim();
    const data = {
      org_id:      ORG_ID,
      member_id:   document.getElementById('prf-member-id').value || null,
      member_name: memberName,
      staff_role:  document.getElementById('prf-role').value.trim() || null,
      gross_amount:parseFloat(document.getElementById('prf-gross').value),
      deductions:  parseFloat(document.getElementById('prf-deduct').value) || 0,
      currency:    CURRENCY,
      pay_period:  document.getElementById('prf-period').value,
      notes:       document.getElementById('prf-notes').value || null,
    };
    const { error } = await db.payroll.insert(data);
    if (error) { toast(error.message, 'error'); return; }
    toast('Payroll entry added', 'success');
    closeModal('modal-payroll');
    await fetchPayroll();
  });
}

// ─── START ────────────────────────────────────────────────────────────────────
boot().catch(console.error);
