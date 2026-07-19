// ChurchOS v2 — UI helpers

// ─── TOAST ───────────────────────────────────────────────────────────────────
export function toast(msg, type = 'default', duration = 3500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ─── MODAL ───────────────────────────────────────────────────────────────────
export function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}
export function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}
export function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
}

// Close modals when clicking overlay background
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) e.target.classList.add('hidden');
});

// ─── CONFIRM ─────────────────────────────────────────────────────────────────
export function confirm(msg) {
  return window.confirm(msg);
}

// ─── FORMAT HELPERS ──────────────────────────────────────────────────────────
export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtMoney(amount, currency = 'USD') {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(amount);
}

export function fmtNum(n) {
  if (n == null) return '0';
  return new Intl.NumberFormat('en-US').format(n);
}

export function initials(first = '', last = '') {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase() || '?';
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function thisYear() {
  return String(new Date().getFullYear());
}

export function dayNames() {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
}

// ─── TABS ────────────────────────────────────────────────────────────────────
export function initTabs(containerSel) {
  const container = typeof containerSel === 'string'
    ? document.querySelector(containerSel) : containerSel;
  if (!container) return;
  container.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      container.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'));
      container.querySelectorAll('[data-panel]').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = container.querySelector(`[data-panel="${target}"]`);
      if (panel) panel.classList.add('active');
    });
  });
}

// ─── SEARCH DEBOUNCE ─────────────────────────────────────────────────────────
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ─── TABLE ROW BUILDER ───────────────────────────────────────────────────────
export function buildTable(tbody, rows, colFn, emptyMsg = 'No records found') {
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="99" class="tbl-empty">${emptyMsg}</td></tr>`;
    return;
  }
  // Column headers → used as mobile card labels (data-label on each cell)
  const headers = [...(tbody.closest('table')?.querySelectorAll('thead th') || [])]
    .map(th => th.textContent.trim());
  rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = colFn(row);
    if (headers.length) [...tr.children].forEach((td, i) => {
      if (headers[i]) td.setAttribute('data-label', headers[i]);
    });
    tbody.appendChild(tr);
  });
}

// ─── MEMBER SEARCH AUTOCOMPLETE ──────────────────────────────────────────────
export function memberSelect(inputEl, members, onSelect, limit = 40) {
  let dropdown = null;
  // `members` may be an array OR a function returning the current array, so the
  // list is resolved live at input time (callers reassign their cache after fetch).
  const getMembers = () => (typeof members === 'function' ? members() : members) || [];

  inputEl.addEventListener('input', () => {
    const val = inputEl.value.toLowerCase();
    if (dropdown) dropdown.remove();
    if (!val || val.length < 2) return;

    // Every token must match somewhere (name / membership # / phone), so
    // "nana osae" and phone numbers both resolve.
    const toks = val.split(/\s+/).filter(Boolean);
    const matches = getMembers().filter(m => {
      const hay = `${m.first_name || ''} ${m.last_name || ''} ${m.membership_no || ''} ${m.phone || ''} ${m.phone2 || ''}`.toLowerCase();
      return toks.every(t => hay.includes(t));
    }).slice(0, limit);

    if (!matches.length) return;

    dropdown = document.createElement('ul');
    dropdown.className = 'member-dropdown';
    dropdown.style.cssText = `position:absolute;background:#fff;border:1.5px solid var(--cream3);
      border-radius:var(--r);box-shadow:var(--shadow-md);list-style:none;z-index:300;
      min-width:240px;max-height:220px;overflow-y:auto;margin-top:2px;`;
    matches.forEach(m => {
      const li = document.createElement('li');
      li.style.cssText = 'padding:.55rem .85rem;cursor:pointer;font-size:.84rem;';
      li.textContent = `${m.first_name} ${m.last_name}${m.membership_no ? ' · ' + m.membership_no : ''}`;
      li.addEventListener('mousedown', e => {
        e.preventDefault();
        inputEl.value = `${m.first_name} ${m.last_name}`;
        dropdown.remove(); dropdown = null;
        onSelect(m);
      });
      li.addEventListener('mouseover', () => li.style.background = 'var(--cream2)');
      li.addEventListener('mouseout',  () => li.style.background = '');
      dropdown.appendChild(li);
    });
    const rect = inputEl.getBoundingClientRect();
    dropdown.style.top  = (rect.bottom + window.scrollY) + 'px';
    dropdown.style.left = (rect.left + window.scrollX) + 'px';
    document.body.appendChild(dropdown);
  });

  document.addEventListener('click', e => {
    if (dropdown && !dropdown.contains(e.target) && e.target !== inputEl) {
      dropdown.remove(); dropdown = null;
    }
  });
}

// ─── OFFLINE BANNER ──────────────────────────────────────────────────────────
export function initOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  const update = () => {
    banner.classList.toggle('show', !navigator.onLine);
    const dot = document.getElementById('status-dot');
    if (dot) dot.className = 'topbar-badge' + (navigator.onLine ? '' : ' offline');
    const statusText = document.getElementById('status-text');
    if (statusText) statusText.textContent = navigator.onLine ? 'Online' : 'Offline';
  };
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
}

// ─── NAV ─────────────────────────────────────────────────────────────────────
export function navigate(pageId, titleText) {
  document.querySelectorAll('.erp-page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(pageId);
  if (page) page.classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll(`.nav-item[data-page="${pageId}"]`).forEach(n => n.classList.add('active'));

  const titleEl = document.getElementById('topbar-title');
  if (titleEl && titleText) titleEl.textContent = titleText;

  sessionStorage.setItem('churchos_page', pageId);
  window.dispatchEvent(new CustomEvent('churchos:navigate', { detail: { pageId } }));
}
