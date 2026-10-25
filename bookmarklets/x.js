// Run on https://x.com/i/bookmarks or https://x.com/<you>/likes.
// Auto-scrolls, collects every tweet, then downloads a JSON file Marginalia can import.
(async () => {
  const seen = new Map();
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1c1917;color:#fff;padding:10px 18px;border-radius:999px;font:600 14px system-ui;box-shadow:0 6px 24px #0006;cursor:pointer';
  document.body.appendChild(box);
  let stop = false;
  box.onclick = () => { stop = true; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const grab = () => document.querySelectorAll('article[data-testid="tweet"]').forEach(a => {
    const link = [...a.querySelectorAll('a[href*="/status/"]')].find(l => l.querySelector('time'));
    if (!link) return;
    const url = link.href.split('?')[0].replace('twitter.com', 'x.com');
    if (seen.has(url)) return;
    const t = a.querySelector('[data-testid="tweetText"]');
    const text = t ? t.innerText.trim() : '';
    if (!text) return;
    const parts = (a.querySelector('[data-testid="User-Name"]')?.innerText || '').split('\n');
    const name = parts[0] || '';
    const handle = parts.find(p => p.startsWith('@')) || '';
    seen.set(url, {
      text, url, source: 'twitter',
      author: handle ? `${name} (${handle})` : name,
      title: `Tweets from ${handle || name}`,
      highlightedAt: Date.parse(link.querySelector('time').getAttribute('datetime')) || null,
    });
  });
  let idle = 0;
  while (!stop && idle < 8) {
    const before = seen.size;
    grab();
    box.textContent = `Collected ${seen.size} tweets… tap to stop`;
    window.scrollBy(0, window.innerHeight * 0.85);
    await sleep(1300);
    grab();
    idle = seen.size === before ? idle + 1 : 0;
  }
  const data = JSON.stringify({ app: 'marginalia', highlights: [...seen.values()] });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `x-${location.pathname.includes('likes') ? 'likes' : 'bookmarks'}.json`;
  a.click();
  box.textContent = `Done: ${seen.size} tweets downloaded. Tap to also copy to clipboard`;
  box.onclick = async () => { await navigator.clipboard.writeText(data); box.textContent = 'Copied ✓'; setTimeout(() => box.remove(), 1500); };
})();
