const CACHE = 'hiyori-static-v3';
const OFFICIAL_CACHE = 'hiyori-official-v1';
const FILES = [
  './', './index.html', './manifest.webmanifest',
  './assets/app.js', './assets/core.js', './assets/styles.css',
  './assets/word-data.js', './assets/grammar-data.js',
  './assets/exam-written.js', './assets/exam-listening.js',
  './assets/official-banks.js', './assets/official-player.js',
  './assets/official-media.js',
  './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png',
  './assets/import-example.json',
  './quizzes/lesson18.html', './quizzes/full-practice.html',
  './quizzes/full-data.js', './quizzes/full-app.js',
  './quizzes/keigo-choice.html', './quizzes/vocab-39.html',
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
  // A new version activates after old pages close, avoiding a mid-exam reload.
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('hiyori-static-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
const allowed = new Set(FILES.map(path => new URL(path, self.location.href).pathname));
const officialRoot = new URL('./assets/official/', self.location.href).pathname;
async function officialResponse(request) {
  const cache=await caches.open(OFFICIAL_CACHE);
  const fullRequest=new Request(request.url, {credentials:'same-origin'});
  let response=await cache.match(fullRequest);
  if(!response) {
    response=await fetch(fullRequest);
    if(response.status===200) {
      // A full response is needed for iOS audio byte-range requests, also offline.
      try {await cache.put(fullRequest,response.clone());} catch { /* Online playback still works if storage is full. */ }
    }
  }
  const range=request.headers.get('range');
  if(!range || response.status!==200)return response;
  const bytes=await response.arrayBuffer(), length=bytes.byteLength;
  const match=/^bytes=(\d*)-(\d*)$/.exec(range);
  let start=0,end=length-1;
  if(!match || (!match[1]&&!match[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${length}`}});
  if(!match[1])start=Math.max(0,length-Number(match[2]));
  else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
  if(start>=length||end<start)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${length}`}});
  return new Response(bytes.slice(start,end+1),{status:206,headers:{'Content-Type':response.headers.get('Content-Type')||'application/octet-stream','Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${length}`,'Content-Length':String(end-start+1)}});
}
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if(url.pathname.startsWith(officialRoot)) {event.respondWith(officialResponse(request));return;}
  if(!allowed.has(url.pathname))return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(request, {ignoreSearch:true});
      if (cached) return cached;
      throw error;
    }
  })());
});
