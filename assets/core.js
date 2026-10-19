export const STORAGE_KEY = 'hiyori-study-v1';
export const LEVELS = ['N5', 'N4', 'N3'];
export const SECTION_TIMES = [30, 70, 40];
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
export const normalize = value => String(value ?? '').normalize('NFKC').replace(/[\s。．.!！?？]/g, '').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
export const isCorrect = (q, answer) => q.kind === 'input' ? [...(q.accepted || []), q.answer].some(a => normalize(a) === normalize(answer)) : answer === q.answer;
export const shuffle = values => { const a = [...values]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
export const dayKey = (time = Date.now()) => { const d = new Date(time); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
export const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export function emptyState() { return {version:1, settings:{level:'全部', goal:10, haptics:false}, attempts:[], mistakes:{}, history:[], banks:[], session:null, lastResult:null}; }
export function scoreQuestions(questions, answers) {
  const groups = {}; let correct = 0; let answered = 0;
  for (const q of questions) {
    const a = answers[q.id]; const ok = a != null && isCorrect(q, a.value);
    if (a != null) answered++;
    if (ok) correct++;
    const group = ['vocab', 'kanji', 'grammar', 'verb'].includes(q.subject) ? 'knowledge' : q.subject;
    const g = groups[group] ||= {total:0, correct:0, answered:0};
    g.total++; if (ok) g.correct++; if (a != null) g.answered++;
  }
  return {total:questions.length, correct, answered, groups};
}
export function recordAttempt(state, q, answer, sessionId, time = Date.now()) {
  const id = `${sessionId}:${q.id}`;
  if (state.attempts.some(a => a.id === id)) return;
  const correct = isCorrect(q, answer);
  state.attempts.push({id, questionId:q.id, subject:q.subject, level:q.level, correct, time, day:dayKey(time)});
  let item = state.mistakes[q.id];
  if (!correct && !item) item = state.mistakes[q.id] = {question:q, wrongCount:0, correctStreak:0, starred:false, lastAt:time};
  if (item) {
    item.lastAt = time; item.question = q;
    if (correct) item.correctStreak++;
    else { item.wrongCount++; item.correctStreak=0; item.lastWrongAt=time; item.lastAnswer=answer; }
  }
}
export function streak(attempts, now = Date.now()) {
  const days = new Set(attempts.map(a => a.day)); const date = new Date(now);
  if (!days.has(dayKey(date))) date.setDate(date.getDate()-1);
  let count=0;
  while (days.has(dayKey(date))) { count++; date.setDate(date.getDate()-1); }
  return count;
}
const text = (value, label, max=4000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}必须是 1—${max} 字的文本`); return value; };
const questionTextKeys = ['context','passage','topic','point','example','translation','audioText'];
const questionMediaKeys = ['pageImages','answerImages','scriptImages','audioSrc','audioGroup','audioLabel','sourceLabel','sourceUrl','officialNumber'];
function validateOfficialMedia(q) {
  const imagePath = /^assets\/official\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:webp|png)$/;
  const audioPath = /^assets\/official\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.mp3$/;
  const isPath = (value, pattern) => typeof value === 'string' && value.length <= 240 && value.trim() === value && pattern.test(value);
  for (const key of ['pageImages','answerImages','scriptImages']) {
    if (q[key] === undefined) continue;
    if (!Array.isArray(q[key]) || q[key].length > 20 || q[key].some(path => !isPath(path, imagePath))) throw new Error(`${key} 只能包含 assets/official/ 内的 PNG 或 WebP 图片路径（最多 20 张）`);
  }
  if (q.audioSrc !== undefined && !isPath(q.audioSrc, audioPath)) throw new Error('audioSrc 应为 assets/official/ 内的 MP3 音频路径');
  for (const key of ['audioGroup','audioLabel','sourceLabel','officialNumber']) if (q[key] !== undefined) text(q[key], key, 200);
  if (q.sourceUrl !== undefined) {
    text(q.sourceUrl, '来源网址', 1000);
    let url;
    try { url = new URL(q.sourceUrl); } catch { throw new Error('来源网址应为 JLPT 官网的 HTTPS 地址'); }
    if (url.protocol !== 'https:' || !['www.jlpt.jp','jlpt.jp'].includes(url.hostname) || url.username || url.password || url.port || /[\s\\]/.test(q.sourceUrl)) throw new Error('来源网址应为 JLPT 官网的 HTTPS 地址');
  }
}
export function validateQuestion(q) {
  if (!q || typeof q !== 'object') throw new Error('题目格式不正确');
  text(q.id, '题目编号', 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(q.id) || ['__proto__','constructor','prototype'].includes(q.id)) throw new Error('题目编号只能包含字母、数字、短横线或下划线');
  if (!['choice','input'].includes(q.kind)) throw new Error('题型应为 choice 或 input');
  if (!['vocab','kanji','grammar','verb','reading','listening'].includes(q.subject)) throw new Error('未知的科目');
  if (!LEVELS.includes(q.level)) throw new Error('级别应为 N5、N4 或 N3');
  text(q.prompt, '题干'); text(q.answer, '答案', 600); text(q.explanation, '解析');
  if (q.kind === 'choice') {
    if (!Array.isArray(q.options) || q.options.length < 3 || q.options.length > 4 || new Set(q.options).size !== q.options.length) throw new Error('选择题需要 3—4 个不同选项');
    q.options.forEach(a => text(a, '选项', 600));
    if (!q.options.includes(q.answer)) throw new Error('正确答案必须与一个选项完全一致');
  }
  if (q.kind === 'input' && q.accepted != null && (!Array.isArray(q.accepted) || q.accepted.length > 20 || q.accepted.some(a => typeof a !== 'string' || a.length > 600))) throw new Error('输入题的 accepted 应为答案文本数组');
  for (const key of questionTextKeys) if (q[key] != null) text(q[key], key, 8000);
  validateOfficialMedia(q);
  if (q.subject === 'listening' && !q.audioText && !q.audioSrc) throw new Error('听力题需要 audioText 日语朗读稿或 audioSrc 官方录音');
  return q;
}
export function validateBank(raw) {
  if (!raw || raw.schemaVersion !== 1) throw new Error('题库 schemaVersion 应为 1');
  text(raw.title,'题库名称',80);
  if (!raw.source || typeof raw.source !== 'object') throw new Error('请填写 source.name 来源信息');
  text(raw.source.name, '来源', 200);
  if (!Array.isArray(raw.sections) || raw.sections.length !== 3) throw new Error('试卷需要词汇、语法阅读、听力三个部分');
  const ids = new Set(); let total = 0;
  const sections = raw.sections.map((section, i) => {
    if (!Array.isArray(section.questions) || section.questions.length < 1 || section.questions.length > 100) throw new Error('每部分需要 1—100 道题');
    const questions = section.questions.map(q => {
      validateQuestion(q);
      if (q.level !== 'N3' || q.kind !== 'choice') throw new Error('N3 模拟卷使用 N3 选择题');
      if (ids.has(q.id)) throw new Error(`重复编号：${q.id}`); ids.add(q.id); total++;
      const subjects = [['vocab','kanji'],['grammar','reading'],['listening']][i];
      if (!subjects.includes(q.subject)) throw new Error(`第 ${i+1} 部分科目不匹配`);
      const clean={id:q.id,kind:q.kind,subject:q.subject,level:q.level,prompt:q.prompt,options:[...q.options],answer:q.answer,explanation:q.explanation};
      for (const key of questionTextKeys) if(q[key]) clean[key]=q[key];
      for (const key of questionMediaKeys) if(q[key] !== undefined) clean[key]=Array.isArray(q[key])?[...q[key]]:q[key];
      return clean;
    });
    return {name:['语言知识 · 文字词汇','语言知识 · 语法 / 阅读','听力理解'][i], minutes:SECTION_TIMES[i], questions};
  });
  return {title:raw.title, source:{name:raw.source.name}, sections, total};
}
export function validateBackup(raw) {
  if (!raw || raw.type !== 'hiyori-backup' || raw.state?.version !== 1) throw new Error('请选择日和导出的学习记录文件');
  const s=raw.state;
  if (!Array.isArray(s.attempts) || s.attempts.length > 50000 || !Array.isArray(s.history) || !s.mistakes || typeof s.mistakes !== 'object') throw new Error('学习记录结构不完整');
  for (const a of s.attempts) {
    if (typeof a.id !== 'string' || a.id.length > 300 || !Number.isFinite(a.time) || typeof a.correct !== 'boolean' || !/^\d{4}-\d{2}-\d{2}$/.test(a.day) || !['vocab','kanji','grammar','verb','reading','listening'].includes(a.subject) || !LEVELS.includes(a.level)) throw new Error('答题记录格式错误');
  }
  const mistakes={};
  for (const [id,item] of Object.entries(s.mistakes)) {
    validateQuestion(item.question);
    if(id !== item.question.id || !Number.isInteger(item.wrongCount) || item.wrongCount < 0 || !Number.isInteger(item.correctStreak) || item.correctStreak < 0) throw new Error('错题记录格式错误');
    mistakes[id]={...item,starred:Boolean(item.starred)};
  }
  const banks=(s.banks || []).map(b => ({...validateBank({schemaVersion:1,...b}),id:text(b.id,'题库编号',100)}));
  const history=s.history.slice(-100).map(h => {
    text(h.id,'记录编号',100); text(h.title,'记录名称',200);
    if (!['practice','review','exam'].includes(h.mode) || !Number.isFinite(h.time) || !Number.isInteger(h.correct) || !Number.isInteger(h.total) || h.correct < 0 || h.total < h.correct || h.total > 50000) throw new Error('学习历史格式错误');
    return {id:h.id,title:h.title,mode:h.mode,time:h.time,correct:h.correct,total:h.total,partial:Boolean(h.partial)};
  });
  const settings={level:['全部',...LEVELS].includes(s.settings?.level)?s.settings.level:'全部',goal:[10,20,30].includes(s.settings?.goal)?s.settings.goal:10,haptics:Boolean(s.settings?.haptics)};
  return {...emptyState(),settings,attempts:[...new Map(s.attempts.map(a=>[a.id,a])).values()],mistakes,history,banks};
}
