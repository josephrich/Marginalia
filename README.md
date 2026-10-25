# Marginalia

A free, self-hosted Readwise replacement: a PWA that resurfaces your Kindle highlights and X/Twitter bookmarks & likes as a short daily review.

- **No server, no account.** Everything is stored in IndexedDB on your device. Export a JSON backup from Settings.
- **Daily review:** a few highlights a day (default 10). Long-unseen ones and favorites come up more often, and it mixes books. Swipe through, ♥ favorite, ✕ discard forever, add notes, share.
- **Library:** search, filter by source or favorites, browse by book.
- **Offline**, installable to the Home Screen, dark mode, and an Android share target ("Share → Marginalia").

## Importing

| Source | How |
|---|---|
| Kindle, all books | "Marginalia: Kindle" bookmarklet on read.amazon.com/notebook (desktop) → import the downloaded JSON |
| Kindle device | `documents/My Clippings.txt` over USB |
| Kindle app | Notebook → Export → email → import the `.html` |
| X bookmarks/likes | "Marginalia: X" bookmarklet on x.com/i/bookmarks or your Likes tab |
| X likes (full) | Your X data archive `.zip` (only `data/like.js` is read, so big archives are fine) |
| Readwise | readwise.io/export → CSV |

Re-importing is safe: highlights are deduped by their text.

## Hosting

Static files, no build step. Serve the folder from any static host over HTTPS (GitHub Pages, Vercel, Netlify, Cloudflare Pages).
When you change files, bump `VERSION` in `sw.js` so installed copies update.

## Cloud sync + automatic X bookmarks

Optional: without signing in, the app stays fully local. Signed in, highlights sync across devices and new X bookmarks arrive weekly with no action from you.

```
pg_cron (Mondays 09:17 UTC) → sync-x edge function → X API (your bookmarks) → highlights table ⇄ the app on each device
```

Live setup (Supabase project `marginalia`, ref `ztzxhzmbxgaxrmphenrp`, Sydney):

1. **Database**: `supabase/migrations/` creates the tables, row-level security, and the weekly pg_cron job.
   The cron authenticates with a random secret generated inside the database vault.
2. **Edge functions** `x-connect` and `sync-x`, deployed with JWT verification off (they check auth themselves).
   Function secrets: `X_CLIENT_ID`, `X_CLIENT_SECRET`, `APP_URL`.
3. **X developer app** (developer.x.com, pay-per-use): OAuth 2.0, type *Web App (confidential client)*,
   callback URL `https://ztzxhzmbxgaxrmphenrp.supabase.co/functions/v1/x-connect`.
4. In the app: Settings → create account → **Connect X**.

The first connection backfills your bookmarks (X returns up to the ~800 most recent). After that each run stops as soon as it reaches bookmarks it already has, so a weekly run costs about a cent.
