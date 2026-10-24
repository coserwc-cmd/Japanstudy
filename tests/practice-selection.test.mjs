import assert from 'node:assert/strict';
import {emptyState, recordAttempt} from '../assets/core.js';
import {mergeStates, toSyncDocument} from '../assets/sync-model.js';
import {getWordCoverage, selectWordEntries, getQuestionCoverage, selectPracticeQuestions} from '../assets/practice-selection.js';

const poolOf = (count, level='N3') => Array.from({length:count}, (_, i) => ({
  entry:{id:`v-${level.toLowerCase()}-${String(i + 1).padStart(2, '0')}`, level, word:`語${level}${i}`, reading:`よみ${i}`},
  subject:'vocab',
}));
const question = (item, format='input') => ({id:`${item.entry.id}-${format}`, subject:item.subject,
  level:item.entry.level, kind:'input', prompt:'読み方', answer:'よみ', explanation:'練習用の例。'});
const attempted = (item, time, format='input') => ({questionId:question(item, format).id, time});
const ids = items => items.map(item => item.entry.id);
const sameOrder = () => 0.999999;
let checks=0;
const test=(name, fn)=>{fn();checks++;console.log('PASS', name);};

test('Consecutive completed lessons visit new words before repeating correct or wrong answers', () => {
  const pool=poolOf(30), state=emptyState();
  const first=selectWordEntries(pool, 10, {random:sameOrder});
  first.forEach((item, i) => recordAttempt(state, question(item), i%2?'よみ':'まちがい', 'first', i + 1));
  const second=selectWordEntries(pool, 10, {attempts:state.attempts, random:sameOrder});
  assert.equal(second.length, 10);
  assert(second.every(item => !ids(first).includes(item.entry.id)));
  assert.deepEqual(getWordCoverage(pool, state.attempts), {total:30, seen:10, unseen:20});
});

test('Reading, meaning and input share coverage; legacy records work without counting unrelated IDs', () => {
  const pool=poolOf(4);
  const attempts=['reading','meaning','input'].map((format, i) => attempted(pool[0], i, format));
  attempts.push({id:`legacy:session:${question(pool[1], 'meaning').id}`, time:9});
  attempts.push({questionId:`official-${question(pool[2]).id}`, time:10});
  attempts.push({questionId:pool[3].entry.id+'-grammar', time:10});
  assert.deepEqual(getWordCoverage(pool, attempts), {total:4, seen:2, unseen:2});
  assert.deepEqual(ids(selectWordEntries(pool, 2, {attempts, random:sameOrder})), ids(pool.slice(2)));
});

test('An exhausted pool rotates by the latest attempt time, independent of ledger arrival order', () => {
  const pool=poolOf(4);
  const attempts=[attempted(pool[0],100), attempted(pool[1],20), attempted(pool[2],30), attempted(pool[3],40),
    attempted(pool[0],1,'meaning'), attempted(pool[1],20)];
  assert.deepEqual(ids(selectWordEntries(pool, 4, {attempts, random:sameOrder})), ids([pool[1],pool[2],pool[3],pool[0]]));
  assert.deepEqual(getWordCoverage(pool, attempts), {total:4, seen:4, unseen:0});
});

test('Unanswered recent lesson words are deferred without being counted as studied', () => {
  const pool=poolOf(5), recentQuestions=pool.slice(0,2).map(item => question(item));
  const attempts=[attempted(pool[4],20)];
  assert.deepEqual(ids(selectWordEntries(pool, 3, {attempts,recentQuestions,random:sameOrder})), ids(pool.slice(2)));
  const complete=selectWordEntries(pool, 10, {attempts,recentQuestions,random:sameOrder});
  assert.equal(new Set(ids(complete)).size, 5);
  assert.deepEqual(ids(complete.slice(3)), ids(pool.slice(0,2)));
  assert.deepEqual(getWordCoverage(pool, attempts), {total:5, seen:1, unseen:4});
});

test('Identical vocabulary and kanji words are one selection and share format history', () => {
  const pool=poolOf(3);
  const alias={entry:{...pool[0].entry,id:'k-n3-01'},subject:'kanji'};
  const mixed=[...pool,alias,pool[0]];
  const attempts=[attempted(alias,100,'reading')];
  assert.deepEqual(getWordCoverage(mixed,attempts), {total:3,seen:1,unseen:2});
  assert.deepEqual(ids(selectWordEntries(mixed,2,{attempts,random:sameOrder})),ids(pool.slice(1)));
  assert.equal(selectWordEntries(mixed,20).length,3);
});

