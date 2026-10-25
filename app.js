import * as db from './db.js';
import { parseFile, parseText, idFor } from './importers.js';

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const sheet = $('#sheet');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 864e5;

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`mg.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(`mg.${k}`, JSON.stringify(v)); },
};

let settings = { dailyCount: 10, sources: { kindle: true, twitter: true, other: true }, ...store.get('settings', {}) };
let items = [];
let byId = new Map();

const icons = {
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

function setHeader(title, sub = '') {
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
}

const badgeFor = h => h.source === 'twitter'
  ? '<span class="badge twitter">𝕏</span>'
  : `<span class="badge">${esc((h.title || h.author || '?').trim()[0]?.toUpperCase() || '?')}</span>`;

const where = h => [h.page ? `p. ${h.page}` : '', h.location ? `loc. ${h.location}` : ''].filter(Boolean).join(' · ');

// ---------- Data ----------
async function load() {
  items = await db.getAll();
  byId = new Map(items.map(h => [h.id, h]));
}

async function save(...hs) {
  hs.forEach(h => { h.updatedAt = Date.now(); byId.set(h.id, h); });
  items = [...byId.values()];
  await db.putMany(hs);
}

async function ingest(list, { restore = false } = {}) {
  let added = 0, updated = 0;
  const changed = [];
  const now = Date.now();
  for (const raw of list) {
    const text = String(raw.text || '').trim();
    if (!text) continue;
    const id = raw.id && restore ? raw.id : idFor({ text });
    const ex = byId.get(id);
    const src = ['kindle', 'twitter', 'other'].includes(raw.source) ? raw.source : 'other';
    if (!ex) {
      const h = {
        id, text, title: raw.title || '', author: raw.author || '', source: src, url: raw.url || '', note: raw.note || '',
        location: raw.location ?? null, page: raw.page ?? null, highlightedAt: raw.highlightedAt ?? null,
        addedAt: raw.addedAt ?? now, favorite: !!raw.favorite, discarded: !!raw.discarded,
        lastSeen: raw.lastSeen ?? null, seenCount: raw.seenCount ?? 0,
      };
      byId.set(id, h); changed.push(h); added++;
    } else {
      // Keep the user's state; only fill in gaps (or overwrite everything on a backup restore).
      const before = JSON.stringify(ex);
      if (restore) Object.assign(ex, raw, { id });
      else for (const k of ['title', 'author', 'url', 'note', 'location', 'page', 'highlightedAt']) if (!ex[k] && raw[k]) ex[k] = raw[k];
      if (JSON.stringify(ex) !== before) { changed.push(ex); updated++; }
    }
  }
  items = [...byId.values()];
  if (changed.length) await db.putMany(changed);
  return { added, updated, skipped: list.length - added - updated };
}

// ---------- Daily review ----------
function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
const startOfToday = () => new Date().setHours(0, 0, 0, 0);

function pick(n, exclude = new Set()) {
  const now = Date.now();
  const pool = items.filter(h => !h.discarded && !exclude.has(h.id) && settings.sources[h.source] !== false);
  // Weighted random sample (Efraimidis–Spirakis): long-unseen and favourites surface more often.
  const ranked = pool.map(h => {
    const days = h.lastSeen ? (now - h.lastSeen) / DAY : 120;
    const w = (Math.min(days, 120) + 1) * (h.favorite ? 2.5 : 1);
    return { h, k: Math.pow(Math.random(), 1 / w) };
  }).sort((a, b) => b.k - a.k);
  const chosen = [], groups = new Set();
  const spread = ranked.length > n * 3;
  for (const { h } of ranked) {
    if (chosen.length >= n) break;
    const g = h.title || h.author;
    if (spread && groups.has(g)) continue; // vary books when the library is big enough
    groups.add(g);
    chosen.push(h.id);
  }
  for (const { h } of ranked) { if (chosen.length >= n) break; if (!chosen.includes(h.id)) chosen.push(h.id); }
  return chosen;
}

function daily() {
  let d = store.get('daily');
  if (!d || d.date !== dayKey()) d = { date: dayKey(), ids: pick(settings.dailyCount), pos: 0 };
  d.ids = d.ids.filter(id => byId.has(id) && !byId.get(id).discarded);
  d.pos = Math.min(d.pos, d.ids.length);
  store.set('daily', d);
  return d;
}

function renderReview() {
  const d = daily();
  setHeader('Today', new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }));

  if (!items.length) {
    view.innerHTML = `<div class="empty"><h2>Your highlights, resurfaced</h2>
      <p>Import your Kindle highlights and X bookmarks or likes, and you'll get a few each day to reread.</p>
      <a class="btn" href="#import">Import highlights</a></div>`;
    return;
  }
  if (!d.ids.length) {
    view.innerHTML = `<div class="empty"><h2>Nothing to show</h2><p>Everything is either discarded or from a source you've turned off in Settings.</p><a class="btn" href="#settings">Settings</a></div>`;
    return;
  }
  if (d.pos >= d.ids.length) {
    view.innerHTML = `<div class="empty"><h2>That's today's review ✓</h2>
      <p>You've gone through ${d.ids.length} highlights. Come back tomorrow for a new set.</p>
      <div class="row" style="justify-content:center">
        <button class="btn" id="more">5 more</button>
        <button class="btn ghost" id="again">Start over</button>
      </div></div>`;
    $('#more').onclick = () => { d.ids.push(...pick(5, new Set(d.ids))); store.set('daily', d); renderReview(); };
    $('#again').onclick = () => { d.pos = 0; store.set('daily', d); renderReview(); };
    return;
  }

  const h = byId.get(d.ids[d.pos]);
  if (!h.lastSeen || h.lastSeen < startOfToday()) { h.lastSeen = Date.now(); h.seenCount = (h.seenCount || 0) + 1; save(h); }

  view.innerHTML = `
    <div class="progress">${d.ids.map((_, i) => `<i class="${i < d.pos ? 'done' : i === d.pos ? 'cur' : ''}"></i>`).join('')}</div>
    <div class="deck"><article class="qcard" id="card">
      <div class="qmark">“</div>
      <div class="qtext ${h.text.length > 420 ? 'long' : ''}">${esc(h.text)}</div>
      ${h.note ? `<div class="qnote">${esc(h.note)}</div>` : ''}
      <div class="qmeta">${badgeFor(h)}
        <div class="who"><div class="t">${esc(h.title || 'Untitled')}</div><div class="a">${esc([h.author, where(h)].filter(Boolean).join(' · '))}</div></div>
        ${h.url && /^https?:/.test(h.url) ? `<a href="${esc(h.url)}" target="_blank" rel="noopener" class="btn ghost small">Open</a>` : ''}
      </div>
    </article></div>
    <div class="actions">
      <button class="round" id="discard" title="Never show again">${icons.x}</button>
      <button class="round" id="edit" title="Edit / add note">${icons.edit}</button>
      <button class="round ${h.favorite ? 'fav' : ''}" id="fav" title="Favorite">${icons.heart}</button>
      <button class="round" id="share" title="Share">${icons.share}</button>
      <button class="round" id="next" title="Next">${icons.next}</button>
    </div>
    <p class="hint">${d.pos + 1} of ${d.ids.length} · swipe to move between highlights</p>`;

  const go = dir => {
    const np = d.pos + dir;
    if (np < 0) return;
    $('#card').classList.add(dir > 0 ? 'out-l' : 'out-r');
    setTimeout(() => { d.pos = np; store.set('daily', d); renderReview(); }, 180);
  };
  $('#next').onclick = () => go(1);
  $('#fav').onclick = async () => { h.favorite = !h.favorite; await save(h); $('#fav').classList.toggle('fav', h.favorite); toast(h.favorite ? 'Added to favorites' : 'Removed from favorites'); };
  $('#discard').onclick = async () => {
    h.discarded = true; await save(h);
    d.ids.splice(d.pos, 1); store.set('daily', d);
    toast('Discarded. It won\'t come back');
    renderReview();
  };
  $('#edit').onclick = () => openEditor(h, renderReview);
  $('#share').onclick = () => shareHighlight(h);

  let sx = 0, sy = 0;
  const deck = $('.deck');
  deck.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  deck.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  });
}

