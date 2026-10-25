// Pulls new X bookmarks into `highlights`.
// Called weekly by pg_cron (x-cron-secret header -> every connected user) or by the app's "Sync now" (JWT -> that user).
import { admin, cors, json, syncUser, userFrom } from '../_shared/x.ts';

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const db = admin();
  const secret = Deno.env.get('CRON_SECRET');
  let query = db.from('x_connections').select('*');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    const user = await userFrom(req, db);
    if (!user) return json({ error: 'Not signed in' }, 401);
    query = query.eq('user_id', user.id);
  }
  const { data: conns, error } = await query;
  if (error) return json({ error: error.message }, 500);
  const results = [];
  for (const conn of conns ?? []) results.push(await syncUser(db, conn));
  return json({ results });
});
