import assert from 'node:assert/strict';
import {emptyState,recordAttempt,setStarred,validateBackup} from '../assets/core.js';
import {mergeStates,toSyncDocument,stableJSON,validateSyncDocument} from '../assets/sync-model.js';
const q={id:'sync-example',kind:'input',subject:'verb',level:'N4',prompt:'書くの可能形',answer:'書ける',explanation:'く→ける'};
const tests=[];
const test=(name,fn)=>{fn();tests.push(name);console.log('PASS',name);};
const same=(a,b)=>assert.equal(stableJSON(toSyncDocument(a)),stableJSON(toSyncDocument(b)));
test('Two offline devices merge attempts once and recompute consecutive reviews',()=>{
 const start=emptyState();recordAttempt(start,q,'書く','original',100);
 const a=structuredClone(start),b=structuredClone(start);
 recordAttempt(a,q,'書ける','phone',200);recordAttempt(b,q,'書ける','tablet',300);
 const ab=mergeStates(a,toSyncDocument(b)),ba=mergeStates(b,toSyncDocument(a));
 same(ab,ba);same(ab,mergeStates(ab,toSyncDocument(a)));same(ab,mergeStates(ab,toSyncDocument(ab)));
 assert.equal(ab.attempts.length,3);assert.equal(ab.mistakes[q.id].wrongCount,1);assert.equal(ab.mistakes[q.id].correctStreak,2);
 recordAttempt(b,q,'別の誤答','tablet-later',400);
 const next=mergeStates(ab,toSyncDocument(b));
 assert.equal(next.mistakes[q.id].wrongCount,2);assert.equal(next.mistakes[q.id].correctStreak,0);assert.equal(next.mistakes[q.id].lastAnswer,'別の誤答');
});
test('Cancelling a star survives offline merging, repeated sync and backup restoration',()=>{
 const a=emptyState();setStarred(a,q,true,100);
 const b=structuredClone(a);setStarred(b,q,false,200);recordAttempt(a,q,'違う','phone',300);
 const merged=mergeStates(a,toSyncDocument(b));
 assert.equal(merged.mistakes[q.id].starred,false);assert.equal(merged.mistakes[q.id].starredAt,200);
 const restored=validateBackup({type:'hiyori-backup',state:merged});
 same(merged,mergeStates(restored,toSyncDocument(a)));
 const c=emptyState();setStarred(c,q,true,200);
 assert.equal(mergeStates(b,toSyncDocument(c)).mistakes[q.id].starred,false);
});
test('Merging does not change a running local exam, preferences or personal banks',()=>{
 const a=emptyState();a.settings.goal=30;a.session={id:'running',deadline:900};a.lastResult={id:'local'};a.banks=[{id:'private'}];
 const b=emptyState();recordAttempt(b,q,'bad','other',100);
 const merged=mergeStates(a,toSyncDocument(b));
 assert.equal(merged.session,a.session);assert.equal(merged.lastResult,a.lastResult);assert.equal(merged.settings,a.settings);assert.equal(merged.banks,a.banks);
 assert.deepEqual(Object.keys(toSyncDocument(merged)).sort(),['attempts','history','mistakes','version']);
});
test('Old records without answers or star timestamps keep their progress',()=>{
 const a=emptyState();recordAttempt(a,q,'wrong','legacy',100);
 delete a.attempts[0].answer;delete a.attempts[0].questionId;a.mistakes[q.id].starred=true;
 const b=mergeStates(emptyState(),toSyncDocument(a));
 assert.equal(b.mistakes[q.id].wrongCount,1);assert.equal(b.mistakes[q.id].lastAnswer,'wrong');assert.equal(b.mistakes[q.id].starred,true);
 assert.equal(b.mistakes[q.id].starredAt,0);
});
test('Restore into a connected account merges rather than deleting newer cloud attempts',()=>{
 const old=emptyState();recordAttempt(old,q,'wrong','backup',100);
 const cloud=structuredClone(old);recordAttempt(cloud,q,'書ける','new',200);
 assert.equal(mergeStates(old,toSyncDocument(cloud)).attempts.length,2);
});
test('Three-device merge converges independently of arrival order',()=>{
 const all=[emptyState(),emptyState(),emptyState()];
 all.forEach((s,i)=>{recordAttempt(s,q,i===1?'wrong':'書ける','device-'+i,(i+1)*100);setStarred(s,q,i!==2,100+i);});
 const [a,b,c]=all;
 const abc=mergeStates(mergeStates(a,toSyncDocument(b)),toSyncDocument(c));
 const cab=mergeStates(mergeStates(c,toSyncDocument(a)),toSyncDocument(b));
 const acb=mergeStates(a,toSyncDocument(mergeStates(c,toSyncDocument(b))));
 same(abc,cab);same(abc,acb);
});
test('Tied timestamps and differently shuffled question metadata still converge',()=>{
 let seed=40;
 const random=()=>((seed=(Math.imul(1664525,seed)+1013904223)>>>0)/4294967296);
 const merge=(a,b)=>mergeStates(a,toSyncDocument(b));
 for(let trial=0;trial<100;trial++) {
  const [a,b,c]=[0,1,2].map(i=>{
   const state=emptyState(),question={...q,context:'version-'+i};
   for(let n=0;n<3;n++)recordAttempt(state,question,random()<.5?q.answer:'wrong-'+i,`s-${i}-${n}`,Math.floor(random()*4)+1);
   if(random()<.5)setStarred(state,question,random()<.5,Math.floor(random()*4)+1);
   return state;
  });
  same(merge(merge(a,b),c),merge(a,merge(b,c)));
  same(merge(merge(a,b),c),merge(merge(c,a),b));
 }
});
test('A legacy mark is retained when the other old device never changed its default flag',()=>{
 const a=emptyState();recordAttempt(a,q,'wrong','legacy',100);a.mistakes[q.id].starred=true;
 const b=structuredClone(a);b.mistakes[q.id].starred=false;
 assert.equal(mergeStates(a,toSyncDocument(b)).mistakes[q.id].starred,true);
 setStarred(b,q,false,200);
 assert.equal(mergeStates(a,toSyncDocument(b)).mistakes[q.id].starred,false);
});
test('Cloud documents reject malformed IDs, prototype keys, counts and external media',()=>{
 const s=emptyState();recordAttempt(s,q,'bad','one',100);const raw=toSyncDocument(s);
 for(const modify of [
  x=>x.attempts[0].questionId='__proto__',x=>x.attempts[0].time=Infinity,
  x=>x.mistakes[q.id].wrongCount=-1,x=>x.mistakes[q.id].starredAt='tomorrow',
  x=>x.mistakes[q.id].question.audioSrc='https://bad.invalid/a.mp3',
 ]){const data=structuredClone(raw);modify(data);assert.throws(()=>validateSyncDocument(data));}
 const pollution=JSON.parse('{"version":1,"attempts":[],"history":[],"mistakes":{"__proto__":{}}}');
 assert.throws(()=>validateSyncDocument(pollution));assert.equal({}.polluted,undefined);
});
console.log(`\n${tests.length} sync-model checks passed.`);
