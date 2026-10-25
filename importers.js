// Parsers that turn exports from Kindle, X/Twitter and Readwise into highlight records:
// { text, title, author, source: 'kindle'|'twitter'|'other', url, note, location, page, highlightedAt }

export function normText(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 500);
}

// cyrb53 — a small, fast string hash. Identity of a highlight is its normalized text,
// so the same quote imported from two places (e.g. Readwise CSV + Kindle) dedupes.
export function hashId(str) {
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

export const idFor = h => hashId(normText(h.text));

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(/^[A-Za-z]+,\s*/, ''));
  return isNaN(t) ? null : t;
}

// "Kahneman, Daniel" -> "Daniel Kahneman"; handles "A, B; C, D" too.
export function normAuthor(a) {
  return (a || '').split(';').map(p => {
    const parts = p.split(',').map(x => x.trim()).filter(Boolean);
    return parts.length === 2 ? `${parts[1]} ${parts[0]}` : p.trim();
  }).filter(Boolean).join(', ');
}

const LOC_RE = /(?:location|loc\.?|posición|posicion|position|emplacement|posizione)\s*(\d+)(?:\s*-\s*(\d+))?/i;
const PAGE_RE = /(?:page|página|pagina|seite)\s*(\d+)/i;

// ---------- Kindle device: "My Clippings.txt" ----------
export function parseClippings(text) {
  const out = [];
  const byBook = new Map();
  for (const raw of text.replace(/\r/g, '').split(/^==========\s*$/m)) {
    const lines = raw.replace(/﻿/g, '').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    if (lines.length < 2) continue;
    const head = lines[0].trim();
    const meta = lines[1].trim();
    const body = lines.slice(2).join('\n').trim();
    if (!body || /clipping limit/i.test(body)) continue;
    if (/bookmark|marcador|lesezeichen|signet|segnalibro/i.test(meta)) continue;

    let title = head, author = '';
    const m = head.match(/^(.*)\(([^()]*)\)\s*$/);
    if (m) { title = m[1].trim(); author = normAuthor(m[2]); }

    const loc = meta.match(LOC_RE);
    const start = loc ? +loc[1] : null;
    const end = loc && loc[2] ? +loc[2] : start;
    const page = meta.match(PAGE_RE)?.[1];
    const added = parseDate(meta.split('|').pop().replace(/^.*?(?:added on|ajouté le|añadido el|hinzugefügt am)\s*/i, ''));
    const list = byBook.get(title) || [];
    byBook.set(title, list);

    if (/note|nota|notiz|remarque/i.test(meta.split('|')[0])) {
      const target = start != null && [...list].reverse().find(h => h.location != null && start >= h.location && start <= h._end);
      if (target) { target.note = target.note ? `${target.note}\n${body}` : body; continue; }
    }

    const h = { text: body, title, author, source: 'kindle', location: start, _end: end, page: page ? +page : null, highlightedAt: added };
    // Kindle appends a new clipping when you extend/shrink a highlight. Keep the newest.
    const dupIdx = list.findIndex(o => o.location != null && start != null && start <= o._end && end >= o.location &&
      (o.text.includes(body) || body.includes(o.text)));
    if (dupIdx >= 0) {
      const old = list[dupIdx];
      h.note = old.note;
      out[out.indexOf(old)] = h;
      list[dupIdx] = h;
    } else {
      out.push(h);
      list.push(h);
    }
  }
  out.forEach(h => delete h._end);
  return out;
}

// ---------- Kindle app: "Export notebook" HTML (emailed from iOS/Android app) ----------
export function parseKindleHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.querySelector('.bookTitle')?.textContent.trim() || 'Untitled';
  const author = normAuthor(doc.querySelector('.authors')?.textContent.trim());
  const out = [];
  let last = null, heading = null;
  // Kindle's export has unclosed tags, so nodes can nest. Walk in document order and
  // only read each noteText's own text nodes.
  for (const el of doc.querySelectorAll('.noteHeading, .noteText')) {
    if (el.classList.contains('noteHeading')) { heading = el.textContent; continue; }
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (!text || heading == null) continue;
    const head = heading;
    heading = null;
    if (/bookmark/i.test(head)) continue;
    if (/^\s*(note|nota|notiz|remarque)/i.test(head) && last) {
      last.note = last.note ? `${last.note}\n${text}` : text;
      continue;
    }
    const loc = head.match(LOC_RE)?.[1];
    const page = head.match(PAGE_RE)?.[1];
    last = { text, title, author, source: 'kindle', location: loc ? +loc : null, page: page ? +page : null };
    out.push(last);
  }
  return out;
}

// ---------- X/Twitter archive: data/like.js ----------
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function parseTwitterArchive(js) {
  const json = JSON.parse(js.slice(js.indexOf('=') + 1).trim().replace(/;$/, ''));
  return json.map(x => x.like || x.bookmark || x).filter(l => l.fullText).map(l => ({
    text: decodeEntities(l.fullText).replace(/(\s*https:\/\/t\.co\/\w+)+\s*$/, '').trim(),
    title: 'Liked tweets',
    author: '',
    source: 'twitter',
    url: l.expandedUrl?.includes('/status/') ? l.expandedUrl.replace('twitter.com', 'x.com') : `https://x.com/i/status/${l.tweetId}`,
  })).filter(h => h.text);
}

