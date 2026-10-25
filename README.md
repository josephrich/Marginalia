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