async function shareHighlight(h) {
  const text = `“${h.text}”\n— ${[h.author, h.title].filter(Boolean).join(', ')}`;
  try {
    if (navigator.share) await navigator.share({ text, url: /^https?:/.test(h.url) ? h.url : undefined });
    else { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  } catch { /* cancelled */ }
}

// ---------- Editor sheet ----------
function openEditor(h, after) {
  const isNew = !h;
  h = h || { text: '', title: '', author: '', note: '', url: '', source: 'other' };
  sheet.innerHTML = `
    <form method="dialog" id="ed">
      <div class="sheet-h"><h2>${isNew ? 'New highlight' : 'Edit highlight'}</h2><button class="x-close" value="cancel" formnovalidate>✕</button></div>
      <label class="f">Highlight</label><textarea name="text" rows="6" required>${esc(h.text)}</textarea>
      <label class="f">Your note</label><textarea name="note" rows="2" placeholder="Why it matters to you…">${esc(h.note)}</textarea>
      <label class="f">Book / source title</label><input type="text" name="title" value="${esc(h.title)}">
      <label class="f">Author</label><input type="text" name="author" value="${esc(h.author)}">
      <label class="f">Link</label><input type="url" name="url" value="${esc(/^https?:/.test(h.url) ? h.url : '')}" placeholder="https://">
      <div class="row" style="margin-top:18px">
        <button class="btn" value="save" style="flex:1">Save</button>
        ${isNew ? '' : `<button class="btn ghost" value="toggle" type="submit">${h.discarded ? 'Restore' : 'Discard'}</button>
        <button class="btn danger" value="delete" type="submit">Delete</button>`}
      </div>
    </form>`;
  sheet.showModal();
  const form = $('#ed', sheet);
  sheet.onclose = async () => {
    const v = sheet.returnValue;
    if (v === 'save' || v === 'toggle') {
      const f = new FormData(form);
      const text = f.get('text').trim();
      if (!text) return;
      if (isNew) {
        await ingest([{ ...h, text, note: f.get('note').trim(), title: f.get('title').trim(), author: f.get('author').trim(), url: f.get('url').trim() }]);
        toast('Saved');
      } else {
        Object.assign(h, { text, note: f.get('note').trim(), title: f.get('title').trim(), author: f.get('author').trim() });
        if (f.get('url').trim() || /^https?:/.test(h.url)) h.url = f.get('url').trim();
        if (v === 'toggle') h.discarded = !h.discarded;
        await save(h);
        toast(v === 'toggle' ? (h.discarded ? 'Discarded' : 'Restored') : 'Saved');
      }
    } else if (v === 'delete' && confirm('Delete this highlight permanently?')) {
      byId.delete(h.id); items = [...byId.values()];
      await db.remove(h.id);
      toast('Deleted');
    }
    sheet.returnValue = '';
    after?.();
  };
}

// ---------- Library ----------
const lib = { q: '', filter: 'all', mode: 'highlights', book: null, limit: 60 };

function renderLibrary() {
  setHeader('Library', `${items.filter(h => !h.discarded).length} highlights`);
  const filters = [['all', 'All'], ['fav', '♥ Favorites'], ['kindle', 'Kindle'], ['twitter', 'X'], ['other', 'Other'], ['discarded', 'Discarded']];
  view.innerHTML = `
    <input type="search" id="q" placeholder="Search highlights, books, authors, notes…" value="${esc(lib.q)}">
    <div class="chips">
      ${[['highlights', 'Highlights'], ['books', 'Books']].map(([k, l]) => `<button class="chip ${lib.mode === k ? 'on' : ''}" data-mode="${k}">${l}</button>`).join('')}
      <span style="width:1px;background:var(--line);flex:none"></span>
      ${filters.map(([k, l]) => `<button class="chip ${lib.filter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}
    </div>
    <div id="results"></div>
    <button class="btn block ghost" id="add" style="margin-top:16px">+ Add a highlight manually</button>`;
  $('#q').oninput = e => { lib.q = e.target.value; lib.limit = 60; renderResults(); };
  view.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { lib.mode = b.dataset.mode; lib.book = null; renderLibrary(); });
  view.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { lib.filter = b.dataset.f; lib.limit = 60; renderLibrary(); });
  $('#add').onclick = () => openEditor(null, renderLibrary);
  renderResults();
}

function filtered() {
  const q = lib.q.trim().toLowerCase();
  return items.filter(h => {
    if (lib.filter === 'discarded' ? !h.discarded : h.discarded) return false;
    if (lib.filter === 'fav' && !h.favorite) return false;
    if (['kindle', 'twitter', 'other'].includes(lib.filter) && h.source !== lib.filter) return false;
    if (lib.book != null && (h.title || '') !== lib.book) return false;
    return !q || `${h.text} ${h.title} ${h.author} ${h.note}`.toLowerCase().includes(q);
  });
}

function renderResults() {
  const box = $('#results');
  const list = filtered();
  if (lib.mode === 'books' && lib.book == null) {
    const groups = new Map();
    for (const h of list) {
      const k = h.title || '';
      const g = groups.get(k) || { title: k, author: h.author, source: h.source, n: 0, last: 0 };
      g.n++; g.last = Math.max(g.last, h.highlightedAt || h.addedAt || 0);
      groups.set(k, g);
    }
    const books = [...groups.values()].sort((a, b) => b.last - a.last);
    box.innerHTML = books.length ? `<div class="list">${books.map(b => `
      <button class="item book" data-book="${esc(b.title)}">${badgeFor(b)}
        <div class="who"><div class="t">${esc(b.title || 'Untitled')}</div><div class="a">${esc(b.author)}</div></div>
        <span class="count">${b.n}</span></button>`).join('')}</div>` : '<p class="hint" style="margin-top:30px">No books match.</p>';
    box.querySelectorAll('[data-book]').forEach(b => b.onclick = () => { lib.book = b.dataset.book; lib.mode = 'highlights'; renderResults(); });
    return;
  }
  const sorted = list.sort((a, b) => lib.book != null
    ? (a.location ?? a.page ?? 0) - (b.location ?? b.page ?? 0)
    : (b.highlightedAt || b.addedAt || 0) - (a.highlightedAt || a.addedAt || 0));
  box.innerHTML = `
    ${lib.book != null ? `<div class="crumb"><span>${esc(lib.book || 'Untitled')} · ${sorted.length}</span><button class="btn ghost small" id="back">All books</button></div>` : ''}
    ${sorted.length ? '' : '<p class="hint" style="margin-top:30px">No highlights match.</p>'}
    <div class="list">${sorted.slice(0, lib.limit).map(h => `
      <button class="item ${h.discarded ? 'discarded' : ''}" data-id="${h.id}">
        <div class="x">${esc(h.text)}</div>
        <div class="m">${h.favorite ? '<span class="heart">♥</span>' : ''}${h.note ? '<span>✎</span>' : ''}
          <span>${esc([h.title, h.author].filter(Boolean).join(' — ') || 'Untitled')}</span></div>
      </button>`).join('')}</div>
    ${sorted.length > lib.limit ? `<button class="btn ghost block" id="moreRes" style="margin-top:12px">Show more (${sorted.length - lib.limit})</button>` : ''}`;
  box.querySelectorAll('[data-id]').forEach(b => b.onclick = () => openEditor(byId.get(b.dataset.id), renderResults));
  $('#back', box)?.addEventListener('click', () => { lib.book = null; lib.mode = 'books'; renderLibrary(); });
  $('#moreRes', box)?.addEventListener('click', () => { lib.limit += 100; renderResults(); });
}

// ---------- Import ----------
let bookmarklets = {};
async function loadBookmarklets() {
  for (const k of ['x', 'kindle']) {
    if (bookmarklets[k]) continue;
    const src = await (await fetch(`bookmarklets/${k}.js`)).text();
    bookmarklets[k] = 'javascript:' + encodeURIComponent(src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'));
  }
}

async function handleImport(promise) {
  try {
    const { kind, items: list } = await promise;
    if (!list.length) return toast(`No highlights found in that ${kind} file`);
    // Our own backups carry ids and review state: restore those faithfully instead of merging.
    const restore = kind === 'JSON' && list.some(h => h.id && 'seenCount' in h);
    const r = await ingest(list, { restore });
    toast(`${restore ? 'Backup restored' : kind}: ${r.added} new${r.updated ? `, ${r.updated} updated` : ''}${r.skipped ? `, ${r.skipped} already here` : ''}`);
    store.set('daily', null);
  } catch (e) {
    console.error(e);
    toast(e.message || 'Import failed');
  }
}

async function renderImport() {
  setHeader('Import');
  view.innerHTML = `
    <label class="drop"><input type="file" id="file" multiple accept=".txt,.html,.htm,.csv,.json,.js,.zip,text/*,application/json,application/zip">
      <strong>Choose files to import</strong>
      <span>My Clippings.txt · Kindle notebook .html · X archive .zip / like.js · Readwise .csv · .json</span></label>

    <div class="sec"><h3>📚 Kindle: every book (Kindle Cloud)</h3>
      <p>Covers books read on any device or app. Use a desktop browser.</p>
      <ol><li>Drag this to your bookmarks bar: <a class="bm" id="bmKindle" href="#">→ Marginalia: Kindle</a></li>
        <li>Open <a href="https://read.amazon.com/notebook" target="_blank" rel="noopener">read.amazon.com/notebook</a> and sign in</li>
        <li>Click the bookmark. It fetches every book and downloads <code>kindle-highlights.json</code></li>
        <li>Import that file here (AirDrop it to your phone, or click the banner to copy it and paste below)</li></ol></div>

    <div class="sec"><h3>📖 Kindle: device clippings</h3>
      <p>Plug your Kindle into a computer over USB and import <code>documents/My Clippings.txt</code>.
      You can also use the Kindle phone app: open a book → Notebook → Export → email it to yourself, then import the <code>.html</code> attachment.</p></div>

    <div class="sec"><h3>𝕏 Bookmarks &amp; likes</h3>
      <ol><li>Drag to bookmarks bar: <a class="bm" id="bmX" href="#">→ Marginalia: X</a></li>
        <li>Open <a href="https://x.com/i/bookmarks" target="_blank" rel="noopener">x.com/i/bookmarks</a> (or your Likes tab)</li>
        <li>Click the bookmark. It scrolls through everything and downloads a <code>.json</code> file</li></ol>
      <p>For all your likes, request your archive (X → Settings → Your account → Download an archive) and import the <code>.zip</code> directly.</p></div>

    <div class="sec"><h3>↪ Moving off Readwise</h3>
      <p>Go to <a href="https://readwise.io/export" target="_blank" rel="noopener">readwise.io/export</a> → <em>Export to CSV</em>, and import the file here. Your whole history comes across, tweets included.</p></div>

    <div class="sec"><h3>📋 Paste</h3>
      <p>Paste JSON from a bookmarklet, or the contents of any supported file.</p>
      <textarea id="paste" rows="3" placeholder='{"highlights":[…]}'></textarea>
      <div class="row"><button class="btn" id="doPaste">Import pasted text</button>
        <button class="btn ghost" id="addOne">Add one manually</button></div></div>`;

  $('#file').onchange = async e => {
    for (const f of e.target.files) await handleImport(parseFile(f));
    e.target.value = '';
  };
  $('#doPaste').onclick = async () => {
    const t = $('#paste').value.trim();
    if (!t) return toast('Paste something first');
    await handleImport(Promise.resolve().then(() => parseText(t)));
    $('#paste').value = '';
  };
  $('#addOne').onclick = () => openEditor(null);
  for (const [id, k] of [['bmKindle', 'kindle'], ['bmX', 'x']]) $(`#${id}`).onclick = e => { e.preventDefault(); toast('Drag this button to your bookmarks bar'); };
  try {
    await loadBookmarklets();
    $('#bmKindle').href = bookmarklets.kindle;
    $('#bmX').href = bookmarklets.x;
  } catch { /* offline */ }
}

// ---------- Settings ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function toMarkdown() {
  const groups = new Map();
  for (const h of items.filter(h => !h.discarded)) {
    const k = `${h.title || 'Untitled'}|${h.author || ''}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(h);
  }
  return [...groups].map(([k, hs]) => {
    const [title, author] = k.split('|');
    const body = hs.sort((a, b) => (a.location ?? 0) - (b.location ?? 0)).map(h =>
      `> ${h.text.replace(/\n/g, '\n> ')}${h.favorite ? ' ♥' : ''}\n${h.note ? `\n**Note:** ${h.note}\n` : ''}${/^https?:/.test(h.url) ? `\n[source](${h.url})\n` : ''}`).join('\n');
    return `## ${title}${author ? `\n*${author}*` : ''}\n\n${body}`;
  }).join('\n\n---\n\n');
}

