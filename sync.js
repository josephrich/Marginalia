// Optional cloud sync via Supabase (plain REST, no SDK so the app stays dependency-free and offline-first).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const enabled = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

const ls = {
  get(k, d = null) { try { return JSON.parse(localStorage.getItem(`mg.sync.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { v == null ? localStorage.removeItem(`mg.sync.${k}`) : localStorage.setItem(`mg.sync.${k}`, JSON.stringify(v)); },
};

let session = ls.get('session');
export const user = () => session?.user ?? null;

function setSession(s) {
  session = s && s.access_token ? { ...s, expires_at: s.expires_at ?? Math.floor(Date.now() / 1000) + s.expires_in } : null;
  ls.set('session', session);
}

async function errorText(res) {
  const b = await res.json().catch(() => ({}));
  return b.msg || b.error_description || b.message || b.error || `HTTP ${res.status}`;
}

async function auth(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

async function fresh() {
  if (!session || session.expires_at * 1000 > Date.now() + 60_000) return;
  try { setSession(await auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token })); }
  catch (e) { if (navigator.onLine) setSession(null); throw e; }
}

async function api(path, opts = {}) {
  await fresh();
  if (!session) throw new Error('Not signed in');
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', ...opts.headers },
  });
  if (!res.ok) throw new Error(await errorText(res));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function signIn(email, password) {
  setSession(await auth('token?grant_type=password', { email, password }));
}

// Returns true if signed in straight away, false if Supabase wants the email confirmed first.
export async function signUp(email, password) {
  const r = await auth('signup', { email, password });
  if (r.access_token) { setSession(r); return true; }
  return false;
}

export function signOut() {
  setSession(null);
  ls.set('cursor', null);
  ls.set('pushedAt', null);
}

// Two-way sync. Pull first (server rows newer than ours win), then push local changes since the last push.
// `all` is the app's Map of every record (including deleted tombstones); `apply` writes pulled records locally.
export async function sync(all, apply) {
  if (!enabled || !session) return { pulled: 0, pushed: 0 };
  let pulled = 0, pushed = 0;

  // Re-read a few seconds of overlap so rows committed out of order aren't missed; applying twice is harmless.
  let cursor = ls.get('cursor');
  for (;;) {
    const since = cursor ? new Date(Date.parse(cursor) - 5000).toISOString() : '1970-01-01T00:00:00Z';
    const rows = await api(`/rest/v1/highlights?select=id,data,updated_at,deleted,synced_at&synced_at=gt.${encodeURIComponent(since)}&order=synced_at.asc&limit=1000`);
    const changed = [];
    for (const r of rows) {
      const local = all.get(r.id);
      if (!local || r.updated_at >= (local.updatedAt || 0)) {
        changed.push({ ...r.data, id: r.id, deleted: r.deleted, updatedAt: r.updated_at });
      }
    }
    if (changed.length) { await apply(changed); pulled += changed.length; }
    const last = rows.at(-1)?.synced_at;
    if (last && last !== cursor) cursor = last;
    ls.set('cursor', cursor);
    if (rows.length < 1000 || !last) break;
  }

  const pushedAt = ls.get('pushedAt', -1);
  const startedAt = Date.now();
  const dirty = [...all.values()].filter(h => (h.updatedAt || 0) > pushedAt);
  for (let i = 0; i < dirty.length; i += 500) {
    const batch = dirty.slice(i, i + 500).map(h => ({ id: h.id, data: h, updated_at: h.updatedAt || startedAt, deleted: !!h.deleted }));
    await api('/rest/v1/highlights?on_conflict=user_id,id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(batch),
    });
    pushed += batch.length;
  }
  ls.set('pushedAt', startedAt);
  return { pulled, pushed };
}

// ---------- X bookmarks ----------
export async function xStatus() {
  const rows = await api('/rest/v1/rpc/x_status', { method: 'POST', body: '{}' });
  return rows?.[0] ?? null;
}

export async function xConnect() {
  const { url } = await api('/functions/v1/x-connect', { method: 'POST', body: '{}' });
  location.href = url;
}

export const xSyncNow = () => api('/functions/v1/sync-x', { method: 'POST', body: '{}' });
export const xDisconnect = () => api('/rest/v1/rpc/x_disconnect', { method: 'POST', body: '{}' });
