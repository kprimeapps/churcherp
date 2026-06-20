// ChurchOS v2 — Auth module

import { supabase } from './db.js';

export let currentUser  = null;   // auth.users row
export let currentProfile = null; // profiles row
export let currentOrg   = null;   // organizations row

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export async function loadProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*, organizations(*)')
    .eq('id', userId)
    .single();
  if (error) throw error;
  currentProfile = data;
  currentOrg     = data.organizations;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signUp(email, password, meta = {}) {
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: meta },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await supabase.auth.signOut();
  currentUser = currentProfile = currentOrg = null;
  window.location.href = '/index.html';
}

export async function requireAuth(redirectTo = '/index.html') {
  const session = await getSession();
  if (!session) { window.location.href = redirectTo; return null; }
  currentUser = session.user;
  await loadProfile(session.user.id);
  return session;
}

// Kick user to login if session expires mid-session
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') window.location.href = '/index.html';
});

export function canWrite() {
  return currentProfile && ['owner','admin','staff'].includes(currentProfile.role);
}

export function isAdmin() {
  return currentProfile && ['owner','admin'].includes(currentProfile.role);
}
