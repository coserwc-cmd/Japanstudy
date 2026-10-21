import {validateQuestion, emptyState, LEVELS} from './core.js';

const subjects = ['vocab','kanji','grammar','verb','reading','listening'];
const unsafe = new Set(['__proto__','constructor','prototype']);
const idOK = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && /^[a-zA-Z0-9_-]+$/.test(value) && !unsafe.has(value);
const timeOK = value => Number.isSafeInteger(value) && value >= 0;
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = () => {throw new Error('同步记录格式不正确；本机记录已保留。');};
export const stableJSON = value => JSON.stringify(order(value));
function order(value) {
  if (Array.isArray(value)) return value.map(order);
  if (!ownObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key,order(value[key])]));
}
const choose = (a,b) => !a ? b : !b ? a : stableJSON(a) >= stableJSON(b) ? a : b;
const sortTime = (a,b) => a.time - b.time || a.id.localeCompare(b.id,'en');

function cleanQuestion(raw) {
  validateQuestion(raw);
  const keys = ['id','kind','subject','level','prompt','options','answer','accepted','explanation',
    'context','passage','topic','point','example','translation','audioText',
    'pageImages','answerImages','scriptImages','audioSrc','audioGroup','audioLabel','sourceLabel','sourceUrl','officialNumber'];
  const q = Object.fromEntries(keys.filter(key => raw[key] !== undefined).map(key => [key,structuredClone(raw[key])]));
  if (raw.distractorExplanations && ownObject(raw.distractorExplanations)) {
    q.distractorExplanations = Object.fromEntries(Object.entries(raw.distractorExplanations)
      .filter(([key,value]) => !unsafe.has(key) && key.length <= 600 && typeof value === 'string' && value.length <= 8000));
  }
  return q;
}

export function validateSyncDocument(raw) {
  if (!ownObject(raw) || raw.version !== 1 || !Array.isArray(raw.attempts) ||
      raw.attempts.length > 50000 || !Array.isArray(raw.history) || raw.history.length > 100 ||
      !ownObject(raw.mistakes) || JSON.stringify(raw).length > 20 * 1024 * 1024) fail();
  const attempts = raw.attempts.map(a => {
    if (!ownObject(a) || typeof a.id !== 'string' || !a.id || a.id.length > 300 ||
        !timeOK(a.time) || typeof a.correct !== 'boolean' || !subjects.includes(a.subject) ||
        !LEVELS.includes(a.level) || typeof a.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.day)) fail();
    const questionId = a.questionId || a.id.slice(a.id.lastIndexOf(':') + 1);
    if (!idOK(questionId) || (a.answer !== undefined && (typeof a.answer !== 'string' || a.answer.length > 600))) fail();
    return {id:a.id,questionId,subject:a.subject,level:a.level,correct:a.correct,time:a.time,day:a.day,
      ...(a.answer === undefined ? {} : {answer:a.answer})};
  });
  const mistakes = {};
  for (const [id,item] of Object.entries(raw.mistakes)) {
    if (!idOK(id) || !ownObject(item) || item.question?.id !== id ||
        !Number.isSafeInteger(item.wrongCount) || item.wrongCount < 0 ||
        !Number.isSafeInteger(item.correctStreak) || item.correctStreak < 0 ||
        (item.starredAt !== undefined && !timeOK(item.starredAt)) ||
        (item.questionAt !== undefined && !timeOK(item.questionAt)) ||
        (item.lastAt !== undefined && !timeOK(item.lastAt)) ||
        (item.lastWrongAt !== undefined && !timeOK(item.lastWrongAt)) ||
        (item.lastAnswer !== undefined && (typeof item.lastAnswer !== 'string' || item.lastAnswer.length > 600))) fail();
    mistakes[id] = {question:cleanQuestion(item.question),questionAt:item.questionAt ?? item.lastAt ?? 0,wrongCount:item.wrongCount,correctStreak:item.correctStreak,
      starred:Boolean(item.starred),starredAt:item.starredAt || 0,lastAt:item.lastAt || 0,
      ...(item.lastWrongAt === undefined ? {} : {lastWrongAt:item.lastWrongAt}),
      ...(item.lastAnswer === undefined ? {} : {lastAnswer:item.lastAnswer})};
  }
  const history = raw.history.map(h => {
    if (!ownObject(h) || typeof h.id !== 'string' || !h.id || h.id.length > 100 ||
        typeof h.title !== 'string' || !h.title || h.title.length > 200 ||
        !['practice','review','exam'].includes(h.mode) || !timeOK(h.time) ||
        !Number.isSafeInteger(h.correct) || !Number.isSafeInteger(h.total) ||
        h.correct < 0 || h.correct > h.total || h.total > 50000) fail();
    return {id:h.id,title:h.title,mode:h.mode,time:h.time,correct:h.correct,total:h.total,partial:Boolean(h.partial)};
  });
  return {version:1,attempts,mistakes,history};
}

