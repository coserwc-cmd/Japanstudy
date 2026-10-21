import {CLOUD_CONFIG} from './cloud-config.js';
import {STORAGE_KEY, emptyState} from './core.js';
import {mergeStates, toSyncDocument, stableJSON} from './sync-model.js';

export const AUTH_KEY = 'hiyori-cloud-auth-v1';
export const accountKey = userId => `${STORAGE_KEY}:account:${userId}`;
const uuidOK = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function normalizeCode(value) {
  const code = String(value).replace(/[\s-]/g,'').toLowerCase();
  if (!/^[a-f0-9]{48}$/.test(code)) throw new Error('请输入完整的 48 位同步码，可直接粘贴带空格或短横线的版本。');
  return code;
}
export const displayCode = code => normalizeCode(code).match(/.{6}/g).join('-');
export async function codeCredentials(value) {
  const code = normalizeCode(value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  const hash = [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  return {email:`${hash.slice(0,48)}@sync.hiyori.invalid`,password:code};
}

export function createCloudSync({getState,applyState,onStatus=()=>{},storage=globalThis.localStorage,
  fetcher=globalThis.fetch,config=CLOUD_CONFIG,win=globalThis.window,doc=globalThis.document}) {
  let auth=null, generation=0, job=null, timer=null, interval=null, lastFingerprint='', disposed=false;
  let savedKey=null, savedRaw=null;
  let status={connected:false,phase:'local',message:'仅保存在本设备',lastSyncedAt:null};
  const configured=Boolean(config?.url && config?.publishableKey);
  const emit = patch => {status={...status,...patch,connected:Boolean(auth?.userId),configured};onStatus({...status});};
  function readAuth() {
    const raw=storage.getItem(AUTH_KEY);
    if (!raw) return null;
    const a=JSON.parse(raw);
    if (a.version !== 1 || !uuidOK(a.userId) || !a.session || typeof a.session.access_token !== 'string') throw new Error('同步登录信息无法读取，请先导出记录，再重新连接。');
    normalizeCode(a.code);
    return a;
  }
  function parseState(raw) {
    if (!raw) return emptyState();
    const value=JSON.parse(raw);
    // Validate the synced subset, while retaining device-local settings/session.
    toSyncDocument(value);
    return {...emptyState(),...value,settings:{...emptyState().settings,...value.settings}};
  }
  function assertStorage() {
    const key='hiyori-storage-check';
    storage.setItem(key,'1');storage.removeItem(key);
  }
  function saveAuth(next) {storage.setItem(AUTH_KEY,JSON.stringify(next));auth=next;}
  function stillCurrent(id,epoch) {
    try {return !disposed && auth?.userId === id && generation === epoch && readAuth()?.userId === id;}
    catch {return false;}
  }
  function assertCurrent(id,epoch) {
    if (!stillCurrent(id,epoch)) throw new Error('同步账户已切换，请重试。');
  }
  function persist(next=getState(), {merge=true}={}) {
    const key=auth ? accountKey(auth.userId) : STORAGE_KEY;
    if (auth && merge) {
      const saved=storage.getItem(key);
      // Avoid rebuilding the entire answer ledger on every input keystroke.
      // A different stored value means another tab has saved additional work.
      if (saved && (key!==savedKey || saved!==savedRaw)) next=mergeStates(next,toSyncDocument(parseState(saved)));
    }
    const raw=JSON.stringify(next);
    storage.setItem(key,raw);
    savedKey=key;savedRaw=raw;
    return next;
  }
  function apply(next,reason) {
    next=persist(next);
    applyState(next,reason);
    return next;
  }
  function loadState() {
    auth=readAuth();
    savedKey=auth ? accountKey(auth.userId) : STORAGE_KEY;
    savedRaw=storage.getItem(savedKey);
    return parseState(savedRaw);
  }
  function networkError(error) {
    if (error?.name === 'AbortError') return '连接超时，记录已保存在本机，稍后会重试。';
    return error?.message || '暂时无法连接，记录已保存在本机。';
  }
  async function request(path, body, token) {
    const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),20000);
    try {
      const response=await fetcher(config.url+path,{
        method:'POST',cache:'no-store',credentials:'omit',signal:controller.signal,
        headers:{apikey:config.publishableKey,'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
        body:JSON.stringify(body),
      });
      let result;
      try {result=await response.json();} catch {throw new Error('同步服务返回异常，记录已保存在本机。');}
      if (!response.ok) {
        const error=new Error(response.status===429?'请求较频繁，请稍等一分钟再试。':
          path.startsWith('/auth/') && [400,401,422].includes(response.status)?'同步码未能登录，请检查是否完整。':
          response.status===401?'同步登录需要更新，请稍后重试。':
          '同步服务暂时不可用，记录已保存在本机。');
        error.status=response.status;throw error;
      }
      return result;
    } catch(error) {
      if (error instanceof TypeError) throw new Error('网络暂不可用，记录已保存在本机，联网后会自动重试。');
      throw error;
    } finally {clearTimeout(timeout);}
  }
  function sessionFrom(result) {
    if (!uuidOK(result?.user?.id) || typeof result.access_token !== 'string' || typeof result.refresh_token !== 'string') {
      throw new Error('同步服务尚未完成登录，当前记录保持不变。');
    }
    return {access_token:result.access_token,refresh_token:result.refresh_token,
      expires_at:result.expires_at || Math.floor(Date.now()/1000)+(result.expires_in || 3600)};
  }
  async function withLock(name,callback) {
    return win?.navigator?.locks ? win.navigator.locks.request(name,callback) : callback();
  }
  async function accessToken(id,epoch,force=false) {
    assertCurrent(id,epoch);
    return withLock('hiyori-auth-refresh',async()=>{
      assertCurrent(id,epoch);
      const latest=readAuth();
      if (!force && latest.session.expires_at > Date.now()/1000+90) {auth=latest;return latest.session.access_token;}
      // Another tab may already have refreshed while this request waited.
      if (force && latest.session.access_token !== auth.session.access_token) {auth=latest;return latest.session.access_token;}
      let result;
      try {result=await request('/auth/v1/token?grant_type=refresh_token',{refresh_token:latest.session.refresh_token});}
      catch(error) {
        assertCurrent(id,epoch);
        if (![400,401,422].includes(error.status)) throw error;
        const credentials=await codeCredentials(latest.code);
        assertCurrent(id,epoch);
        result=await request('/auth/v1/token?grant_type=password',credentials);
      }
      assertCurrent(id,epoch);
      const session=sessionFrom(result);
      if (result.user.id!==id) throw new Error('同步账户已切换，请重试。');
      saveAuth({...latest,session});
      return session.access_token;
    });
  }
  async function rpc(body,id,epoch) {
    // Bind the payload to its original account, including every retry. A 401
    // from an old request must never refresh or send with a new account token.
    let token=await accessToken(id,epoch);
    assertCurrent(id,epoch);
    try {
      const result=await request('/rest/v1/rpc/hiyori_sync',body,token);
      assertCurrent(id,epoch);
      return result;
    }
    catch(error) {
      assertCurrent(id,epoch);
      if (error.status!==401) throw error;
      token=await accessToken(id,epoch,true);
      assertCurrent(id,epoch);
      const result=await request('/rest/v1/rpc/hiyori_sync',body,token);
      assertCurrent(id,epoch);
      return result;
    }
  }
  function checkSnapshot(value) {
    if (!value || typeof value.ok !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision<0) throw new Error('云端记录格式异常，本机记录已保留。');
    return value;
  }
  async function runSync(force=true) {
    if (!auth || !configured || disposed) return false;
    if (win?.navigator?.onLine === false) {emit({phase:'offline',message:'离线练习中，联网后自动同步'});return false;}
    if (!force && stableJSON(toSyncDocument(getState()))===lastFingerprint) return true;
    const id=auth.userId, epoch=generation;
    emit({phase:'syncing',message:'正在同步…'});
    try {
      let remote=checkSnapshot(await rpc({expected_revision:-1},id,epoch));
      for (let tries=0;tries<5;tries++) {
        if (!stillCurrent(id,epoch)) return false;
        const merged=apply(mergeStates(getState(),remote.document),'merge');
        const document=toSyncDocument(merged), fingerprint=stableJSON(document);
        if (remote.document && fingerprint===stableJSON(toSyncDocument(mergeStates(emptyState(),remote.document)))) {
          lastFingerprint=fingerprint;
          emit({phase:'synced',message:'所有学习记录已同步',lastSyncedAt:Date.now()});
          return true;
        }
        remote=checkSnapshot(await rpc({expected_revision:remote.revision,document},id,epoch));
      }
      if (stillCurrent(id,epoch)) {
        apply(mergeStates(getState(),remote.document),'merge');
        emit({phase:'pending',message:'已合并新记录，正在完成同步…'});
        schedule();
      }
      return false;
    } catch(error) {
      if (stillCurrent(id,epoch)) emit({phase:'error',message:networkError(error)});
      return false;
    }
  }
  async function syncNow(force=true) {
    if (job && job.id===auth?.userId && job.epoch===generation) return job.promise;
    const currentJob={id:auth?.userId,epoch:generation,promise:null};
    job=currentJob;
    currentJob.promise=runSync(force);
    try {return await currentJob.promise;} finally {if(job===currentJob)job=null;}
  }
  function schedule() {
    if (!auth || disposed) return;
    clearTimeout(timer);
    timer=setTimeout(()=>{timer=null;syncNow(false);},900);
  }
  async function connect(code,create,importLocal) {
    if (!configured) throw new Error('云同步尚未配置。');
    if (auth) throw new Error('请先断开当前同步，再连接其他学习空间。');
    assertStorage();
    const epoch=generation;
    emit({phase:'connecting',message:create?'正在创建学习空间…':'正在连接学习空间…'});
    try {
      const credentials=await codeCredentials(code);
      const result=await request(create?'/auth/v1/signup':'/auth/v1/token?grant_type=password',credentials);
      const session=sessionFrom(result), userId=result.user.id;
      const snapshot=checkSnapshot(await request('/rest/v1/rpc/hiyori_sync',{expected_revision:-1},session.access_token));
      // The user may keep studying or restore a backup while login is in flight.
      const source=getState();
      let target=parseState(storage.getItem(accountKey(userId)));
      if (create || importLocal) {
        target={...mergeStates(source,toSyncDocument(target)),session:create?source.session:null,lastResult:create?source.lastResult:null};
      }
      target=mergeStates(target,snapshot.document);
      if (generation!==epoch || auth || readAuth()) throw new Error('其他窗口已连接账户，请刷新后重试。');
      // Only switch the visible account after login, validation and local writes succeed.
      storage.setItem(STORAGE_KEY,JSON.stringify(source));
      storage.setItem(accountKey(userId),JSON.stringify(target));
      saveAuth({version:1,userId,code:normalizeCode(code),session});
      generation++;
      applyState(target,'account');
      emit({phase:'pending',message:'已连接，正在同步记录…',lastSyncedAt:null});
      await syncNow();
      if(auth?.userId!==userId)throw new Error('此设备已断开或切换学习空间。');
      return displayCode(code);
    } catch(error) {
      emit({phase:auth?'error':'local',message:networkError(error)});
      throw error;
    }
  }
  async function create() {
    const bytes=crypto.getRandomValues(new Uint8Array(24));
    const code=[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
    return connect(code,true,true);
  }
  const join = (code,{importLocal=false}={}) => connect(normalizeCode(code),false,importLocal);
  function disconnect() {
    if (!auth) return;
    persist();
    // Keep this account's local progress for reconnection, remove its login/code.
    const anonymous=parseState(storage.getItem(STORAGE_KEY));
    storage.removeItem(AUTH_KEY);
    auth=null;generation++;lastFingerprint='';clearTimeout(timer);
    applyState(anonymous,'account');
    emit({phase:'local',message:'已断开同步，当前显示本机独立记录',lastSyncedAt:null});
  }
  const onOnline=()=>syncNow();
  const onVisible=()=>{if(doc?.visibilityState==='visible')syncNow();};
  function onStorage(event) {
    try {
      if (event.key===AUTH_KEY) {
        const latest=readAuth();
        if (latest?.userId===auth?.userId) {auth=latest;return;}
        // Save any in-memory work under its original owner before switching.
        persist();generation++;auth=latest;lastFingerprint='';
        applyState(parseState(storage.getItem(auth?accountKey(auth.userId):STORAGE_KEY)),'account');
        emit({phase:auth?'pending':'local',message:'同步账户已在另一个窗口更新',lastSyncedAt:null});
        syncNow();
      } else if (auth && event.key===accountKey(auth.userId) && event.newValue) {
        const next=mergeStates(getState(),toSyncDocument(parseState(event.newValue)));
        applyState(next,'merge');schedule();
      }
    } catch(error) {emit({phase:'error',message:networkError(error)});}
  }
  function init() {
    emit({phase:auth?'pending':'local',message:auth?'正在连接云端…':'仅保存在本设备'});
    win?.addEventListener('online',onOnline);
    win?.addEventListener('storage',onStorage);
    doc?.addEventListener('visibilitychange',onVisible);
    interval=setInterval(()=>{if(!doc || doc.visibilityState==='visible')syncNow();},30000);
    if (auth) syncNow();
  }
  function dispose() {
    disposed=true;generation++;clearTimeout(timer);clearInterval(interval);
    win?.removeEventListener('online',onOnline);win?.removeEventListener('storage',onStorage);
    doc?.removeEventListener('visibilitychange',onVisible);
  }
  return {loadState,persist,init,create,join,syncNow,schedule,disconnect,dispose,
    getStatus:()=>({...status,connected:Boolean(auth),configured,accountLabel:auth?.userId.slice(0,8)}),
    getCode:()=>auth?displayCode(auth.code):null};
}
