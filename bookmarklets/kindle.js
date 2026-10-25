// Run on https://read.amazon.com/notebook (desktop browser, signed in).
// Fetches the highlights for every book in your Kindle library and downloads a JSON file.
(async () => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1c1917;color:#fff;padding:10px 18px;border-radius:999px;font:600 14px system-ui;box-shadow:0 6px 24px #0006;cursor:pointer';
  document.body.appendChild(box);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const say = s => { box.textContent = s; };

  // The library list lazy-loads; scroll it until the count stops growing.
  const lib = document.querySelector('#kp-notebook-library') || document.scrollingElement;
  for (let n = -1, tries = 0; tries < 4;) {
    const c = document.querySelectorAll('.kp-notebook-library-each-book').length;
    if (c === n) tries++; else { tries = 0; n = c; }
    lib.scrollTop = lib.scrollHeight;
    say(`Finding books… ${c}`);
    await sleep(700);
  }
  const books = [...document.querySelectorAll('.kp-notebook-library-each-book')].map(b => ({
    asin: b.id,
    title: (b.querySelector('h2')?.innerText || '').trim(),
    author: (b.querySelector('p')?.innerText || '').replace(/^\s*(By|Von|Par|De|Di):\s*/i, '').trim(),
  })).filter(b => b.asin);

  const out = [];
  for (const [i, b] of books.entries()) {
    say(`Book ${i + 1}/${books.length}: ${b.title.slice(0, 40)} (${out.length} highlights)`);
    let token = '', state = '';
    for (let page = 0; page < 100; page++) {
      const res = await fetch(`/notebook?asin=${b.asin}&contentLimitState=${encodeURIComponent(state)}&token=${encodeURIComponent(token)}`, { credentials: 'include' });
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      for (const hl of doc.querySelectorAll('[id="highlight"]')) {
        const row = hl.closest('.a-row.a-spacing-base') || hl.closest('[id]:not([id="highlight"])') || hl.parentElement;
        const text = hl.innerText?.trim() || hl.textContent.trim();
        if (!text) continue;
        const note = (row.querySelector('[id="note"]')?.textContent || '').trim();
        const loc = +(row.querySelector('[id="kp-annotation-location"]')?.value || 0) || null;
        out.push({ text, note, title: b.title, author: b.author, source: 'kindle', location: loc, url: `kindle://book?action=open&asin=${b.asin}${loc ? `&location=${loc}` : ''}` });
      }
      token = doc.querySelector('.kp-notebook-annotations-next-page-start')?.value || '';
      state = doc.querySelector('.kp-notebook-content-limit-state')?.value || '';
      if (!token) break;
      await sleep(250);
    }
    await sleep(250);
  }

  const data = JSON.stringify({ app: 'marginalia', highlights: out });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = 'kindle-highlights.json';
  a.click();
  say(`Done: ${out.length} highlights from ${books.length} books downloaded. Tap to also copy`);
  box.onclick = async () => { await navigator.clipboard.writeText(data); say('Copied ✓'); setTimeout(() => box.remove(), 1500); };
})();