test('Only supplied levels are selected and unusual counts do not duplicate or mutate entries', () => {
  const n3=poolOf(3), n4=poolOf(3,'N4');
  const attempts=[...n4.map(item=>attempted(item,100)), attempted(n3[0],1)];
  const before=JSON.stringify({n3,attempts});
  for(const count of [0,-3,NaN]) assert.deepEqual(selectWordEntries(n3,count),[]);
  assert.equal(selectWordEntries(n3,1.9).length,1);
  assert.equal(selectWordEntries(n3,Infinity).length,3);
  assert.deepEqual(selectWordEntries([],20),[]);
  assert(selectWordEntries(n3,20,{attempts}).every(item=>item.entry.level==='N3'));
  assert.deepEqual(getWordCoverage(n3,attempts),{total:3,seen:1,unseen:2});
  assert.equal(JSON.stringify({n3,attempts}),before);
});

test('Synced attempts from another device suppress that word in every format', () => {
  const pool=poolOf(5), phone=emptyState(), pad=emptyState();
  recordAttempt(phone,question(pool[0]),'よみ','phone',100);
  recordAttempt(pad,question(pool[0],'reading'),'まちがい','pad',200);
  recordAttempt(pad,question(pool[1],'meaning'),'よみ','pad',201);
  const merged=mergeStates(phone,toSyncDocument(pad));
  assert.deepEqual(getWordCoverage(pool,merged.attempts),{total:5,seen:2,unseen:3});
  assert.deepEqual(ids(selectWordEntries(pool,3,{attempts:merged.attempts,random:sameOrder})),ids(pool.slice(2)));
});

test('Injectable randomness changes ties but never promotes a repeated word ahead of an unseen one', () => {
  const pool=poolOf(8), attempts=[attempted(pool[0],100)];
  const left=selectWordEntries(pool,8,{attempts,random:()=>0.5});
  const right=selectWordEntries(pool,8,{attempts,random:sameOrder});
  assert.notDeepEqual(ids(left.slice(0,7)),ids(right.slice(0,7)));
  assert.equal(left.at(-1),pool[0]);assert.equal(right.at(-1),pool[0]);
});

const grammarPool = (count, level='N3') => Array.from({length:count}, (_, i) => ({
  id:`g-${level.toLowerCase()}-${String(i + 1).padStart(2,'0')}`, level, subject:'grammar',
  topic:'同じ文法の別の例', kind:'choice', prompt:'適切な助詞を選ぶ', answer:'に',
  options:['に','を','が','で'], explanation:'文中の使い方を確認する。',
}));

test('Grammar practice uses exact IDs and visits distinct examples of a shared topic', () => {
  const pool=grammarPool(6), state=emptyState();
  const first=selectPracticeQuestions(pool,3,{random:sameOrder});
  first.forEach((q,i)=>recordAttempt(state,q,i%2?'に':'を','grammar',i+1));
  assert.deepEqual(selectPracticeQuestions(pool,3,{attempts:state.attempts,random:sameOrder}),pool.slice(3));
  assert.deepEqual(getQuestionCoverage(pool,state.attempts),{total:6,seen:3,unseen:3});
  assert.deepEqual(getQuestionCoverage([pool[0],pool[0]],state.attempts),{total:1,seen:1,unseen:0});
});

test('Grammar history accepts legacy IDs without stripping word formats or counting another level', () => {
  const pool=grammarPool(4), other=grammarPool(2,'N4');
  const attempts=[{id:'legacy:'+pool[0].id,time:2},{questionId:pool[1].id,time:3},
    {questionId:pool[2].id+'-reading',time:4},{questionId:'v-n3-03-reading',time:5},
    {questionId:other[0].id,time:6}];
  assert.deepEqual(getQuestionCoverage(pool,attempts),{total:4,seen:2,unseen:2});
  assert.deepEqual(selectPracticeQuestions(pool,2,{attempts,random:sameOrder}),pool.slice(2));
  assert(selectPracticeQuestions(pool,20,{attempts}).every(q=>q.level==='N3'));
});

test('Exhausted grammar questions rotate by latest attempt and defer the previous lesson', () => {
  const pool=grammarPool(4), attempts=pool.map((q,i)=>({questionId:q.id,time:i+1}));
  attempts.push({questionId:pool[0].id,time:10});
  const before=JSON.stringify({pool,attempts});
  assert.deepEqual(selectPracticeQuestions(pool,4,{attempts,random:sameOrder}),[pool[1],pool[2],pool[3],pool[0]]);
  assert.deepEqual(selectPracticeQuestions(pool,2,{attempts,recentQuestions:[pool[1]],random:sameOrder}),[pool[2],pool[3]]);
  assert.equal(selectPracticeQuestions([...pool,pool[0]],20).length,4);
  assert.deepEqual(selectPracticeQuestions(pool,0),[]);
  assert.deepEqual(getQuestionCoverage([],attempts),{total:0,seen:0,unseen:0});
  assert.equal(JSON.stringify({pool,attempts}),before);
});

console.log(`\n${checks} practice-selection checks passed.`);
