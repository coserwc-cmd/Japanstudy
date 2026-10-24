// Selection uses the existing answer ledger, so it also follows synced
// progress. Different word-question formats are one word, not fresh material.
const formats = ['input', 'reading', 'meaning'];
const wordKey = entry => `${entry.word.normalize('NFKC')}\u0000${entry.reading.normalize('NFKC')}`;

function wordGroups(pool, attempts, recentQuestions = []) {
  const groups = new Map(), byQuestion = new Map();
  for (const item of pool) {
    const key = wordKey(item.entry);
    if (!groups.has(key)) groups.set(key, {item, seen:false, lastSeen:0, recent:false});
    const group = groups.get(key);
    // Match only IDs supplied by this pool, never arbitrary exam/import IDs.
    for (const format of formats) byQuestion.set(`${item.entry.id}-${format}`, group);
  }
  applyHistory(byQuestion, attempts, recentQuestions);
  return [...groups.values()];
}

function questionGroups(pool, attempts, recentQuestions = []) {
  const byQuestion = new Map();
  for (const item of pool) {
    if (!byQuestion.has(item.id)) byQuestion.set(item.id, {item, seen:false, lastSeen:0, recent:false});
  }
  applyHistory(byQuestion, attempts, recentQuestions);
  return [...byQuestion.values()];
}

function applyHistory(byQuestion, attempts, recentQuestions) {
  for (const attempt of attempts) {
    const id = attempt.questionId || (typeof attempt.id === 'string' ? attempt.id.slice(attempt.id.lastIndexOf(':') + 1) : '');
    const group = byQuestion.get(id);
    if (!group) continue;
    group.seen = true;
    if (Number.isFinite(attempt.time)) group.lastSeen = Math.max(group.lastSeen, attempt.time);
  }
  for (const question of recentQuestions) {
    const group = byQuestion.get(question.id);
    if (group) group.recent = true;
  }
}

function coverage(groups) {
  const seen = groups.filter(group => group.seen).length;
  return {total:groups.length, seen, unseen:groups.length - seen};
}

function select(groups, count, random) {
  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [groups[i], groups[j]] = [groups[j], groups[i]];
  }
  groups.sort((a, b) => Number(a.recent) - Number(b.recent)
    || Number(a.seen) - Number(b.seen) || a.lastSeen - b.lastSeen);
  const limit = Math.max(0, Math.min(groups.length, Math.floor(Number(count) || 0)));
  return groups.slice(0, limit).map(group => group.item);
}

/** Count attempted words, not mastered words or generated question formats. */
export function getWordCoverage(pool, attempts = []) {
  return coverage(wordGroups(pool, attempts));
}

/** Count attempted questions. Shared grammar topics do not imply mastery. */
export function getQuestionCoverage(pool, attempts = []) {
  return coverage(questionGroups(pool, attempts));
}

/**
 * Prefer unattempted words, then the least recently attempted. Questions from
 * the current/previous local lesson wait until other choices run out, even if
 * they were skipped. Ties are shuffled; no word appears twice within one set.
 */
export function selectWordEntries(pool, count, {attempts = [], recentQuestions = [], random = Math.random} = {}) {
  return select(wordGroups(pool, attempts, recentQuestions), count, random);
}

/** Select exact question IDs with the same recency rules as word practice. */
export function selectPracticeQuestions(pool, count, {attempts = [], recentQuestions = [], random = Math.random} = {}) {
  return select(questionGroups(pool, attempts, recentQuestions), count, random);
}
