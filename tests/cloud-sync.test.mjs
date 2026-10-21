import assert from 'node:assert/strict';
import {emptyState,recordAttempt,setStarred,STORAGE_KEY} from '../assets/core.js';
import {createCloudSync,AUTH_KEY,accountKey,normalizeCode,codeCredentials} from '../assets/cloud-sync.js';
import {toSyncDocument} from '../assets/sync-model.js';

const q={id:'cloud-example',kind:'input',subject:'verb',level:'N4',prompt:'書くの可能形',answer:'書ける',explanation:'く→ける'};
const memory=()=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
function backend() {
 const accounts=new Map(), rows=new Map(), tokens=new Map();
 let next=0, offline=false, beforeWrite=null, beforeRead=null, signups=0;
 const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
 const fetcher=async(url,options)=>{
  if(offline)throw new TypeError('network');
  const path=new URL(url).pathname,body=JSON.parse(options.body);
  if(path==='/auth/v1/signup' || path==='/auth/v1/token') {
   let user;
   if(path.endsWith('signup')) {
    signups++;user={id:`${(++next).toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`,password:body.password};
    accounts.set(body.email,user);
   } else if(url.includes('refresh_token')) {
    user=[...accounts.values()].find(a=>`refresh-${a.id}`===body.refresh_token);
   } else user=accounts.get(body.email)?.password===body.password?accounts.get(body.email):null;
   if(!user)return response({error:'invalid_credentials'},400);
   const token=`token-${user.id}`;tokens.set(token,user.id);
   return response({user:{id:user.id},access_token:token,refresh_token:`refresh-${user.id}`,expires_in:3600});
  }
  if(path==='/rest/v1/rpc/hiyori_sync') {
   const userId=tokens.get(options.headers.Authorization?.replace('Bearer ',''));
   if(!userId)return response({},401);
   if(body.expected_revision<0 && beforeRead) {
    const hook=beforeRead;beforeRead=null;await hook(userId);
   }
   if(body.expected_revision>=0 && beforeWrite) {
    const hook=beforeWrite;beforeWrite=null;await hook(userId);
   }
   let row=rows.get(userId)||{revision:0,document:null};
   if(body.expected_revision>=0) {
    if(body.expected_revision!==row.revision)return response({ok:false,...row});
    row={revision:row.revision+1,document:structuredClone(body.document)};rows.set(userId,row);
   }
   return response({ok:true,...row});
  }
  throw new Error('Unexpected endpoint '+path);
 };
 return {fetcher,rows,setOffline:value=>offline=value,setBeforeWrite:hook=>beforeWrite=hook,setBeforeRead:hook=>beforeRead=hook,getSignups:()=>signups};
}
function device(server,storage=memory(),win=null) {
 let state=emptyState();
 const cloud=createCloudSync({getState:()=>state,applyState:value=>state=value,storage,fetcher:server.fetcher,
  config:{url:'https://test.invalid',publishableKey:'public-test'},win,doc:null});
 state=cloud.loadState();
 return {cloud,storage,get state(){return state;},set state(value){state=value;},
  answer:(id,answer,time)=>{recordAttempt(state,q,answer,id,time);state=cloud.persist(state);},
  star:(value,time)=>{setStarred(state,q,value,time);state=cloud.persist(state);}};
}
let count=0;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function bounded(promise) {
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Async regression check timed out')),5000))]);}
 finally{clearTimeout(timer);}
}
async function test(name,fn){await fn();count++;console.log('PASS',name);}
await test('Codes have a strict canonical format and a valid email local-part length',async()=>{
 const code='a0'.repeat(24);assert.equal(normalizeCode(code.toUpperCase().match(/.{6}/g).join('-')),code);
 const credentials=await codeCredentials(code);assert.equal(credentials.email.split('@')[0].length,48);
 assert.equal(credentials.password,code);assert.throws(()=>normalizeCode('wrong'));assert.throws(()=>normalizeCode(code+'a'));
});
await test('Two devices converge after independent offline answers and star cancellation',async()=>{
 const server=backend(),a=device(server),b=device(server);
 try {
  a.answer('old','wrong',100);
  const code=await a.cloud.create();await b.cloud.join(code);
  assert.equal(b.state.attempts.length,1);
  server.setOffline(true);
  a.answer('phone','書ける',200);b.answer('tablet','書ける',300);
  a.star(true,400);b.star(false,500);
  assert.equal(await a.cloud.syncNow(),false);assert.equal(a.state.attempts.length,2);
  server.setOffline(false);
  await Promise.all([a.cloud.syncNow(),b.cloud.syncNow()]);await a.cloud.syncNow();await b.cloud.syncNow();
  assert.equal(a.state.attempts.length,3);assert.equal(b.state.attempts.length,3);
  assert.equal(a.state.mistakes[q.id].correctStreak,2);assert.equal(a.state.mistakes[q.id].wrongCount,1);
  assert.equal(a.state.mistakes[q.id].starred,false);assert.equal(b.state.mistakes[q.id].starred,false);
 } finally {a.cloud.dispose();b.cloud.dispose();}
});
await test('An answer made during upload is retained and uploaded before synced is reported',async()=>{
 const server=backend(),a=device(server);
 try {
  await a.cloud.create();a.answer('first','wrong',100);
  server.setBeforeWrite(async()=>a.answer('during-upload','書ける',200));
  await a.cloud.syncNow();
  assert.equal(a.state.attempts.length,2);
  assert.equal([...server.rows.values()][0].document.attempts.length,2);
  assert.equal(a.cloud.getStatus().phase,'synced');
 }finally{a.cloud.dispose();}
});
await test('Changes to the local state while signing in are not replaced by a stale snapshot',async()=>{
 const server=backend(),a=device(server);
 try{
  a.answer('before-restore','wrong',100);
  server.setBeforeRead(async()=>{a.state=emptyState();a.answer('restored-during-login','書ける',200);});
  await a.cloud.create();
  assert.deepEqual(a.state.attempts.map(x=>x.id),['restored-during-login:cloud-example']);
  assert.deepEqual([...server.rows.values()][0].document.attempts.map(x=>x.id),['restored-during-login:cloud-example']);
 }finally{a.cloud.dispose();}
});
await test('Joining preserves independent records and never uploads another account by default',async()=>{
 const server=backend(),a=device(server),b=device(server);
 try {
  a.answer('private-a','wrong',100);const codeA=await a.cloud.create();
  b.answer('independent-b','書ける',200);await b.cloud.join(codeA);
  assert.deepEqual(b.state.attempts.map(a=>a.id),['private-a:cloud-example']);
  b.cloud.disconnect();
  assert.deepEqual(b.state.attempts.map(a=>a.id),['independent-b:cloud-example']);
  assert.equal(b.storage.getItem(AUTH_KEY),null);
  const codeB=await b.cloud.create();
  assert.notEqual(codeB,codeA);assert.equal(server.rows.size,2);
  assert.deepEqual(b.state.attempts.map(a=>a.id),['independent-b:cloud-example']);
  b.cloud.disconnect();await b.cloud.join(codeA);
  assert.equal(b.state.attempts.length,1);assert.equal(b.state.attempts[0].id,'private-a:cloud-example');
 }finally{a.cloud.dispose();b.cloud.dispose();}
});
await test('Opting in merges local records; bad codes do not create an account or lose records',async()=>{
 const server=backend(),a=device(server),b=device(server);
 try {
  a.answer('a','wrong',100);const code=await a.cloud.create();
  b.answer('b','書ける',200);
  await assert.rejects(()=>b.cloud.join('f'.repeat(48)));
  assert.equal(server.getSignups(),1);assert.equal(b.state.attempts[0].id,'b:cloud-example');
  assert.equal(b.storage.getItem(AUTH_KEY),null);
  await b.cloud.join(code,{importLocal:true});await a.cloud.syncNow();
  assert.equal(a.state.attempts.length,2);assert.equal(b.state.attempts.length,2);
 }finally{a.cloud.dispose();b.cloud.dispose();}
});
await test('Reloaded account keeps local progress and refreshes an expired session',async()=>{
 const server=backend(),a=device(server);
 await a.cloud.create();a.answer('persisted','wrong',100);
 const stored=JSON.parse(a.storage.getItem(AUTH_KEY));stored.session.expires_at=0;a.storage.setItem(AUTH_KEY,JSON.stringify(stored));
 a.cloud.dispose();const restored=device(server,a.storage);
 try {
  assert.equal(restored.state.attempts.length,1);await restored.cloud.syncNow();
  assert.equal(restored.cloud.getStatus().phase,'synced');
  assert(JSON.parse(a.storage.getItem(AUTH_KEY)).session.expires_at>Date.now()/1000);
  assert.equal(JSON.parse(a.storage.getItem(accountKey(stored.userId))).attempts.length,1);
  assert.equal(JSON.parse(a.storage.getItem(STORAGE_KEY)).attempts.length,0);
 }finally{restored.cloud.dispose();}
});
await test('A delayed response after disconnect cannot replace independent records',async()=>{
 const server=backend(),a=device(server);
 try {
  a.answer('independent','wrong',100);await a.cloud.create();a.answer('account-only','書ける',200);
  server.setBeforeWrite(async()=>a.cloud.disconnect());
  await a.cloud.syncNow();
  assert.equal(a.cloud.getStatus().connected,false);
  assert.equal(a.state.attempts.length,1);
  assert.equal(a.state.attempts[0].id,'independent:cloud-example');
 }finally{a.cloud.dispose();}
});
await test('An old upload returning 401 cannot retry with a new account or delay its initial sync',async()=>{
 const server=backend(),b=device(server),entered=deferred(),release=deferred();
 let block=false,oldToken,leaked=false;
 const a=device({fetcher:async(url,options)=>{
  const body=JSON.parse(options.body),token=options.headers.Authorization;
  if(body.document?.attempts.some(x=>x.id==='private-a:cloud-example') && token!==oldToken)leaked=true;
  if(block && body.expected_revision>=0 && token===oldToken) {
   block=false;entered.resolve();await release.promise;
   return new Response('{}',{status:401});
  }
  return server.fetcher(url,options);
 }});
 try {
  b.answer('private-b','書ける',100);const codeB=await b.cloud.create();
  await a.cloud.create();oldToken='Bearer '+JSON.parse(a.storage.getItem(AUTH_KEY)).session.access_token;
  a.answer('private-a','wrong',200);block=true;
  const oldJob=a.cloud.syncNow();await bounded(entered.promise);
  a.cloud.disconnect();await bounded(a.cloud.join(codeB));
  assert.equal(a.cloud.getStatus().phase,'synced');
  release.resolve();assert.equal(await oldJob,false);
  assert.equal(leaked,false);assert.equal(a.cloud.getStatus().phase,'synced');
  const userB=JSON.parse(b.storage.getItem(AUTH_KEY)).userId;
  assert.deepEqual(server.rows.get(userB).document.attempts.map(x=>x.id),['private-b:cloud-example']);
 }finally{release.resolve();a.cloud.dispose();b.cloud.dispose();}
});
await test('Completing an old account job cannot clear the new account job and start a duplicate',async()=>{
 const server=backend(),b=device(server),oldEntered=deferred(),oldRelease=deferred(),newEntered=deferred(),newRelease=deferred();
 let oldToken,newToken,blockOld=false,watchNew=false,newReads=0;
 const a=device({fetcher:async(url,options)=>{
  const body=JSON.parse(options.body),token=options.headers.Authorization;
  if(blockOld && token===oldToken && body.expected_revision>=0) {
   blockOld=false;oldEntered.resolve();await oldRelease.promise;return new Response('{}',{status:401});
  }
  if(watchNew && token===newToken && body.expected_revision<0) {
   newReads++;
   if(newReads===2){newEntered.resolve();await newRelease.promise;}
  }
  return server.fetcher(url,options);
 }});
 try {
  const codeB=await b.cloud.create();newToken='Bearer '+JSON.parse(b.storage.getItem(AUTH_KEY)).session.access_token;
  await a.cloud.create();oldToken='Bearer '+JSON.parse(a.storage.getItem(AUTH_KEY)).session.access_token;
  a.answer('old-upload','wrong',100);blockOld=true;
  const oldJob=a.cloud.syncNow();await bounded(oldEntered.promise);a.cloud.disconnect();
  watchNew=true;const joining=a.cloud.join(codeB);await bounded(newEntered.promise);
  oldRelease.resolve();await oldJob;
  const sameJob=a.cloud.syncNow();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(newReads,2,'new account must keep its pending job after the old finally runs');
  newRelease.resolve();await bounded(Promise.all([joining,sameJob]));
  assert.equal(a.cloud.getStatus().phase,'synced');
 }finally{oldRelease.resolve();newRelease.resolve();a.cloud.dispose();b.cloud.dispose();}
});
await test('An account switch while waiting for a token prevents dispatch with the old token',async()=>{
 const server=backend(),b=device(server),entered=deferred(),release=deferred();
 let hold=false,oldToken,switched=false,staleRequests=0;
 const win={removeEventListener(){},navigator:{locks:{request:async(_name,callback)=>{
  const result=await callback();
  if(hold){hold=false;entered.resolve();await release.promise;}
  return result;
 }}}};
 const a=device({fetcher:(url,options)=>{
  if(switched && options.headers.Authorization===oldToken)staleRequests++;
  return server.fetcher(url,options);
 }},memory(),win);
 try {
  const codeB=await b.cloud.create();await a.cloud.create();
  oldToken='Bearer '+JSON.parse(a.storage.getItem(AUTH_KEY)).session.access_token;
  hold=true;const oldJob=a.cloud.syncNow();await bounded(entered.promise);
  a.cloud.disconnect();switched=true;await bounded(a.cloud.join(codeB));
  release.resolve();assert.equal(await oldJob,false);assert.equal(staleRequests,0);
 }finally{release.resolve();a.cloud.dispose();b.cloud.dispose();}
});
await test('A failed refresh after switching accounts cannot perform an old password fallback',async()=>{
 const server=backend(),b=device(server),entered=deferred(),release=deferred();
 let blockRefresh=false,oldPassword,switched=false,staleLogins=0;
 const a=device({fetcher:async(url,options)=>{
  const body=JSON.parse(options.body);
  if(switched && body.password===oldPassword)staleLogins++;
  if(blockRefresh && url.includes('grant_type=refresh_token')) {
   blockRefresh=false;entered.resolve();await release.promise;return new Response('{}',{status:400});
  }
  return server.fetcher(url,options);
 }});
 try {
  const codeB=await b.cloud.create();await a.cloud.create();
  const saved=JSON.parse(a.storage.getItem(AUTH_KEY));oldPassword=saved.code;saved.session.expires_at=0;
  a.storage.setItem(AUTH_KEY,JSON.stringify(saved));
  blockRefresh=true;const oldJob=a.cloud.syncNow();await bounded(entered.promise);
  a.cloud.disconnect();switched=true;await bounded(a.cloud.join(codeB));
  release.resolve();assert.equal(await oldJob,false);assert.equal(staleLogins,0);
  assert.equal(a.cloud.getStatus().phase,'synced');
 }finally{release.resolve();a.cloud.dispose();b.cloud.dispose();}
});
console.log(`\n${count} cloud-sync checks passed.`);
