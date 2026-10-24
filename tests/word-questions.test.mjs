import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {VOCAB,KANJI} from '../assets/word-data.js';
import {GRAMMAR} from '../assets/grammar-data.js';
import {wordQuestion,hasKanji} from '../assets/word-questions.js';
import {normalize,validateQuestion} from '../assets/core.js';

const all=[...VOCAB,...KANJI];
assert.equal(new Set(all.map(x=>x.id)).size,all.length);
assert.equal(new Set(all.map(x=>x.word+'\0'+x.reading)).size,all.length);
for(const row of all) {
  for(const field of ['word','reading','meaning','example','translation']) assert(row[field]?.trim(),`${row.id}: ${field}`);
  assert.match(row.reading,/^[ぁ-ゖァ-ヺー]+$/u,row.word);
}
console.log('PASS Expanded banks have unique stable entries, readings and complete examples');

// Verify the released ID-to-word mapping, not just a count: existing synced
// answers must never silently become progress for a different word/question.
// SHA-256 of JSON.stringify exports from published source commit 97f511a.
// Frozen fingerprints work in CI's shallow checkout without fetching history.
for(const [bank,oldCount,fingerprint] of [
  [VOCAB,30,'449e6aaf0d50d6457be7cd2c46bb5d732196b25504af99d250ac793ec002b29c'],
  [KANJI,20,'3ef4a16842a46d1ebb0427569ffaa63913dfdce187a3bb312ca6094f0f67af4e'],
]) {
  const oldEntries=bank.filter(x=>Number(x.id.split('-').at(-1))<=oldCount);
  assert.equal(createHash('sha256').update(JSON.stringify(oldEntries)).digest('hex'),fingerprint);
}
console.log('PASS Previously published vocabulary and kanji IDs retain their exact content');

for(const [subject,bank] of [['vocab',VOCAB],['kanji',KANJI]]) for(const entry of bank) {
  for(const type of ['input','reading','meaning']) for(let run=0;run<4;run++) {
    const q=wordQuestion(entry,subject,type);validateQuestion(q);
    if(q.kind==='choice') {
      assert.equal(q.options.length,4,entry.word);
      if(q.id.endsWith('-reading')) {
        const valid=[entry.reading,...(entry.acceptedReadings||[])].map(normalize);
        assert.equal(q.options.filter(x=>valid.includes(normalize(x))).length,1,entry.word);
      }
    }
    if(subject==='vocab'&&!hasKanji(entry)) assert(q.kind==='choice'&&q.id.endsWith('-meaning'),entry.word);
  }
}
console.log('PASS Generated question formats are valid; kana-only vocabulary never asks learners to copy its reading');

const give=VOCAB.find(x=>x.word==='与える');
for(let i=0;i<50;i++) {
  const q=wordQuestion({...give,meaningDistractor:'给予；提供'},'vocab','meaning');
  assert(!q.options.includes('给予；提供'));
}
console.log('PASS Distractors sharing a stated correct meaning are excluded');

assert.equal(new Set(GRAMMAR.map(q=>q.prompt)).size,GRAMMAR.length);
for(const q of GRAMMAR) {
  validateQuestion(q);
  assert(q.point && q.example && q.translation);
  for(const option of q.options) if(option!==q.answer) assert(q.distractorExplanations?.[option]?.length>5,q.id);
}
console.log('PASS Every grammar question has a distinct prompt, teaching and explanations for every wrong option');
