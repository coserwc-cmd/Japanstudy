import {VOCAB, KANJI} from './word-data.js';
import {normalize, shuffle} from './core.js';

export const hasKanji = entry => /[\u3400-\u9fff々]/u.test(entry.word);

function kanaDistractor(reading, accepted=[]) {
  const changes=[['し','じ'],['じ','し'],['つ','っ'],['っ','つ'],['か','が'],['が','か'],['き','ぎ'],['ぎ','き'],['う','ゅう'],['ょ','よ'],['ゃ','や'],['え','い'],['お','う']];
  for(const [a,b] of changes) if(reading.includes(a)) {
    const candidate=reading.replace(a,b);
    if(![reading,...accepted].some(x=>normalize(x)===normalize(candidate))) return candidate;
  }
  return reading.length>1?reading+'う':'あ'+reading;
}

// Exclude glosses sharing a stated meaning, such as “给予” and “给予；提供”.
// Contextual teaching meanings in the bank remain the source of truth.
const meaningParts = value => value.split(/[；;，,、（）()]/u).map(x=>x.trim()).filter(Boolean);
// These concepts can be equally defensible translations despite different
// Chinese wording. They can contrast in reading questions, not meaning choices.
const relatedMeanings = [
  ['希望','望む','期待'], ['確認','確かめる'], ['比較','比べる'],
  ['成長','育つ','発達'], ['受け取り','受け取る'], ['配達','届ける','届く'],
  ['苦しい','つらい'], ['うっかり','つい'], ['丁寧','真剣','きちんと'],
  ['支える','支持'], ['継続','続ける'], ['記憶','思い出す'],
];
function overlapsMeaning(a,b) {
  const left=meaningParts(a),right=meaningParts(b);
  return left.some(x=>right.some(y=>x===y || (Math.min(x.length,y.length)>=2 && (x.includes(y)||y.includes(x)))));
}

export function wordQuestion(entry, subject, requestedType) {
  // Asking the reading of “うっかり” would show its own answer in the prompt.
  const type=subject==='vocab' && !hasKanji(entry)?'meaning':requestedType;
  const pool=(subject==='kanji'?KANJI:VOCAB).filter(q=>q.id!==entry.id && q.level===entry.level
    && (type!=='meaning'||!relatedMeanings.some(group=>group.includes(entry.word)&&group.includes(q.word))));
  const explanation=`「${entry.word}」读作「${entry.reading}」，意思是“${entry.meaning}”。${entry.acceptedReadings?.length>1?'本词也接受：'+entry.acceptedReadings.join('、')+'。':''}`;
  const base={id:entry.id+'-'+type,subject,level:entry.level,topic:subject==='kanji'?'汉字词读音':'词汇积累',context:entry.example,explanation,example:entry.example,translation:entry.translation,point:`${entry.word}【${entry.reading}】 · ${entry.meaning}`};
  if(type==='input') return {...base,kind:'input',prompt:`请用假名写出「${entry.word}」的读音。`,answer:entry.reading,accepted:entry.acceptedReadings||[entry.reading]};
  const meaning=type==='meaning', answer=meaning?entry.meaning:entry.reading;
  const similar=meaning?entry.meaningDistractor:kanaDistractor(entry.reading,entry.acceptedReadings);
  const accepted=[entry.reading,...(entry.acceptedReadings||[])].map(normalize);
  const candidates=[similar,...shuffle(pool.map(x=>meaning?x.meaning:x.reading))].filter(Boolean)
    .filter(x=>meaning?!overlapsMeaning(x,answer):!accepted.includes(normalize(x)));
  const wrongs=[...new Set(candidates)].slice(0,3);
  return {...base,kind:'choice',prompt:meaning?`「${entry.word}」在句中是什么意思？`:`「${entry.word}」的正确读音是？`,answer,options:shuffle([answer,...wrongs])};
}
