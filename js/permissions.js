// ChurchOS v2 — Role-Based Access Control
// Client-side gating of navigation, page access, and write actions.
// (Org-level isolation is enforced server-side by RLS; this layer controls
//  what each role can see/do within their organization.)
import { currentProfile } from './auth.js';

export const ALL_PAGES = [
  'page-dashboard','page-reports','page-members','page-attendance','page-groups','page-giving',
  'page-volunteers','page-visitors','page-family','page-comms','page-events',
  'page-welfare','page-education','page-missions','page-scholarship',
  'page-expenses','page-budget','page-qr','page-settings',
];

const FINANCE = ['page-giving','page-expenses','page-budget'];
const GENERAL = ['page-members','page-attendance','page-groups','page-volunteers',
                 'page-visitors','page-family','page-comms','page-events',
                 'page-welfare','page-education','page-missions','page-scholarship','page-qr'];

// Build a {page: 'read'|'write'} map from lists.
function mk(writePages = [], readPages = []) {
  const m = { 'page-dashboard': 'read', 'page-settings': 'read' };
  readPages.forEach(p => { m[p] = 'read'; });
  writePages.forEach(p => { m[p] = 'write'; });
  return m;
}

// '*' = full write on every page. Otherwise an explicit per-page map.
const ROLE_ACCESS = {
  owner:  '*',
  admin:  '*',          // Church Administrator
  pastor: '*',
  district_admin: '*', presbytery_admin: '*', national_admin: '*',

  // Generic staff: broad pastoral write, but no finance and no org settings edit.
  staff: mk(GENERAL, ['page-reports']),

  viewer: 'READ_ALL',

  finance_team:         mk(FINANCE, ['page-reports']),
  usher:                { 'page-attendance': 'write' },  // kiosk: attendance only
  missions_coordinator: mk(['page-missions','page-visitors']),
  education_coordinator:mk(['page-education','page-scholarship']),
  welfare_coordinator:  mk(['page-welfare']),
  counsellor:           mk(['page-family']),
};

// Friendly labels for the Settings → Team role picker.
export const ROLE_LABELS = {
  owner: 'Owner',
  admin: 'Church Administrator',
  pastor: 'Pastor',
  staff: 'Staff',
  viewer: 'Viewer (read-only)',
  finance_team: 'Finance Team',
  usher: 'Usher',
  missions_coordinator: 'Missions Coordinator',
  education_coordinator: 'Education Coordinator',
  welfare_coordinator: 'Welfare Coordinator',
  counsellor: 'Counsellor',
};
// Roles offered in the assignment dropdown (hierarchy roles managed elsewhere).
export const ASSIGNABLE_ROLES = [
  'admin','pastor','finance_team','usher','missions_coordinator',
  'education_coordinator','welfare_coordinator','counsellor','staff','viewer',
];

function role() { return currentProfile?.role || 'viewer'; }

// Returns 'write' | 'read' | null (no access) for a page.
export function pageAccess(pageId) {
  const acc = ROLE_ACCESS[role()];
  if (acc === '*') return 'write';
  if (acc === 'READ_ALL') return 'read';
  return (acc && acc[pageId]) || null;
}

export function canSee(pageId)       { return pageAccess(pageId) !== null; }
export function canWritePage(pageId) { return pageAccess(pageId) === 'write'; }
export function isOrgAdmin()         { return ['owner','admin'].includes(role()); }
export function isFullAccess()       { return ROLE_ACCESS[role()] === '*'; }

// Pages this role can see, in sidebar order.
export function visiblePages() { return ALL_PAGES.filter(canSee); }
// Where to land after login (first visible page).
export function landingPage()  { return visiblePages()[0] || 'page-dashboard'; }
// Single-page roles (e.g. Usher) get a stripped-down, nav-less kiosk view.
export function isKiosk()      { return visiblePages().length <= 1; }
