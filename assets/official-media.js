import {OFFICIAL_BANKS} from './official-banks.js';

// Public pages play the publisher's recording directly. A personal copy chosen
// by the learner stays in this browser; it is never uploaded to the site.
const CACHE_NAME = 'hiyori-official-v1';
const APP_BASE = new URL('../', import.meta.url);
const records = new Map(OFFICIAL_BANKS.flatMap(bank => bank.resources
  .filter(resource => resource.path.endsWith('.mp3'))
  .map(resource => [resource.path, {...resource, bankId:bank.id}])));
const available = new Set();
const importing = new Set();
let initialized = false, initPromise = null;

function supported() {
  return !!(globalThis.isSecureContext && globalThis.caches &&
    globalThis.navigator?.serviceWorker && globalThis.crypto?.subtle);
}
function resourceURL(path) { return new URL(path, APP_BASE).href; }
function recordings(bankId) {
  if (!OFFICIAL_BANKS.some(bank => bank.id === bankId)) throw Error('没有找到这套官方试题。');
  return [...records.values()].filter(resource => resource.bankId === bankId);
}
export function officialAudioStatus(bankId) {
  const resources = recordings(bankId);
  return {initialized, supported:supported(), imported:resources.filter(r => available.has(r.path)).length,
    total:resources.length, available:resources.filter(r => available.has(r.path)).map(r => r.path)};
}
export async function initOfficialMedia() {
  if (!initPromise) initPromise = (async () => {
    available.clear();
    if (supported()) {
      try {
        const cache = await caches.open(CACHE_NAME);
        for (const resource of records.values()) {
          const response = await cache.match(resourceURL(resource.path));
          if (response?.status === 200 && response.headers.get('Content-Type')?.split(';')[0] === 'audio/mpeg' &&
              response.headers.get('X-Hiyori-SHA256') === resource.sha256 &&
              Number(response.headers.get('Content-Length')) === resource.bytes) available.add(resource.path);
        }
      } catch { /* Private browsing or storage restrictions leave online audio available. */ }
    }
    initialized = true;
    return {initialized, supported:supported(), counts:Object.fromEntries(
      OFFICIAL_BANKS.map(bank => [bank.id, officialAudioStatus(bank.id).imported]))};
  })();
  return initPromise;
}
export function audioSource(localPath) {
  const resource = records.get(localPath);
  if (!resource) return localPath;
  return available.has(localPath) && globalThis.navigator?.serviceWorker?.controller
    ? resourceURL(localPath) : resource.sourceUrl;
}

async function requireOfflineSupport() {
  if (!supported()) throw Error('本机音频导入需要 HTTPS，以及支持离线存储的浏览器。请使用 Safari 或 Chrome 打开此网站。');
  const serviceWorker = navigator.serviceWorker;
  let timer;
  try {
    await Promise.race([
      serviceWorker.ready,
      new Promise((_, reject) => {timer = setTimeout(() => reject(Error('离线服务尚未就绪，请刷新页面后重试。')), 8000);}),
    ]);
  } finally {clearTimeout(timer);}
  if (serviceWorker.controller) return;
  await new Promise((resolve, reject) => {
    const changed = () => {if (serviceWorker.controller) {cleanup();resolve();}};
    const timeout = setTimeout(() => {cleanup();reject(Error('离线服务尚未接管当前页面，请刷新后再导入。'));}, 8000);
    const cleanup = () => {clearTimeout(timeout);serviceWorker.removeEventListener('controllerchange', changed);};
    serviceWorker.addEventListener('controllerchange', changed);
    changed();
  });
}

export async function importOfficialAudio(bankId, files, onProgress = () => {}) {
  const resources = recordings(bankId), selected = Array.from(files || []);
  if (!selected.length) throw Error('请选择从官网保存的 N3Q1.mp3 至 N3Q5.mp3，可分次导入。');
  if (importing.has(bankId)) throw Error('这套录音正在导入，请等待完成。');
  importing.add(bankId);
  try {
    await requireOfflineSupport();
    await initOfficialMedia();
    let cache;
    try {cache = await caches.open(CACHE_NAME);}
    catch {throw Error('此浏览器无法保存离线音频，请退出隐私浏览或允许网站储存后重试。');}
    const seen = new Set(), rejected = [];
    let imported = 0, completed = 0;
    for (const file of selected) {
      const name = String(file.name || ''), resource = resources.find(r => r.path.split('/').pop().toLowerCase() === name.toLowerCase());
      let reason = '';
      if (!resource) reason = '请选择这套试题的 N3Q1.mp3 至 N3Q5.mp3。';
      else if (seen.has(resource.path)) reason = '同一个录音重复选择。';
      else if (file.size !== resource.bytes) reason = '文件大小与此卷官网原版不符，请确认年份和文件是否下载完整。';
      else {
        seen.add(resource.path);
        try {
          const bytes = await file.arrayBuffer();
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
          if (hash !== resource.sha256) reason = '文件内容与此卷官网原版不符，请重新下载对应录音。';
          else {
            await cache.put(resourceURL(resource.path), new Response(bytes, {status:200, headers:{
              'Content-Type':'audio/mpeg', 'Content-Length':String(bytes.byteLength),
              'Accept-Ranges':'bytes', 'X-Hiyori-SHA256':hash,
            }}));
            available.add(resource.path);
            imported++;
          }
        } catch (error) {
          reason = error?.name === 'QuotaExceededError' ? '浏览器储存空间不足，请清理空间后重试。' : '文件读取或本机保存失败，请重试。';
        }
      }
      if (reason) rejected.push({name, reason});
      completed++;
      onProgress({completed, total:selected.length, imported, rejected:rejected.length, name});
    }
    return {imported, available:officialAudioStatus(bankId).imported, total:resources.length, rejected};
  } finally {importing.delete(bankId);}
}