export function toSyncDocument(state) {
  return validateSyncDocument({version:1,attempts:state.attempts,mistakes:state.mistakes,history:state.history});
}

function mergeDocuments(left, right) {
  const attemptsById = new Map();
  for (const a of [...left.attempts,...right.attempts]) attemptsById.set(a.id,choose(attemptsById.get(a.id),a));
  if (attemptsById.size > 50000) throw new Error('记录超过同步容量；请先导出备份。本机记录已保留。');
  const attempts = [...attemptsById.values()].sort(sortTime);
  const byQuestion = new Map();
  for (const a of attempts) {
    if (!byQuestion.has(a.questionId)) byQuestion.set(a.questionId,[]);
    byQuestion.get(a.questionId).push(a);
  }
  const mistakes = {};
  for (const id of [...new Set([...Object.keys(left.mistakes),...Object.keys(right.mistakes)])].sort()) {
    const a=left.mistakes[id], b=right.mistakes[id];
    // Question provenance is independent from derived answer counters. Otherwise
    // merging a newer correct attempt can accidentally promote an older wording.
    const question = !a ? b : !b ? a : (a.questionAt > b.questionAt ? a : a.questionAt < b.questionAt ? b :
      {question:choose(a.question,b.question),questionAt:a.questionAt});
    const star = !a ? b : !b ? a : (a.starredAt > b.starredAt ? a : a.starredAt < b.starredAt ? b :
      {starred:a.starredAt === 0 ? a.starred || b.starred : a.starred && b.starred,starredAt:a.starredAt});
    const lastAt=Math.max(a?.lastAt || 0,b?.lastAt || 0);
    const item = {question:question.question,questionAt:question.questionAt,
      wrongCount:Math.max(a?.wrongCount || 0,b?.wrongCount || 0),
      correctStreak:Math.max(...[a,b].filter(x=>x?.lastAt===lastAt).map(x=>x.correctStreak)),
      lastAt,starred:star.starred,starredAt:star.starredAt};
    const lastWrongAt=Math.max(a?.lastWrongAt || 0,b?.lastWrongAt || 0);
    const answerAt=time=>[a,b].filter(x=>x?.lastWrongAt===time && x.lastAnswer!==undefined).map(x=>x.lastAnswer).sort().at(-1);
    if (a?.lastWrongAt!==undefined || b?.lastWrongAt!==undefined) {
      item.lastWrongAt=lastWrongAt;
      const answer=answerAt(lastWrongAt);if(answer!==undefined)item.lastAnswer=answer;
    }
    const ledger = byQuestion.get(id);
    if (ledger?.length) {
      item.wrongCount=0; item.correctStreak=0;delete item.lastWrongAt;delete item.lastAnswer;
      for (const attempt of ledger) {
        if (attempt.correct) item.correctStreak++;
        else {
          item.wrongCount++; item.correctStreak=0; item.lastWrongAt=attempt.time;
          if (attempt.answer !== undefined) item.lastAnswer=attempt.answer;
          else {
            const answer=answerAt(attempt.time);
            if (answer!==undefined)item.lastAnswer=answer;
            else delete item.lastAnswer;
          }
        }
      }
      item.lastAt=Math.max(item.lastAt,ledger.at(-1).time);
    }
    mistakes[id]=item;
  }
  const historyById = new Map();
  for (const h of [...left.history,...right.history]) historyById.set(h.id,choose(historyById.get(h.id),h));
  return {version:1,attempts,mistakes,history:[...historyById.values()].sort(sortTime).slice(-100)};
}

export function mergeStates(localState, remoteDocument) {
  const local = toSyncDocument(localState);
  const remote = remoteDocument == null ? toSyncDocument(emptyState()) : validateSyncDocument(remoteDocument);
  return {...localState,...mergeDocuments(local,remote)};
}
