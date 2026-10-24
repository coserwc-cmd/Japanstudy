import assert from 'node:assert/strict';
import {statSync, existsSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {emptyState, normalize, isCorrect, recordAttempt, scoreQuestions, validateBank, validateBackup, dayKey, streak, validateQuestion} from '../assets/core.js';
import {VOCAB, KANJI, VERBS, VERB_FORMS, makeVerbQuestion} from '../assets/word-data.js';
import {GRAMMAR} from '../assets/grammar-data.js';
import {EXAM_VOCAB, EXAM_GRAMMAR_READING} from '../assets/exam-written.js';
import {EXAM_LISTENING} from '../assets/exam-listening.js';
import {OFFICIAL_BANKS} from '../assets/official-banks.js';

const tests=[];
function test(name, fn) {fn();tests.push(name);console.log('PASS',name);}
const question={id:'example',kind:'input',subject:'verb',level:'N4',prompt:'「書く」の可能形',answer:'書ける',accepted:['かける','書ける'],explanation:'五段动词的う段变为え段，加る。'};
test('Japanese answers accept equivalent width/kana while rejecting different forms',()=>{
 assert.equal(normalize(' ｶｹﾙ。 '),'かける');
 assert(isCorrect(question,' ｶｹﾙ。 '));assert(isCorrect(question,'書ける'));
 assert(!isCorrect(question,'書かれる'));assert(!isCorrect(question,''));
});
test('An attempt is counted once; mistakes require two consecutive correct reviews',()=>{
 const state=emptyState();
 recordAttempt(state,question,'書く','first');recordAttempt(state,question,'書く','first');
 assert.equal(state.attempts.length,1);assert.equal(state.mistakes.example.wrongCount,1);
 recordAttempt(state,question,'書ける','second');assert.equal(state.mistakes.example.correctStreak,1);
 recordAttempt(state,question,'かける','third');assert.equal(state.mistakes.example.correctStreak,2);
 recordAttempt(state,question,'書く','fourth');assert.equal(state.mistakes.example.correctStreak,0);assert.equal(state.mistakes.example.wrongCount,2);
});
test('Exam unanswered questions are wrong and reading/listening scores stay separate',()=>{
 const reading={...question,id:'r',kind:'choice',subject:'reading',answer:'答え'};
 const listening={...reading,id:'l',subject:'listening'};
 const score=scoreQuestions([question,reading,listening],{example:{value:'かける'},r:{value:'間違い'}});
 assert.equal(score.total,3);assert.equal(score.correct,1);assert.equal(score.answered,2);
 assert.deepEqual(score.groups.listening,{total:1,correct:0,answered:0});
});
test('Streak counts local calendar dates, including a run ending yesterday',()=>{
 const now=new Date(2026,9,18,12);const yesterday=new Date(2026,9,17,12);const previous=new Date(2026,9,16,12);
 assert.equal(streak([{day:dayKey(yesterday)},{day:dayKey(previous)}],now),2);
 assert.equal(streak([{day:dayKey(now)},{day:dayKey(yesterday)}],now),2);
});
test('All original questions have unique IDs, valid answers and complete teaching data',()=>{
 const questions=[...GRAMMAR,...EXAM_VOCAB,...EXAM_GRAMMAR_READING,...EXAM_LISTENING];
 assert.equal(new Set(questions.map(q=>q.id)).size,questions.length);
 questions.forEach(validateQuestion);
 assert.equal(GRAMMAR.length,220);assert.equal(EXAM_VOCAB.length,35);assert.equal(EXAM_GRAMMAR_READING.length,39);assert.equal(EXAM_LISTENING.length,28);
 for(const q of GRAMMAR) for(const option of q.options) if(option!==q.answer) assert(q.distractorExplanations[option]?.length>5);
 for(const level of ['N5','N4','N3']) {assert.equal(VOCAB.filter(q=>q.level===level).length,level==='N3'?300:30);assert.equal(KANJI.filter(q=>q.level===level).length,level==='N3'?180:20);assert.equal(GRAMMAR.filter(q=>q.level===level).length,level==='N3'?100:60);}
});
test('Conjugations distinguish exceptional godan, ichidan and irregular verbs',()=>{
 const verb=word=>VERBS.find(v=>v.word===word);
 const result=(word,form)=>makeVerbQuestion(verb(word),form);
 assert.equal(result('行く','te').answer,'行って');assert.equal(result('ある','nai').answer,'ない');
 assert.equal(result('切る','te').answer,'切って');assert.equal(result('着る','te').answer,'着て');
 assert(result('来る','potential').accepted.includes('こられる'));
 assert.equal(result('する','potential').answer,'できる');
 assert.equal(result('食べる','potential').answer,'食べられる');
 assert(!isCorrect(result('食べる','potential'),'食べれる'));
 for(const v of VERBS) for(const f of VERB_FORMS) {const q=makeVerbQuestion(v,f.id);if(q)validateQuestion(q);}
});
const sample=JSON.parse(await readFile(new URL('../assets/import-example.json',import.meta.url)));
test('Imported exam validates sections, answer presence, ID safety and listening script',()=>{
 const bank=validateBank(sample);assert.equal(bank.total,3);assert.equal(bank.sections[1].minutes,70);
 const clone=()=>structuredClone(sample);
 let invalid=clone();invalid.sections[0].questions[0].answer='not an option';assert.throws(()=>validateBank(invalid));
 invalid=clone();invalid.sections[0].questions[0].id='__proto__';assert.throws(()=>validateBank(invalid));
 invalid=clone();invalid.sections[2].questions[0].audioText='';assert.throws(()=>validateBank(invalid));
 invalid=clone();invalid.sections[1].questions[0].subject='listening';assert.throws(()=>validateBank(invalid));
});
const officialListening={...sample.sections[2].questions[0],id:'official-2018-listening-1',
 pageImages:['assets/official/2018/pages/N3L-02.webp'],answerImages:['assets/official/2018/pages/N3answer-01.png'],
 scriptImages:['assets/official/2018/pages/N3script-02.webp'],audioSrc:'assets/official/2018/audio/N3Q1.mp3',
 audioGroup:'official-2018-Q1',audioLabel:'2018 官方试题集 · 听力問題1',sourceLabel:'JLPT 官方试题集第二集',
 sourceUrl:'https://www.jlpt.jp/samples/sample2018/pdf/N3L.pdf',officialNumber:'問題1・1'};
delete officialListening.audioText;
test('Official listening imports preserve original recordings and page references without a TTS script',()=>{
 const raw=structuredClone(sample);raw.sections[2].questions=[structuredClone(officialListening)];
 const imported=validateBank(raw).sections[2].questions[0];
 assert.equal(imported.audioText,undefined);
 for(const key of ['pageImages','answerImages','scriptImages','audioSrc','audioGroup','audioLabel','sourceLabel','sourceUrl','officialNumber']) assert.deepEqual(imported[key],officialListening[key]);
 raw.sections[2].questions[0].pageImages.push('assets/official/2018/pages/another.webp');
 assert.equal(imported.pageImages.length,1);
 const silent={...officialListening};delete silent.audioSrc;
 assert.throws(()=>validateQuestion(silent));
});
test('Imported media reject external URLs, traversal, executable types and malformed arrays',()=>{
 const invalidPaths=['../2018/p01.webp','assets/official/../private/p01.webp','/assets/official/2018/p01.webp',
  'https://www.jlpt.jp/p01.webp','//evil.test/p01.webp','data:image/png;base64,abc',
  'assets/official/2018/%2e%2e/p01.webp','assets/official/2018/p01.svg','assets/official/2018/p01.webp?x=1',
  'assets/official/2018/p01.webp#fragment','assets/official/2018/p01.webp\n','assets/official/2018\\p01.webp'];
 for(const key of ['pageImages','answerImages','scriptImages']) {
  for(const path of invalidPaths) assert.throws(()=>validateQuestion({...officialListening,[key]:[path]}),`${key}: ${path}`);
  for(const value of [null,'assets/official/2018/p01.webp',[null],Array(21).fill('assets/official/2018/p01.webp')]) assert.throws(()=>validateQuestion({...officialListening,[key]:value}));
 }
 for(const path of [...invalidPaths.map(path=>path.replaceAll('.webp','.mp3')),null,'','assets/official/2018/audio/N3Q1.wav']) assert.throws(()=>validateQuestion({...officialListening,audioSrc:path}));
 for(const sourceUrl of ['http://www.jlpt.jp/samples/','https://www.jlpt.jp.evil.test/','https://www.jlpt.jp@evil.test/',
  'https://user@www.jlpt.jp/','https://www.jlpt.jp:8080/','javascript:alert(1)','https://www.jlpt.jp/\n']) assert.throws(()=>validateQuestion({...officialListening,sourceUrl}));
});
test('Official mistakes and imported banks survive backup restoration with media intact',()=>{
 const state=emptyState();const wrong=officialListening.options.find(option=>option!==officialListening.answer);
 recordAttempt(state,officialListening,wrong,'official-session');
 const raw=structuredClone(sample);raw.sections[2].questions=[structuredClone(officialListening)];
 state.banks.push({...validateBank(raw),id:'imported-official'});
 const backup=JSON.parse(JSON.stringify({type:'hiyori-backup',state}));
 const restored=validateBackup(backup);
 assert.deepEqual(restored.mistakes[officialListening.id].question,officialListening);
 assert.equal(restored.mistakes[officialListening.id].lastAnswer,wrong);
 assert.equal(restored.banks[0].sections[2].questions[0].audioSrc,officialListening.audioSrc);
 assert.deepEqual(restored.banks[0].sections[2].questions[0].scriptImages,officialListening.scriptImages);
 backup.state.mistakes[officialListening.id].question.audioSrc='https://evil.test/track.mp3';
 assert.throws(()=>validateBackup(backup));
});
test('Both official workbooks validate all 201 questions with existing source pages, answers and recordings',()=>{
 assert.deepEqual(OFFICIAL_BANKS.map(bank=>bank.year),[2012,2018]);
 assert.deepEqual(OFFICIAL_BANKS.map(bank=>bank.sections.map(section=>section.questions.length)),[[33,39,27],[35,39,28]]);
 const questions=OFFICIAL_BANKS.flatMap(bank=>bank.sections.flatMap(section=>section.questions));
 assert.equal(questions.length,201);assert.equal(new Set(questions.map(q=>q.id)).size,201);
 const media=new Set();const recordings=new Set();const sourceDocuments=new Set();
 for(const bank of OFFICIAL_BANKS) {
  const checked=validateBank({schemaVersion:1,...bank});
  assert.equal(checked.total,bank.total);
  assert.match(bank.description,/出版年份/);
  assert.deepEqual(bank.sections.slice(0,2).map(section=>section.minutes),[30,70]);
  assert.equal(bank.sections[2].minutes,Math.ceil(bank.audioDurationSeconds/60));
  assert.equal(new Set(bank.sections[2].questions.map(q=>q.audioGroup)).size,5);
  const resourcePaths=new Set(bank.resources.map(resource=>resource.path));
  const groupTracks=new Map();
  for(const resource of bank.resources) {
   assert.match(resource.path,/^assets\/official\/\d{4}\/[a-zA-Z0-9_-]+\.(?:pdf|mp3)$/);
   const file=new URL(`../${resource.path}`,import.meta.url);
   assert(Number.isInteger(resource.bytes)&&resource.bytes>0);
   assert.match(resource.sha256,/^[a-f0-9]{64}$/);
   assert.match(resource.sourceUrl,/^https:\/\/www\.jlpt\.jp\/samples\//);
   if(!resource.path.endsWith('.mp3')||existsSync(file)){
    assert.equal(statSync(file).size,resource.bytes);
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),resource.sha256);
   }
   if(resource.path.endsWith('.pdf')) sourceDocuments.add(resource.path);
  }
  for(const section of bank.sections) for(const q of section.questions) {
   validateQuestion(q);
   assert(q.pageImages.length>0,`${q.id} has a source page`);
   assert(q.answerImages.length>0,`${q.id} has the official answer key`);
   assert(q.sourceLabel.includes(String(bank.year)));
   for(const key of ['pageImages','answerImages','scriptImages']) for(const path of q[key]||[]) media.add(path);
   if(q.subject==='listening') {
    assert.equal(q.audioText,undefined);
    assert(q.scriptImages.length>0,`${q.id} has the official transcript`);
    assert(resourcePaths.has(q.audioSrc),`${q.id} uses a listed original recording`);
    if(groupTracks.has(q.audioGroup)) assert.equal(groupTracks.get(q.audioGroup),q.audioSrc);
    groupTracks.set(q.audioGroup,q.audioSrc);recordings.add(q.audioSrc);media.add(q.audioSrc);
   }
  }
 }
 assert.equal(recordings.size,10);assert.equal(sourceDocuments.size,14);
 for(const path of media) {
  if(path.endsWith('.mp3'))continue; // Public audio is served by the official site or imported on-device.
  const file=statSync(new URL(`../${path}`,import.meta.url));
  assert(file.isFile()&&file.size>0,`Referenced media exists: ${path}`);
 }
});
test('Every official question survives mistake backup restoration with its complete media and source metadata',()=>{
 const questions=OFFICIAL_BANKS.flatMap(bank=>bank.sections.flatMap(section=>section.questions));
 const state=emptyState();
 for(const q of questions) recordAttempt(state,q,q.options.find(option=>option!==q.answer),'official-full-backup');
 const restored=validateBackup(JSON.parse(JSON.stringify({type:'hiyori-backup',state})));
 assert.equal(restored.attempts.length,201);assert.equal(Object.keys(restored.mistakes).length,201);
 assert.deepEqual(restored.banks,[]);
 for(const q of questions) {
  assert.deepEqual(restored.mistakes[q.id].question,q);
  assert.equal(restored.mistakes[q.id].wrongCount,1);
  assert.equal(restored.mistakes[q.id].correctStreak,0);
 }
});
test('Backups round-trip study progress but reject executable markup in numeric history fields',()=>{
 const state=emptyState();recordAttempt(state,question,'書く','sample');
 state.history.push({id:'run',title:'Practice',mode:'practice',time:Date.now(),correct:0,total:1});
 const restored=validateBackup({type:'hiyori-backup',state});assert.equal(restored.attempts.length,1);assert.equal(restored.mistakes.example.wrongCount,1);
 state.history[0].correct='<img src=x onerror=alert(1)>';
 assert.throws(()=>validateBackup({type:'hiyori-backup',state}));
});
console.log(`\n${tests.length} checks passed.`);