// ---------- Readwise CSV export (for migrating off Readwise) ----------
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function parseReadwiseCsv(text) {
  const [header, ...rows] = parseCSV(text.replace(/^﻿/, ''));
  const col = name => header.findIndex(h => h.trim().toLowerCase() === name);
  const c = {
    text: col('highlight'), title: col('book title'), author: col('book author'), asin: col('amazon book id'),
    note: col('note'), loc: col('location'), locType: col('location type'), at: col('highlighted at'), url: col('url'),
  };
  if (c.text < 0) throw new Error('CSV has no "Highlight" column');
  return rows.filter(r => r[c.text]?.trim()).map(r => {
    const title = r[c.title]?.trim() || '';
    const author = r[c.author]?.trim() || '';
    const source = r[c.asin]?.trim() ? 'kindle' : /^tweets from/i.test(title) || author.startsWith('@') ? 'twitter' : 'other';
    const loc = +r[c.loc];
    const isOrder = (r[c.locType] || '').toLowerCase() === 'order';
    return {
      text: r[c.text].trim(), title, author, source,
      note: r[c.note]?.trim() || '',
      location: loc && !isOrder ? loc : null,
      highlightedAt: parseDate(r[c.at]),
      url: c.url >= 0 ? r[c.url]?.trim() || '' : '',
    };
  });
}

// ---------- Our own JSON (backups + bookmarklet output) ----------
export function parseJson(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.highlights;
  if (!Array.isArray(list)) throw new Error('JSON has no highlights list');
  return list.filter(h => h && typeof h.text === 'string' && h.text.trim());
}

// ---------- Minimal ZIP reader (only reads the entries we need, so huge X archives are fine) ----------
async function readZipEntries(file, predicate) {
  const u32 = (dv, o) => dv.getUint32(o, true), u16 = (dv, o) => dv.getUint16(o, true);
  const tailSize = Math.min(file.size, 65557);
  const tailStart = file.size - tailSize;
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  let cdSize = u32(tail, eocd + 12), cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff && eocd >= 20 && u32(tail, eocd - 20) === 0x07064b50) {
    const z64 = Number(tail.getBigUint64(eocd - 12, true));
    const z = new DataView(await file.slice(z64, z64 + 56).arrayBuffer());
    cdSize = Number(z.getBigUint64(40, true));
    cdOffset = Number(z.getBigUint64(48, true));
  }
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const results = [];
  for (let p = 0; p + 46 <= cd.byteLength && u32(cd, p) === 0x02014b50;) {
    const method = u16(cd, p + 10);
    let compSize = u32(cd, p + 20), size = u32(cd, p + 24), localOff = u32(cd, p + 42);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    for (let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end;) {
      const id = u16(cd, e), len = u16(cd, e + 2);
      if (id === 1) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(cd.getBigUint64(q, true)); q += 8; }
        if (compSize === 0xffffffff) { compSize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (localOff === 0xffffffff) localOff = Number(cd.getBigUint64(q, true));
      }
      e += 4 + len;
    }
    if (predicate(name)) {
      const lh = new DataView(await file.slice(localOff, localOff + 30).arrayBuffer());
      const start = localOff + 30 + u16(lh, 26) + u16(lh, 28);
      const blob = file.slice(start, start + compSize);
      if (method === 0) results.push(await blob.text());
      else if (method === 8) results.push(await new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).text());
      else throw new Error(`Unsupported zip compression (${method})`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return results;
}

// ---------- Sniff + dispatch ----------
export function parseText(text, name = '') {
  const t = text.trimStart();
  if (/^window\.YTD\./.test(t)) return { kind: 'X archive', items: parseTwitterArchive(t) };
  if (/^[[{]/.test(t)) return { kind: 'JSON', items: parseJson(t) };
  if (/noteHeading|bookTitle/.test(t) && /^</.test(t)) return { kind: 'Kindle notebook', items: parseKindleHtml(t) };
  if (/^==========\s*$/m.test(t)) return { kind: 'Kindle clippings', items: parseClippings(t) };
  if (/\.csv$/i.test(name) || /^"?highlight"?,/i.test(t)) return { kind: 'Readwise CSV', items: parseReadwiseCsv(t) };
  throw new Error("Couldn't recognise this file format");
}

export async function parseFile(file) {
  if (/\.zip$/i.test(file.name)) {
    const parts = await readZipEntries(file, n => /(^|\/)data\/(like|bookmark)(-part\d+)?\.js$/.test(n));
    if (!parts.length) throw new Error('No data/like.js found in this zip — is it your X archive?');
    return { kind: 'X archive', items: parts.flatMap(parseTwitterArchive) };
  }
  return parseText(await file.text(), file.name);
}
