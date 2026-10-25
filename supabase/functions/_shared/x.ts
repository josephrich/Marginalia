import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export const admin = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

export async function userFrom(req: Request, db: SupabaseClient) {
  const jwt = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  return data.user;
}

export async function tokenRequest(params: Record<string, string>) {
  const id = Deno.env.get('X_CLIENT_ID')!, secret = Deno.env.get('X_CLIENT_SECRET')!;
  const res = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${btoa(`${id}:${secret}`)}` },
    body: new URLSearchParams({ client_id: id, ...params }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`X token error ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body as { access_token: string; refresh_token: string; expires_in: number };
}

// Must match normText/hashId in importers.js so a tweet imported by the app and by the sync dedupe.
const normText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 500);
function hashId(str: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

type Url = { url: string; expanded_url?: string };
type Tweet = { id: string; text: string; author_id?: string; created_at?: string; entities?: { urls?: Url[] }; note_tweet?: { text: string; entities?: { urls?: Url[] } } };
type User = { id: string; name: string; username: string };

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

export function tweetToRow(userId: string, t: Tweet, u?: User) {
  let text = t.note_tweet?.text ?? t.text;
  // Expand t.co links; drop the ones that just point at attached media.
  for (const e of t.note_tweet?.entities?.urls ?? t.entities?.urls ?? []) {
    text = text.replace(e.url, /\/(photo|video)\/\d+$/.test(e.expanded_url ?? '') ? '' : (e.expanded_url ?? e.url));
  }
  text = decode(text).trim();
  if (!text) return null;
  const handle = u ? `@${u.username}` : '';
  const now = Date.now();
  const id = hashId(normText(text));
  const data = {
    id, text, source: 'twitter',
    title: `Tweets from ${handle || 'X'}`,
    author: u ? `${u.name} (${handle})` : '',
    url: `https://x.com/${u?.username ?? 'i'}/status/${t.id}`,
    note: '', location: null, page: null,
    highlightedAt: t.created_at ? Date.parse(t.created_at) : null,
    addedAt: now, updatedAt: now, favorite: false, discarded: false, lastSeen: null, seenCount: 0,
  };
  return { user_id: userId, id, data, updated_at: now, deleted: false };
}

type Conn = { user_id: string; x_user_id: string; access_token: string; refresh_token: string; expires_at: string; last_sync_at: string | null };

export async function syncUser(db: SupabaseClient, conn: Conn) {
  try {
    let token = conn.access_token;
    if (new Date(conn.expires_at).getTime() < Date.now() + 60_000) {
      const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: conn.refresh_token });
      token = t.access_token;
      // X rotates refresh tokens: the old one is dead now, so persist the new one before anything else.
      const { error } = await db.from('x_connections').update({
        access_token: t.access_token, refresh_token: t.refresh_token,
        expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
      }).eq('user_id', conn.user_id);
      if (error) throw error;
    }

    let added = 0, next: string | undefined, pageSize = 20;
    for (let page = 0; page < 60; page++) {
      const url = new URL(`https://api.x.com/2/users/${conn.x_user_id}/bookmarks`);
      url.search = new URLSearchParams({
        max_results: String(pageSize),
        'tweet.fields': 'created_at,note_tweet,entities,author_id',
        expansions: 'author_id',
        'user.fields': 'name,username',
        ...(next ? { pagination_token: next } : {}),
      }).toString();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      if (!res.ok) throw new Error(`X bookmarks error ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);

      const users = new Map<string, User>((body.includes?.users ?? []).map((u: User) => [u.id, u]));
      const rows = ((body.data ?? []) as Tweet[]).map(t => tweetToRow(conn.user_id, t, users.get(t.author_id ?? ''))).filter(r => r !== null);
      if (!rows.length) break;
      const { data: existing, error: selErr } = await db.from('highlights').select('id')
        .eq('user_id', conn.user_id).in('id', rows.map(r => r.id));
      if (selErr) throw selErr;
      const known = new Set((existing ?? []).map(e => e.id));
      const fresh = rows.filter(r => !known.has(r.id));
      if (fresh.length) {
        const { error } = await db.from('highlights').upsert(fresh, { onConflict: 'user_id,id', ignoreDuplicates: true });
        if (error) throw error;
        added += fresh.length;
      }
      next = body.meta?.next_token;
      // Bookmarks come newest first, and X bills per post returned. After the first full backfill,
      // stop as soon as we reach posts we already have.
      if (!next || (conn.last_sync_at && fresh.length < rows.length)) break;
      pageSize = 100;
    }
    await db.from('x_connections').update({ last_sync_at: new Date().toISOString(), last_sync_added: added, last_error: null }).eq('user_id', conn.user_id);
    return { user_id: conn.user_id, added };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from('x_connections').update({ last_error: message }).eq('user_id', conn.user_id);
    return { user_id: conn.user_id, error: message };
  }
}