async function renderSettings() {
  setHeader('Settings');
  const live = items.filter(h => !h.discarded);
  const persisted = await navigator.storage?.persisted?.();
  view.innerHTML = `
    <div class="sec"><div class="stats">
      <div class="stat"><b>${live.length}</b><span>highlights</span></div>
      <div class="stat"><b>${new Set(live.map(h => h.title)).size}</b><span>books &amp; sources</span></div>
      <div class="stat"><b>${live.filter(h => h.favorite).length}</b><span>favorites</span></div>
      <div class="stat"><b>${items.length - live.length}</b><span>discarded</span></div>
    </div></div>

    <div class="sec"><h3>Daily review</h3>
      <label class="toggle">Highlights per day <select id="count">${[3, 5, 10, 15, 20, 30].map(n => `<option ${n === settings.dailyCount ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="toggle">Include Kindle <input type="checkbox" data-src="kindle" ${settings.sources.kindle ? 'checked' : ''}></label>
      <label class="toggle">Include X / Twitter <input type="checkbox" data-src="twitter" ${settings.sources.twitter ? 'checked' : ''}></label>
      <label class="toggle">Include other <input type="checkbox" data-src="other" ${settings.sources.other ? 'checked' : ''}></label>
      <div class="row"><button class="btn ghost small" id="reshuffle">Reshuffle today's set</button></div></div>

    <div class="sec"><h3>Backup</h3>
      <p>Everything is stored only on this device. Back it up now and then, or use the backup to move to a new phone: import the file on the Import tab.
      ${persisted === false ? '<br>⚠️ Your browser may clear this storage. Add the app to your Home Screen to keep it.' : ''}</p>
      <div class="row"><button class="btn" id="exJson">Export backup (.json)</button><button class="btn ghost" id="exMd">Export Markdown</button></div></div>

    <div class="sec"><h3>Danger zone</h3>
      <div class="row"><button class="btn danger" id="wipe">Delete all highlights</button></div></div>
    <p class="hint">Marginalia: your highlights, on your own device. No account, no server, no subscription.</p>`;

  $('#count').onchange = e => { settings.dailyCount = +e.target.value; store.set('settings', settings); store.set('daily', null); toast('Takes effect on the next reshuffle'); };
  view.querySelectorAll('[data-src]').forEach(c => c.onchange = () => { settings.sources[c.dataset.src] = c.checked; store.set('settings', settings); store.set('daily', null); });
  $('#reshuffle').onclick = () => { store.set('daily', null); location.hash = '#review'; };
  $('#exJson').onclick = () => download(`marginalia-backup-${dayKey()}.json`, JSON.stringify({ app: 'marginalia', version: 1, exportedAt: Date.now(), highlights: items }), 'application/json');
  $('#exMd').onclick = () => download(`marginalia-${dayKey()}.md`, toMarkdown(), 'text/markdown');
  $('#wipe').onclick = async () => {
    if (!confirm(`Delete all ${items.length} highlights from this device? Export a backup first if unsure.`)) return;
    await db.clearAll(); items = []; byId.clear(); store.set('daily', null);
    toast('All highlights deleted'); renderSettings();
  };
}

// ---------- Router ----------
const routes = { review: renderReview, library: renderLibrary, import: renderImport, settings: renderSettings };
function route() {
  const tab = location.hash.slice(1) || 'review';
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  window.scrollTo(0, 0);
  (routes[tab] || renderReview)();
}
window.addEventListener('hashchange', route);

// Android "Share to Marginalia" (Web Share Target)
function handleShareTarget() {
  const p = new URLSearchParams(location.search);
  if (!p.has('share')) return;
  const text = p.get('text') || '', url = p.get('url') || (text.match(/https?:\/\/\S+$/)?.[0] ?? '');
  history.replaceState(null, '', location.pathname + location.hash);
  openEditor(null, route);
  const f = $('#ed', sheet);
  f.text.value = url ? text.replace(url, '').trim() : text;
  f.title.value = p.get('title') || '';
  f.url.value = url;
}

await load();
route();
handleShareTarget();
navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
