// OAuth 2.0 (PKCE) connection to X.
//   POST (with the user's Supabase JWT) -> returns the X authorize URL
//   GET  (X redirects here)             -> exchanges the code, stores tokens, runs a first sync, returns to the app
import { admin, cors, json, syncUser, tokenRequest, userFrom } from '../_shared/x.ts';

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const redirectUri = () => `${Deno.env.get('SUPABASE_URL')}/functions/v1/x-connect`;
const appUrl = () => Deno.env.get('APP_URL') ?? 'https://marginalia-wheat-eight.vercel.app/';

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const db = admin();

  if (req.method === 'POST') {
    const user = await userFrom(req, db);
    if (!user) return json({ error: 'Not signed in' }, 401);
    const state = random(24), verifier = random(48);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    await db.from('x_oauth_states').delete().lt('created_at', new Date(Date.now() - 3600_000).toISOString());
    const { error } = await db.from('x_oauth_states').insert({ state, user_id: user.id, verifier });
    if (error) return json({ error: error.message }, 500);
    const url = new URL('https://x.com/i/oauth2/authorize');
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: Deno.env.get('X_CLIENT_ID')!,
      redirect_uri: redirectUri(),
      scope: 'tweet.read users.read bookmark.read offline.access',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return json({ url: url.toString() });
  }

  const params = new URL(req.url).searchParams;
  const back = (result: string) => Response.redirect(`${appUrl()}?x=${encodeURIComponent(result)}#settings`, 302);
  const state = params.get('state') ?? '';
  const { data: pending } = await db.from('x_oauth_states').delete().eq('state', state).select().maybeSingle();
  if (!pending) return back('expired');
  if (params.get('error') || !params.get('code')) return back('denied');

  try {
    const t = await tokenRequest({ grant_type: 'authorization_code', code: params.get('code')!, redirect_uri: redirectUri(), code_verifier: pending.verifier });
    const me = await (await fetch('https://api.x.com/2/users/me', { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    if (!me.data?.id) throw new Error(`Could not read X account: ${JSON.stringify(me).slice(0, 200)}`);
    const conn = {
      user_id: pending.user_id, x_user_id: me.data.id, x_username: me.data.username,
      access_token: t.access_token, refresh_token: t.refresh_token,
      expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
      last_sync_at: null, last_error: null,
    };
    const { error } = await db.from('x_connections').upsert(conn);
    if (error) throw error;
    // Backfill in the background so the user lands back in the app straight away.
    // @ts-ignore EdgeRuntime is provided by Supabase
    EdgeRuntime.waitUntil(syncUser(db, conn));
    return back('connected');
  } catch (e) {
    console.error(e);
    return back('failed');
  }
});
