// R&D Room service worker. It only serves files; syncing happens in the page, because iOS has no background sync
// and stops a service worker soon after the app closes.
const V = '3ff0bfc0464f1fa1';
const SHELL = 'rdroom-shell-' + V;
const FILES = ['index.html', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];
const BASE = new URL('./', self.location).pathname;

self.addEventListener('install', e => e.waitUntil((async () => {
  const c = await caches.open(SHELL);
  await c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })));
  await self.skipWaiting();
})()));

self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('rdroom-shell-') && k !== SHELL) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin) return;     // the write channel and everything else go straight out
  const p = u.pathname.slice(BASE.length);
  if (p.startsWith('data/') || p === 'pack.json' || p === 'version.json' || p === 'sw.js' || u.searchParams.has('__dl')) return;  // fresh or nothing; the page falls back to what it saved
  if (p.startsWith('games/')) return e.respondWith(game(r));
  if (r.mode === 'navigate') return e.respondWith(shellFile('index.html', r));
  e.respondWith(shellFile(p, r));
});

async function shellFile(name, r) {
  const c = await caches.open(SHELL);
  const hit = await c.match(name, { ignoreSearch: true });
  if (hit) return hit;
  return fetch(r);
}

async function game(r) {
  const hit = await caches.match(r.url, { ignoreSearch: true });
  if (!hit) {
    try { return await fetch(r); } catch (e) { return new Response('This game is not on the phone yet.', { status: 503 }); }
  }
  const range = r.headers.get('range');
  return range ? slice(hit, range) : hit;
}

// <audio> on iOS asks for byte ranges and refuses a plain 200, so cached media must answer with a 206.
async function slice(res, range) {
  const buf = await res.arrayBuffer(), total = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return new Response(buf, { status: 200, headers: res.headers });
  let a = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
  let b = m[1] === '' || m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  if (a >= total || a > b) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  return new Response(buf.slice(a, b + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${a}-${b}/${total}`,
      'Content-Length': String(b - a + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
