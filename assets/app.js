import {VOCAB, KANJI, VERBS, VERB_FORMS, makeVerbQuestion} from './word-data.js';
import {GRAMMAR} from './grammar-data.js';
import {EXAM_VOCAB, EXAM_GRAMMAR_READING} from './exam-written.js';
import {EXAM_LISTENING} from './exam-listening.js';
import {OFFICIAL_BANKS} from './official-banks.js';
import {createOfficialPlayer} from './official-player.js';
import {initOfficialMedia, officialAudioStatus, importOfficialAudio} from './official-media.js';
import {LEVELS, escapeHTML as e, normalize, isCorrect, shuffle, dayKey, uid, emptyState, scoreQuestions, recordAttempt, setStarred, streak, validateBank, validateBackup} from './core.js';
import {createCloudSync} from './cloud-sync.js';
import {mergeStates, toSyncDocument} from './sync-model.js';

const $ = s => document.querySelector(s);
const SUBJECTS = {vocab:'词汇', kanji:'汉字', grammar:'语法', verb:'动词变形', reading:'阅读', listening:'听力'};
const GROUPS = {knowledge:'语言知识', reading:'阅读理解', listening:'听力理解'};
const NAV = [['home','home','今日'],['practice','book','日常练习'],['exam','exam','N3 模考'],['mistakes','leaf','错题复习'],['records','chart','学习记录']];
const paths = {
  home:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  book:'M12 5v16M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2Z',
  leaf:'M20 3C9 2 3 7 4 14c0 4 4 7 8 5 6-2 7-9 8-16ZM4 21 15 9',
  exam:'M8 3H5v18h14V3h-3M8 2h8v4H8ZM8 11h8M8 15h6',
  chart:'M4 20V10m8 10V4m8 16v-7',
  settings:'m9 3-1 3-3 1v4l-2 1 2 2v3l3 1 1 3h5l1-3 3-1v-3l3-2-3-1V7l-3-1-1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  arrow:'M4 12h16m-6-6 6 6-6 6', back:'M20 12H4m6-6-6 6 6 6', chevron:'m9 5 7 7-7 7',
  check:'m5 12 4 4L19 6', x:'m6 6 12 12M6 18 18 6',
  star:'m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
  clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v6l3 2',
  upload:'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5', download:'M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5',
  volume:'M11 4 6 8H3v8h3l5 4ZM15 8c3 2 3 6 0 8m3-11c5 4 5 10 0 14',
  refresh:'M20 7V3l-3 3A8 8 0 1 0 20 15M20 3h-5', flag:'M5 22V3c5-5 9 5 15 0v11c-6 5-10-5-15 0',
  sun:'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.book}"/></svg>`;
let storageOK = true;
let state = emptyState();
const cloud=createCloudSync({
 getState:()=>state,
 storage:{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>localStorage.removeItem(key)},
 applyState:(next,reason)=>{
  if(reason==='account')stopAudio();
  state=next;
  if(reason==='account'){route='settings';location.hash='settings';render();}
  else if(route!=='session' && !$('#modal')?.open && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))render();
 },
 onStatus:()=>{const panel=$('#cloud-panel');if(panel)panel.innerHTML=cloudPanelContent();},
});
try {state=cloud.loadState();} catch {storageOK=false;}
let route = location.hash.slice(1) || 'home';
let mistakeFilter='pending', mistakeSubject='all', mistakeSearch='';
let toastTimer, speakingId=null, audioReady=false, pendingBank=null, pendingBackup=null;
let officialTestReady=null;
const officialCacheStatus=new Map();
const officialPlayer=createOfficialPlayer({getSession:()=>state.session,save,changed:updateOfficialAudio,error:toast});
let offlineStatus='serviceWorker' in navigator?'离线资源正在准备…':'此浏览器未提供离线缓存接口。';
const selected = (a,b) => a===b?' selected':'';
const pct = (a,b) => b ? Math.round(a/b*100) : 0;
const dateLabel = time => new Date(time).toLocaleDateString('zh-CN',{month:'long',day:'numeric'});
const pendingMistakes = () => Object.values(state.mistakes).filter(x => x.wrongCount>0 && x.correctStreak<2);
function save() { if(!storageOK) return; try {state=cloud.persist(state);cloud.schedule();} catch { storageOK=false; toast('设备存储不可用或记录无法保存，请先导出学习记录。'); } }
function toast(message) { $('#toast').textContent=message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4000); }
function haptic(wrong=false) { if(state.settings.haptics && typeof navigator.vibrate==='function') navigator.vibrate(wrong?[7,45,7]:7); }
function stopAudio() { if('speechSynthesis' in window) speechSynthesis.cancel(); speakingId=null; officialPlayer.pause(); }
function stopQuestionAudio() { if('speechSynthesis' in window) speechSynthesis.cancel(); speakingId=null; officialPlayer.navigate(currentQ()); }
function navTo(next) { stopAudio(); if(location.hash.slice(1)===next) {route=next;render();} else location.hash=next; window.scrollTo({top:0,behavior:'instant'}); }
function btn(label, action, cls='primary', attrs='') { return `<button class="btn ${cls}" data-action="${action}" ${attrs}>${label}</button>`; }
function levelTabs() {return `<div class="level-tabs" aria-label="学习级别">${['全部',...LEVELS].map(l=>`<button class="chip ${state.settings.level===l?'active':''}" data-action="level" data-level="${l}" aria-pressed="${state.settings.level===l}">${l==='全部'?'N5—N3':l}</button>`).join('')}</div>`;}
const levelMatch = q => state.settings.level==='全部'||q.level===state.settings.level;
function heading(kicker,title,sub='') {return `<header class="page-head"><div class="eyebrow">${kicker}</div><h1>${title}</h1>${sub?`<p class="muted">${sub}</p>`:''}</header>`;}
function navMarkup(mobile=false) {return NAV.map(([id,i,label])=>`<a href="#${id}" class="nav-link ${route===id?'active':''}" ${route===id?'aria-current="page"':''}>${icon(i)}<span>${mobile?({practice:'练习',exam:'模考',mistakes:'错题',records:'记录'}[id]||label):label}</span>${id==='mistakes' && pendingMistakes().length && !mobile?`<span class="nav-count">${pendingMistakes().length}</span>`:''}</a>`).join('');}
function render() {
  if(route==='session'&&!state.session) route='home';
  if(route==='result'&&!state.lastResult) route='records';
  const sessionView=route==='session';
  $('#shell').innerHTML=`<div class="layout ${sessionView?'in-session':''}"><aside class="sidebar"><a href="#home" class="brand"><img class="brand-mark" src="assets/icon.svg" alt=""><span><span class="brand-name">日和<span>日本語</span></span><span class="brand-sub">HIYORI · JAPANSTUDY</span></span></a><div class="sidebar-label">自分のペースで</div><nav aria-label="主导航">${navMarkup()}</nav><div class="sidebar-note"><span class="small-sun">${icon('sun')}</span><p>一日一歩。<br><small>每天一点，慢慢也很远。</small></p></div></aside><div class="workspace"><header class="topbar"><a href="#home" class="mobile-brand"><img src="assets/icon.svg" alt="">日和 <span>日本語</span></a><span class="breadcrumb">学习的日常 <span>/</span> ${NAV.find(n=>n[0]===route)?.[2]||({session:'专注练习',result:'本次回顾',settings:'设置'}[route]||'今日')}</span><div class="top-actions"><span class="top-level">N5 — N3</span><button class="icon-button" data-action="settings" aria-label="学习设置">${icon('settings')}</button></div></header><main id="main" class="page" tabindex="-1">${!storageOK?'<div class="notice">本地存储暂不可用，当前进度仅保留在本次打开期间。请在设置中导出记录。</div>':''}${view()}</main></div><nav class="bottom-nav" aria-label="移动导航">${navMarkup(true)}</nav></div>`;
  updateTimer();updateOfficialAudio();
}
function view() { return ({home:homeView,practice:practiceView,exam:examView,mistakes:mistakesView,records:recordsView,settings:settingsView,session:sessionView,result:resultView}[route]||homeView)(); }
function resumeBanner() {return state.session?`<div class="resume-banner"><div>${icon('clock')}<span><strong>还有一场${state.session.mode==='exam'?'考试':'练习'}等你继续</strong><small>${e(state.session.title)}${state.session.mode==='exam'?' · 当前部分倒计时仍在继续':''}</small></span></div>${btn('继续 '+icon('arrow'),'resume','small secondary')}</div>`:'';}
function moduleCard(symbol,name,desc,count,action,color) {return `<button class="module-card" data-action="${action}"><span class="module-icon ${color}">${symbol}</span><span class="module-meta">${count}</span><span class="module-title">${name}</span><span class="module-desc">${desc}</span><span class="module-foot">开始学习 ${icon('arrow')}</span></button>`;}
function homeView() {
  const today=state.attempts.filter(a=>a.day===dayKey()); const total=state.attempts.length, correct=state.attempts.filter(a=>a.correct).length;
  const progress=Math.min(100,pct(today.length,state.settings.goal));
  return `${resumeBanner()}<section class="hero"><div class="hero-copy"><div class="hero-kicker">${icon('sun')} ${dateLabel(Date.now())} · 今日も、少しずつ。</div><h1>把日语，<br>学成日常<span>。</span></h1><p>从一个单词，到一句自然的表达。<br>按自己的节奏，走好今天的一小步。</p><div class="hero-actions">${btn('开始今日练习 '+icon('arrow'),'daily')}<a class="text-button" href="#practice">自由选择练习</a></div><div class="hero-foot"><span class="dot"></span> N5—N3 · 词汇、语法与表达</div></div><div class="hero-art" aria-hidden="true"><div class="sun-circle"></div><span class="hero-kanji">日<br>和</span><span class="vertical-text">ことばを育てる、毎日。</span><div class="art-line line-one"></div><div class="art-line line-two"></div></div></section>
  <div class="stats-grid"><div class="stat"><span class="stat-icon">${icon('sun')}</span><span class="stat-value">${today.length}<small> 题</small></span><span class="stat-label">今日已练习</span></div><div class="stat"><span class="stat-icon">${icon('leaf')}</span><span class="stat-value">${streak(state.attempts)}<small> 天</small></span><span class="stat-label">连续学习</span></div><div class="stat"><span class="stat-icon">${icon('chart')}</span><span class="stat-value">${total?pct(correct,total)+'<small>%</small>':'—'}</span><span class="stat-label">累计正确率</span></div><div class="stat"><span class="stat-icon">${icon('book')}</span><span class="stat-value">${pendingMistakes().length}<small> 题</small></span><span class="stat-label">等待复习</span></div></div>
  <section class="section"><div class="section-head"><div><div class="eyebrow">YOUR LEARNING PATH</div><h2>今天，想学些什么？</h2></div>${levelTabs()}</div><div class="module-grid">${moduleCard('あ','词汇与汉字','读音、词义与输入，在语境中记住。',`${VOCAB.length} 词汇 · ${KANJI.length} 汉字词`,'setup-words','words')}${moduleCard('文','语法练习','知道选什么，也理解为什么。',`${GRAMMAR.length} 个语法练习`,'setup-grammar','grammar')}${moduleCard('変','动词变形','从基础活用到 N3 常用表达。',`${VERB_FORMS.length} 种形态 · ${VERBS.length} 个动词`,'setup-verbs','verb')}${moduleCard('試','N3 模拟考试','分段计时，完整回顾每一次作答。','201 道官方选编 · 原创模拟','open-exam','exam')}</div></section>
  <div class="home-grid"><section class="daily-card panel"><div class="row between"><h3>今日的小目标</h3><span class="pill green">${today.length} / ${state.settings.goal} 题</span></div><p class="muted">${progress===100?'今日目标已达成。让学过的知识沉淀一下。':'不必一次学很多，持续就会有变化。'}</p><div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div><a href="#records" class="text-button">看看学习足迹 ${icon('arrow')}</a></section><section class="quote-card"><span class="eyebrow">今日のひとこと</span><p class="jp">継続は力なり。</p><span>坚持，就是力量。</span><small>积累的每一天，都算数。</small></section></div><p class="footer-note">为专注学习留一点空白。<span>日和 · 日本語</span></p>`;
}
function practiceView() {
 return `${heading('PRACTICE AT YOUR PACE','每一次练习，都是积累。','选择一个方向。答题后即时讲解，错题自动留存。')}${resumeBanner()}<div class="filter-bar"><span class="subtle">当前学习级别</span>${levelTabs()}</div><div class="practice-grid">${moduleCard('あ','词汇与汉字','选择题里适度加入近音、近义干扰项，也留一些输入题给主动回忆。',`${VOCAB.filter(levelMatch).length+KANJI.filter(levelMatch).length} 条学习内容`,'setup-words','words')}${moduleCard('文','语法练习','JLPT 风格单空选择。正确用法、错误原因和例句一起学。',`${GRAMMAR.filter(levelMatch).length} 道原创练习`,'setup-grammar','grammar')}${moduleCard('変','动词变形','可能、否定、て形、被动、使役等十二种活用。',`${VERBS.length} 个常用动词`,'setup-verbs','verb')}${moduleCard('聞','听力小练习','用系统日语语音练习理解。答题后可查看原文。',`${EXAM_LISTENING.length} 道原创听力`,'setup-listening','exam')}</div><section class="panel section"><div class="section-head"><h3>之前的课堂练习</h3><span class="pill muted">保留原有进度</span></div><div class="legacy-links"><a href="quizzes/lesson18.html">第18课词汇 ${icon('arrow')}</a><a href="quizzes/full-practice.html">三页词汇与敬语 ${icon('arrow')}</a><a href="quizzes/keigo-choice.html">敬语互选 ${icon('arrow')}</a><a href="quizzes/vocab-39.html">39词复习 ${icon('arrow')}</a></div></section><p class="source-note">本页日常内容为原创学习题库，级别划分为教学参考，并非完整的 JLPT 官方词表。词汇、汉字以常用词和例句学习。</p>`;
}
function officialLinks() {return `<a href="https://www.jlpt.jp/e/samples/forlearners.html" target="_blank" rel="noopener noreferrer">官方公开样题 ↗</a><a href="https://www.jlpt.jp/e/guideline/testsections.html" target="_blank" rel="noopener noreferrer">考试科目与时间 ↗</a><a href="https://www.jlpt.jp/e/guideline/results.html" target="_blank" rel="noopener noreferrer">官方成绩说明 ↗</a>`;}
function paperPages(paths,label='官方原卷') {
 return paths?.length?`<div class="paper-pages">${paths.map((path,i)=>`<figure class="paper-page"><a href="${e(path)}" target="_blank" rel="noopener"><img src="${e(path)}" alt="${e(label)} · 原卷图文第 ${i+1} 页" loading="lazy" decoding="async"></a><figcaption><span>保留原卷图文 · 按当前题号作答</span><a href="${e(path)}" target="_blank" rel="noopener">查看高清原图 ↗</a></figcaption></figure>`).join('')}<p class="source-note">Source: <a href="https://www.jlpt.jp/" target="_blank" rel="noopener">Japanese-Language Proficiency Test Worldwide Official Website</a></p></div>`:'';
}
function officialExplanation(q) {
 return `${q.answerImages?.length?`<details class="official-resources"><summary>对照官方答案表</summary>${paperPages(q.answerImages,'官方答案表')}</details>`:''}${q.scriptImages?.length?`<details class="official-resources"><summary>查看这组听力原文</summary>${paperPages(q.scriptImages,'官方听力原文')}</details>`:''}${q.sourceUrl?`<p class="official-source-note"><a href="${e(q.sourceUrl)}" target="_blank" rel="noopener">${e(q.sourceLabel||'日本语能力测试官方网站')} ↗</a></p>`:''}`;
}
function officialBanksView() {
 return `<section class="section"><div class="section-head"><div><div class="eyebrow">OFFICIAL PRACTICE WORKBOOKS</div><h2>官方真题选编</h2></div><span class="pill green">共 201 题 · 原版听力</span></div><p class="official-source-note">2012 / 2018 为试题集出版年份。题目选自真实考试，并非对应年份的单次考试整卷。按原卷题号选择数字答案；图片可点开放大。</p><div class="official-bank-grid">${OFFICIAL_BANKS.map(bank=>`<article class="official-bank-card panel" data-official-bank="${e(bank.id)}"><span class="pill green">N3 · ${bank.year} 年出版</span><h3>${e(bank.title)}</h3><p>${bank.sections.map(s=>`${e(s.name.replace('语言知识 · ',''))} ${s.questions.length} 题`).join(' · ')}</p><p class="muted">原卷图文、官方答案和原版录音 · 共 ${bank.total} 题 · 听力 ${bank.sections[2].minutes} 分钟</p><div class="row wrap">${btn('开始整卷','exam-start','primary',`data-bank="${e(bank.id)}" data-variant="full"`)}${btn('仅笔试','exam-start','secondary',`data-bank="${e(bank.id)}" data-variant="written"`)}</div><div class="row wrap">${bank.sections.map((s,i)=>btn(['词汇练习','语法阅读练习','原版听力练习'][i],'official-practice','small ghost',`data-bank="${e(bank.id)}" data-section="${i}"`)).join('')}</div><div class="row wrap">${btn(icon('download')+' 保存图文离线资料','offline-bank','small secondary',`data-bank="${e(bank.id)}"`)}<span class="official-cache-status subtle" data-cache-status="${e(bank.id)}" role="status">${e(officialCacheStatus.get(bank.id)||'保存原卷、答案与听力稿，不含录音。')}</span></div><div class="row wrap">${btn(icon('upload')+' 导入离线音频','import-official-audio','small secondary',`data-bank="${e(bank.id)}"`)}<input class="official-audio-file" data-bank="${e(bank.id)}" type="file" accept=".mp3,audio/mpeg" multiple hidden><span class="subtle" data-audio-import-status="${e(bank.id)}" role="status">${audioImportLabel(bank.id)}</span></div><p class="source-note">在线直接播放官网录音。离线时请选择本卷的 N3Q1.mp3—N3Q5.mp3，文件只保存在这台设备。</p><details class="official-resources"><summary>下载原卷、答案与原版录音</summary><ul>${(bank.resources||[]).map(r=>`<li><a href="${e(r.path.endsWith('.mp3')?r.sourceUrl:r.path)}" ${r.path.endsWith('.mp3')?'target="_blank" rel="noopener"':'download'}>${e(r.label)}</a></li>`).join('')}</ul></details></article>`).join('')}</div></section>`;
}
function audioTime(seconds) {const n=Math.max(0,Math.floor(seconds||0));return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;}
function audioImportLabel(id) {const status=officialAudioStatus(id);return `本机已有 ${status.imported} / ${status.total} 段原版录音`;}
async function handleOfficialAudioFile(input) {
 const id=input.dataset.bank,files=[...input.files];if(!files.length)return;
 const button=document.querySelector(`[data-action="import-official-audio"][data-bank="${id}"]`);
 const report=message=>{const status=document.querySelector(`[data-audio-import-status="${id}"]`);if(status)status.textContent=message;};
 if(button)button.disabled=true;
 try {
  const result=await importOfficialAudio(id,files,p=>report(`正在核对并保存 ${p.completed} / ${p.total}…`));
  if(result.imported)officialPlayer.dispose();
  report(audioImportLabel(id));
  toast(result.rejected.length?`已导入 ${result.imported} 段；${result.rejected[0].name}：${result.rejected[0].reason}`:`已保存 ${result.imported} 段原版录音，可在本机离线播放。`);
 } catch(error) {report(audioImportLabel(id));toast(error.message);}
 finally {input.value='';if(button)button.disabled=false;}
}
function officialAudioView(q) {
 const exam=state.session?.mode==='exam';
 return `<div class="official-audio"><strong>${e(q.audioLabel||'官方原版录音')}</strong><div class="row wrap">${btn(icon('volume')+' 播放原版录音','official-play','secondary')}${btn('暂停','official-pause','ghost')}<span class="official-audio-status" role="status"></span></div>${!exam?'<label class="sr-only" for="official-audio-seek">录音播放位置</label><input id="official-audio-seek" class="official-audio-progress" type="range" min="0" max="0" value="0" step="1">':''}<small class="muted">${exam?'同组题目共用一段录音，翻题不中断；可暂停续播，播放结束后不能重播。':'原版录音含整组题目及例题；可拖动定位到当前题目，反复收听。'}</small></div>`;
}
function updateOfficialAudio() {
 const q=currentQ();if(!q?.audioSrc)return;
 const status=officialPlayer.state(q), play=$('[data-action="official-play"]'), pause=$('[data-action="official-pause"]');
 if(play){play.disabled=!!status.playing||(state.session?.mode==='exam'&&status.ended);play.textContent=status.playing?'正在播放':status.ended?(state.session?.mode==='exam'?'本组已播放':'重新播放'):status.position>0?'继续播放':'播放原版录音';}
 if(pause)pause.disabled=!status.playing;
 const label=$('.official-audio-status');if(label)label.textContent=`${audioTime(status.position)} / ${audioTime(status.duration)}${status.ended?' · 本组播放完成':''}`;
 const slider=$('.official-audio-progress');if(slider){slider.max=String(status.duration||0);slider.value=String(status.position||0);slider.disabled=!status.seekable;}
}
async function cacheOfficialBank(id) {
 const bank=getExamBank(id);if(!bank?.official)return;
 if(!('caches' in window)||!('serviceWorker' in navigator)){toast('离线资料需要 HTTPS 和支持离线缓存的浏览器。');return;}
 const button=document.querySelector(`[data-action="offline-bank"][data-bank="${id}"]`);if(button?.disabled)return;
 if(button)button.disabled=true;
 const report=message=>{officialCacheStatus.set(id,message);const label=document.querySelector(`[data-cache-status="${id}"]`);if(label)label.textContent=message;};
 try {
  await navigator.serviceWorker.ready;
  const cache=await caches.open('hiyori-official-v1');
  const urls=new Set((bank.resources||[]).filter(r=>!r.path.endsWith('.mp3')).map(r=>r.path));
  for(const q of bank.sections.flatMap(s=>s.questions))for(const path of [...(q.pageImages||[]),...(q.answerImages||[]),...(q.scriptImages||[])])urls.add(path);
  let complete=0;const paths=[...urls];
  for(let i=0;i<paths.length;i+=3)await Promise.all(paths.slice(i,i+3).map(async path=>{
   const url=new URL(path,location.href);if(!(await cache.match(url))){const response=await fetch(url);if(!response.ok||response.status!==200)throw Error('下载失败');await cache.put(url,response);}
   report(`正在保存 ${++complete} / ${paths.length} 个文件…`);
  }));
  report('本套图文离线资料已保存');toast('原卷、答案和听力稿已保存。离线录音请使用「导入离线音频」。');
 } catch {report('尚未保存完整，可联网后重试。');toast('离线保存未完成，请检查网络或设备剩余空间后重试。');}
 finally {if(button)button.disabled=false;}
}
function examView() {
 const written=EXAM_VOCAB.length+EXAM_GRAMMAR_READING.length;
 return `${heading('JLPT N3 · OFFICIAL & PRACTICE','给自己一次认真的检验。','按部分计时，交卷后统一看解析。每次考试，都是下一步的起点。')}${resumeBanner()}${officialBanksView()}<section class="exam-card"><div class="exam-header"><div><span class="pill green">N3</span><span class="pill warm">原创模拟 · 第 01 卷</span><h2>日本語能力試験<br><span class="muted">N3 模拟练习</span></h2><p>文字词汇、语法阅读、听力，三部分依次完成。</p></div><span class="exam-seal" aria-hidden="true">試</span></div><div class="exam-stages"><div class="exam-stage"><span class="stage-number">01</span><div><strong>文字 · 词汇</strong><small>${EXAM_VOCAB.length} 题</small></div><span>30 分钟</span></div><div class="exam-stage"><span class="stage-number">02</span><div><strong>语法 · 阅读</strong><small>${EXAM_GRAMMAR_READING.length} 题</small></div><span>70 分钟</span></div><div class="exam-stage"><span class="stage-number">03</span><div><strong>听力理解</strong><small>${EXAM_LISTENING.length} 题 · 系统日语朗读</small></div><span>40 分钟</span></div></div><div class="row wrap exam-buttons">${btn('开始整卷模拟 '+icon('arrow'),'exam-start','primary','data-variant="full"')}${btn(`仅笔试 · ${written} 题`,'exam-start','secondary','data-variant="written"')}${btn('短卷体验 · 10 分钟','exam-start','ghost','data-variant="quick"')}</div></section><div class="exam-layout section"><section class="panel"><h3>开始前，了解这些</h3><ul class="detail-list"><li>各部分单独倒计时；交卷后不可返回上一部分。切换页面或锁屏不会暂停计时。</li><li>练习分数按答对题数统计。JLPT 正式成绩采用尺度分数，本应用不换算 180 分制、不预测是否合格。</li><li>官方选编使用原版录音，按大题连续播放；原创模拟使用系统语音。听力按各卷设置计时。</li><li>官方选编与原创模拟分开标注。官方选编保留原卷版面；短卷仅体验原创笔试流程。</li></ul><div class="source-links">${officialLinks()}</div></section><section class="panel"><div class="row between"><h3>我的题库</h3><span class="pill muted">${state.banks.length} 份</span></div><p class="muted">导入已有的、可合法使用的 JSON 题库。保留名称和来源，沿用计时、计分与错题统计。</p>${state.banks.map(b=>`<div class="imported-bank"><div><strong>${e(b.title)}</strong><small>${e(b.source.name)} · ${b.total} 题</small></div>${btn('开始','exam-start','small secondary',`data-bank="${e(b.id)}" data-variant="full"`)}</div>`).join('')}<div class="row wrap">${btn(icon('upload')+' 导入题库','import-bank','secondary')}<a class="text-button" href="assets/import-example.json" download>下载格式示例</a></div><input id="bank-file" type="file" accept=".json,application/json" hidden></section></div>`;
}
function mistakesView() {
 const all=Object.values(state.mistakes); const items=filteredMistakes();
 return `${heading('REVISIT & REMEMBER','把没记住的，再遇见一次。','错题按知识点保留；连续答对两次后归入「已巩固」，仍可随时回看。')}<div class="stats-grid compact"><div class="stat"><span class="stat-value">${pendingMistakes().length}</span><span class="stat-label">等待复习</span></div><div class="stat"><span class="stat-value">${all.filter(x=>x.wrongCount&&x.correctStreak>=2).length}</span><span class="stat-label">已巩固</span></div><div class="stat"><span class="stat-value">${all.filter(x=>x.starred).length}</span><span class="stat-label">重点标记</span></div></div><div class="filter-bar"><div class="level-tabs">${[['pending','待复习'],['starred','重点标记'],['mastered','已巩固'],['all','全部']].map(([id,label])=>`<button class="chip ${mistakeFilter===id?'active':''}" data-action="mistake-filter" data-filter="${id}" aria-pressed="${mistakeFilter===id}">${label}</button>`).join('')}</div>${btn('复习当前题目 '+icon('arrow'),'review-filter','small primary',items.length?'':'disabled')}</div><div class="row wrap mistake-tools"><label class="sr-only" for="mistake-subject">错题科目</label><select id="mistake-subject"><option value="all">全部科目</option>${Object.entries(SUBJECTS).map(([id,label])=>`<option value="${id}"${selected(mistakeSubject,id)}>${label}</option>`).join('')}</select><label class="sr-only" for="mistake-search">搜索错题</label><input id="mistake-search" type="search" placeholder="搜索题目或知识点" value="${e(mistakeSearch)}"></div><div class="wrong-list">${items.length?items.map(item=>`<article class="wrong-card"><div class="wrong-card-header"><span class="pill green">${e(item.question.level)} · ${SUBJECTS[item.question.subject]}</span><button class="icon-button ${item.starred?'active':''}" data-action="star-item" data-id="${e(item.question.id)}" aria-label="${item.starred?'取消重点标记':'标为重点'}" aria-pressed="${item.starred}">${icon('star')}</button></div><h3 class="wrong-prompt jp">${e(item.question.prompt)}</h3><p class="muted">${e(item.question.topic||item.question.point||'基础知识复习')}</p><div class="wrong-meta"><span>答错 ${item.wrongCount} 次 · 连续答对 ${item.correctStreak} 次</span>${btn('查看解析','inspect-mistake','small ghost',`data-id="${e(item.question.id)}"`)}</div></article>`).join(''):empty('leaf','这里，暂时是一片空白。','做几道练习，错题会自动收进来。也可以主动把题目标为重点。','去练习','open-practice')}</div>`;
}
function filteredMistakes() { return Object.values(state.mistakes).filter(x=>mistakeFilter==='pending'?x.wrongCount>0&&x.correctStreak<2:mistakeFilter==='starred'?x.starred:mistakeFilter==='mastered'?x.wrongCount>0&&x.correctStreak>=2:true).filter(x=>mistakeSubject==='all'||x.question.subject===mistakeSubject).filter(x=>!mistakeSearch||`${x.question.prompt} ${x.question.point||''} ${x.question.topic||''}`.toLowerCase().includes(mistakeSearch.toLowerCase())).sort((a,b)=>(b.lastAt||0)-(a.lastAt||0)); }
function empty(i,title,desc,label,action) {return `<div class="empty-state"><span class="empty-icon">${icon(i)}</span><h3>${title}</h3><p>${desc}</p>${label?btn(label,action,'secondary'):''}</div>`;}
function recordsView() {
 const total=state.attempts.length; const correct=state.attempts.filter(a=>a.correct).length;
 const days=Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()-6+i);return {day:dayKey(d),label:i===6?'今天':['日','一','二','三','四','五','六'][d.getDay()],n:state.attempts.filter(a=>a.day===dayKey(d)).length};}); const max=Math.max(1,...days.map(d=>d.n));
 return `${heading('SMALL STEPS, REAL PROGRESS','你的每一小步，都在这里。','在学习设置中开启同步，iPhone 与 iPad 就能共享记录；离线时继续保存在本机。')}<div class="stats-grid"><div class="stat"><span class="stat-value">${total}</span><span class="stat-label">累计作答</span></div><div class="stat"><span class="stat-value">${total?pct(correct,total)+'<small>%</small>':'—'}</span><span class="stat-label">累计正确率</span></div><div class="stat"><span class="stat-value">${new Set(state.attempts.map(a=>a.day)).size}</span><span class="stat-label">学习天数</span></div><div class="stat"><span class="stat-value">${streak(state.attempts)}</span><span class="stat-label">连续天数</span></div></div><div class="home-grid section"><section class="panel"><h3>最近七天</h3><div class="week-chart">${days.map(d=>`<div class="day-column"><span>${d.n}</span><div class="day-bar-track"><div class="day-bar ${d.label==='今天'?'today':''}" style="height:${d.n?Math.max(5,d.n/max*100):2}%"></div></div><span class="day-label">${d.label}</span></div>`).join('')}</div></section><section class="panel"><h3>各科练习正确率</h3><div class="subject-stats">${Object.entries(SUBJECTS).map(([id,label])=>{const a=state.attempts.filter(a=>a.subject===id);return `<div class="subject-stat"><div class="row between"><span>${label}</span><small>${a.length?pct(a.filter(x=>x.correct).length,a.length)+'% · '+a.length+' 题':'还未练习'}</small></div><div class="progress-track"><div class="progress-fill" style="width:${pct(a.filter(x=>x.correct).length,a.length)}%"></div></div></div>`;}).join('')}</div></section></div><section class="section"><div class="section-head"><h2>最近的学习</h2><span class="subtle">练习分数 · 按题计分</span></div><div class="history-list">${state.history.length?[...state.history].reverse().map(h=>`<article class="history-item"><span class="history-icon">${icon(h.mode==='exam'?'exam':'book')}</span><div class="grow"><strong>${e(h.title)}</strong><small>${dateLabel(h.time)} · ${h.mode==='exam'?'模拟考试':'日常练习'}${h.partial?' · 未完成整卷':''}</small></div><div class="history-score"><strong>${h.correct} <span>/ ${h.total}</span></strong><small>${pct(h.correct,h.total)}% 正确</small></div>${h.id===state.lastResult?.id?btn('回顾','open-result','small ghost'):''}</article>`).join(''):empty('chart','还没有学习记录','从今天的第一道题开始吧。','开始练习','daily')}</div></section>`;
}
function settingsView() {return `${heading('MAKE YOURSELF AT HOME','按照你的节奏。','简简单单，保持学习。')}<div class="settings-grid"><section class="panel sync-panel" id="cloud-panel">${cloudPanelContent()}</section><section class="panel"><h3>学习偏好</h3><div class="setting-row"><div><strong>每日目标</strong><small>每天完成多少道题？</small></div><select id="goal-select" aria-label="每日目标">${[10,20,30].map(n=>`<option value="${n}"${selected(state.settings.goal,n)}>${n} 题</option>`).join('')}</select></div><div class="setting-row"><div><strong>触感反馈</strong><small>${typeof navigator.vibrate==='function'?'支持时提供轻盈的答题震动。':'此浏览器不提供震动接口，使用轻微按压动画反馈。'}</small></div><input type="checkbox" id="haptics" aria-label="触感反馈" ${state.settings.haptics?'checked':''} ${typeof navigator.vibrate!=='function'?'disabled':''}></div><div class="setting-row"><div><strong>日语语音</strong><small>原创听力使用设备日语语音；官方选编播放原版录音。</small></div>${btn(icon('volume')+' 试音','audio-test','small secondary')}</div></section><section class="panel"><h3>记录与备份</h3><p class="muted">可开启上方的跨设备同步。未开启时，进度只保存在当前浏览器或主屏幕 App 内；仍建议定期导出备份。</p><div class="row wrap">${btn(icon('download')+' 导出学习记录','export-backup','secondary')}${btn(icon('upload')+' 恢复备份','import-backup','ghost')}</div><input type="file" id="backup-file" accept=".json,application/json" hidden><p class="source-note">开启同步时，恢复备份会合并已有记录；未开启时替换本机记录。确认前可先导出备份。</p></section><section class="panel"><h3>放到 iPhone / iPad 主屏幕</h3><p class="source-note" id="offline-status">${e(offlineStatus)}</p><ol class="detail-list"><li>在 Safari 中打开已部署的网站。</li><li>点「分享」，选择「添加到主屏幕」。</li><li>首次联网打开后，核心页面与内置题库可离线练习。日语语音需要设备已安装对应声音。</li></ol><p class="source-note">离线能力需要 HTTPS 或本机开发环境。iPad 通常没有振动马达；iOS 网页无法直接调用 Taptic Engine。</p></section><section class="panel"><h3>关于题库</h3><p class="muted">内置 ${VOCAB.length} 个词汇、${KANJI.length} 个汉字词、${GRAMMAR.length} 道语法题、${VERBS.length} 个动词的 ${VERB_FORMS.length} 类活用，以及 1 套原创 N3 模拟卷、2 套官方真题选编（201 题）。内容用于基础训练，不代表 N5—N3 的完整知识范围。</p><p class="muted">官方未公布完整词汇或语法清单；本应用级别是教学参考。官方选编已在模考页提供，也可导入自己的 JSON 题库。</p><div class="source-links">${officialLinks()}</div></section></div>`;}

function kanaDistractor(reading, accepted=[]) {
 const changes=[['し','じ'],['じ','し'],['つ','っ'],['っ','つ'],['か','が'],['が','か'],['き','ぎ'],['ぎ','き'],['う','ゅう'],['ょ','よ'],['ゃ','や'],['え','い'],['お','う']];
 for(const [a,b] of changes) if(reading.includes(a)) {const candidate=reading.replace(a,b);if(![reading,...accepted].some(x=>normalize(x)===normalize(candidate))) return candidate;}
 return reading.length>1?reading+'う':'あ'+reading;
}
function wordQuestion(entry, subject, type) {
 const pool=(subject==='kanji'?KANJI:VOCAB).filter(q=>q.id!==entry.id && q.level===entry.level);
 const explanation=`「${entry.word}」读作「${entry.reading}」，意思是“${entry.meaning}”。${entry.acceptedReadings?.length>1?'本词也接受：'+entry.acceptedReadings.join('、')+'。':''}`;
 const base={id:entry.id+'-'+type,subject,level:entry.level,topic:subject==='kanji'?'汉字词读音':'词汇积累',context:entry.example,explanation,example:entry.example,translation:entry.translation,point:`${entry.word}【${entry.reading}】 · ${entry.meaning}`};
 if(type==='input') return {...base,kind:'input',prompt:`请用假名写出「${entry.word}」的读音。`,answer:entry.reading,accepted:entry.acceptedReadings||[entry.reading]};
 const meaning=type==='meaning', answer=meaning?entry.meaning:entry.reading;
 const similar=meaning?entry.meaningDistractor:kanaDistractor(entry.reading,entry.acceptedReadings);
 const candidates=[similar,...shuffle(pool.map(x=>meaning?x.meaning:x.reading))].filter(Boolean).filter(x=>x!==answer&&!(entry.acceptedReadings||[]).includes(x));
 const wrongs=[...new Set(candidates)].slice(0,3);
 return {...base,kind:'choice',prompt:meaning?`「${entry.word}」在句中是什么意思？`:`「${entry.word}」的正确读音是？`,answer,options:shuffle([answer,...wrongs])};
}
function dailyQuestions(count) {
 const questions=[...shuffle(VOCAB.filter(levelMatch)).slice(0,count).map((x,i)=>wordQuestion(x,'vocab',i%4===0?'input':'meaning')),...shuffle(KANJI.filter(levelMatch)).slice(0,count).map((x,i)=>wordQuestion(x,'kanji',i%3===0?'input':'reading')),...shuffle(GRAMMAR.filter(levelMatch)),...shuffle(VERBS).slice(0,count).map((x,i)=>makeVerbQuestion(x,VERB_FORMS.filter(levelMatch)[i%VERB_FORMS.filter(levelMatch).length]?.id||'nai')).filter(Boolean)];
 // Rotate the subjects so every daily set contains vocabulary, kanji, grammar and a conjugation.
 const grouped=['vocab','kanji','grammar','verb'].map(s=>shuffle(questions.filter(q=>q.subject===s))); const chosen=[];
 for(let i=0;chosen.length<count&&grouped.some(a=>a.length);i++) {const q=grouped[i%4].pop();if(q)chosen.push(q);}
 return chosen;
}
function modal(title,body,actions='') { $('#modal').innerHTML=`<div class="modal-head"><h2>${title}</h2><button class="icon-button modal-close" data-action="close-modal" aria-label="关闭">${icon('x')}</button></div><div class="modal-body">${body}</div>${actions?`<div class="modal-actions">${actions}</div>`:''}`; if(!$('#modal').open) $('#modal').showModal(); }
function closeModal() { $('#modal').close(); }
function cloudPanelContent() {
 const s=cloud.getStatus(), busy=['connecting','syncing'].includes(s.phase);
 const time=s.lastSyncedAt?new Date(s.lastSyncedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';
 return `<div class="row between wrap"><h3>iPhone / iPad 同步</h3><span class="pill ${s.phase==='synced'?'green':'warm'}" data-cloud-status>${e(s.message)}</span></div>
 <p class="muted">${s.connected?`学习空间 ${e(s.accountLabel)}${time?' · 上次同步 '+e(time):''}。使用相同同步码的设备共享记录。`:'在一台设备开启同步，再在另一台设备输入同步码，就能接着学。无需注册邮箱。'}</p>
 <div class="row wrap">${s.connected?
 `${btn(busy?'同步中…':'立即同步','cloud-sync','secondary',busy?'disabled':'')}${btn('连接另一台设备','cloud-show-code','ghost')}${btn('断开本设备','cloud-disconnect','ghost')}`:
 `${btn('开启同步','cloud-create','primary',!storageOK||!s.configured||busy?'disabled':'')}${btn('输入已有同步码','cloud-join','secondary',!storageOK||!s.configured||busy?'disabled':'')}`}</div>
 <p class="source-note">同步学习记录、错题及其解析、重点标记；离线练习在联网后合并。未完成的考试、学习偏好、完整导入题库和下载音频仍保存在各自设备。</p>`;
}
function showCloudCode() {
 const code=cloud.getCode();if(!code)return;
 modal('在另一台设备接着学',`<ol class="detail-list"><li>在另一台 iPhone 或 iPad 打开日和。</li><li>进入「学习设置」→「输入已有同步码」。</li><li>粘贴下面的同步码，连接同一学习空间。</li></ol><label for="cloud-code">你的同步码</label><textarea id="cloud-code" class="sync-code" readonly spellcheck="false" autocomplete="off">${e(code)}</textarea><p class="notice">同步码等同密码。请自己保存，分享网站时不要分享它；所有设备和同步码都丢失后无法找回云端记录。</p>`,btn('复制同步码','cloud-copy-code','primary')+btn('已保存','close-modal','secondary'));
}
function joinCloudDialog() {
 modal('连接已有学习空间',`<form id="cloud-join-form"><label for="cloud-code-input">粘贴另一台设备显示的同步码</label><textarea id="cloud-code-input" class="sync-code" rows="3" maxlength="96" autocomplete="off" autocapitalize="none" spellcheck="false" required placeholder="输入 48 位同步码"></textarea>${state.attempts.length||Object.keys(state.mistakes).length?`<label class="sync-import-label"><input id="cloud-import-local" type="checkbox">同时合并这台设备的独立记录（${state.attempts.length} 次作答）</label>`:''}<p class="source-note">默认保留本机独立记录，不上传到已有学习空间。请只输入自己的同步码。</p><div class="row wrap"><button class="btn primary" type="submit" id="cloud-join-submit">连接并同步</button>${btn('取消','close-modal','ghost','type="button"')}</div><p id="cloud-form-error" class="source-note" role="status"></p></form>`);
 $('#cloud-code-input').focus();
}
async function connectCloudFromForm(event) {
 event.preventDefault();
 const button=$('#cloud-join-submit');if(button.disabled)return;
 button.disabled=true;button.textContent='正在连接…';
 try {
  await cloud.join($('#cloud-code-input').value,{importLocal:!!$('#cloud-import-local')?.checked});
  closeModal();render();toast('已连接同一学习空间。');
 } catch(error) {
  const output=$('#cloud-form-error');if(output)output.textContent=error.message;
 } finally {if(button.isConnected){button.disabled=false;button.textContent='连接并同步';}}
}
async function createCloudSpace(el) {
 el.disabled=true;el.textContent='正在开启…';
 try {await cloud.create();showCloudCode();render();}
 catch(error){toast(error.message);if(el.isConnected){el.disabled=false;el.textContent='开启并合并本机记录';}}
}
function guardNewSession(callback) {
 if(!state.session) return callback();
 pendingStart=callback;
 modal('要开始新的练习吗？','<p>当前还有未完成的练习。开始新的练习将结束当前练习；已经计入的日常练习记录会保留，未交卷的考试将保存为部分完成的记录。</p>',btn('继续原来的练习','resume','secondary')+btn('保存并开始新的练习','replace-session'));
}
let pendingStart=null;
function setup(kind) {
 const isWords=kind==='words', isVerb=kind==='verbs', isListening=kind==='listening';
 const formOptions=VERB_FORMS.filter(levelMatch);
 modal({words:'词汇与汉字',grammar:'语法练习',verbs:'动词变形专项',listening:'听力小练习'}[kind],`<p class="muted">${state.settings.level==='全部'?'N5—N3 综合':e(state.settings.level)} · ${isListening?'系统日语语音，答题后查看原文与解释。':'循序渐进，不必急着答完。'}</p><div class="form-grid"><div class="field"><label for="practice-count">本轮题量</label><select id="practice-count"><option value="10">10 题 · 轻量练习</option><option value="20">20 题 · 集中巩固</option><option value="5">5 题 · 碎片时间</option></select></div>${isWords?'<div class="field"><label for="word-subject">学习内容</label><select id="word-subject"><option value="mixed">词汇 + 汉字</option><option value="vocab">词汇</option><option value="kanji">汉字读音</option></select></div><div class="field"><label for="practice-style">答题方式</label><select id="practice-style"><option value="mixed">混合 · 约三成输入题</option><option value="choice">选择题</option><option value="input">输入读音</option></select></div>':''}${isVerb?`<div class="field"><label for="verb-form">重点形态</label><select id="verb-form"><option value="all">混合练习</option>${formOptions.map(f=>`<option value="${e(f.id)}">${e(f.label)} · ${e(f.level)}</option>`).join('')}</select></div><p class="source-note">请使用普通形作答，汉字或假名均可。可能形练习采用标准「られる」，不收录「ら抜き」。</p>`:''}</div>${isListening?'<p class="notice">听力需要设备的日语语音。若无语音可切换为「阅读听力稿」；这会单独标注为文本理解练习。</p>':''}`,`${isListening?btn(icon('volume')+' 先试音','audio-test','secondary'):''}${btn('开始练习 '+icon('arrow'),'begin-practice','primary',`data-kind="${kind}"`)}`);
}
function beginPractice(kind) {
 const count=Number($('#practice-count')?.value||10);let questions=[],title='';let audioTextMode=false;
 if(kind==='words') {
   const subject=$('#word-subject').value,style=$('#practice-style').value;
   let pool=shuffle([...(subject!=='kanji'?VOCAB.filter(levelMatch).map(x=>({entry:x,subject:'vocab'})):[]),...(subject!=='vocab'?KANJI.filter(levelMatch).map(x=>({entry:x,subject:'kanji'})):[])]).slice(0,count);
   questions=pool.map(({entry,subject},i)=>wordQuestion(entry,subject,style==='input'||(style==='mixed'&&i%3===0)?'input':subject==='kanji'?'reading':i%2?'meaning':'reading'));
   title=subject==='mixed'?'词汇与汉字':subject==='vocab'?'词汇练习':'汉字读音';
 } else if(kind==='grammar') {questions=shuffle(GRAMMAR.filter(levelMatch)).slice(0,count);title='语法练习';}
 else if(kind==='verbs') {const form=$('#verb-form').value;const forms=VERB_FORMS.filter(levelMatch).filter(f=>form==='all'||f.id===form);questions=shuffle(VERBS.flatMap(v=>forms.map(f=>makeVerbQuestion(v,f.id))).filter(Boolean)).slice(0,count);title=form==='all'?'动词变形':`动词 · ${VERB_FORMS.find(f=>f.id===form).label}`;}
 else {questions=shuffle(EXAM_LISTENING).slice(0,count);audioTextMode=!japaneseVoice();title=audioTextMode?'听力稿 · 文本理解':'听力小练习';}
 closeModal(); guardNewSession(()=>startPractice(questions,title,'practice',audioTextMode));
}
function startPractice(questions,title,mode='practice',audioTextMode=false) {
 if(!questions.length) {toast('当前级别没有匹配的题目，请调整筛选。');return;}
 officialPlayer.dispose();state.session={id:uid(),mode,title,questions:questions.map(q=>({...q,options:q.options?(q.pageImages?[...q.options]:shuffle(q.options)):undefined})),answers:{},drafts:{},index:0,startedAt:Date.now(),phase:'active',audioTextMode}; save();navTo('session');
}
function getExamBank(id) {
 if(id) return OFFICIAL_BANKS.find(b=>b.id===id)||state.banks.find(b=>b.id===id);
 return {title:'N3 原创模拟 · 第 01 卷',source:{name:'日和原创模拟题'},sections:[{name:'语言知识 · 文字词汇',minutes:30,questions:EXAM_VOCAB},{name:'语言知识 · 语法 / 阅读',minutes:70,questions:EXAM_GRAMMAR_READING},{name:'听力理解',minutes:40,questions:EXAM_LISTENING}]};
}
let examRequest=null;
function examIntro(variant='full',bankId) {
 const bank=getExamBank(bankId);if(!bank){toast('未找到这份题库。');return;}
 examRequest={variant,bankId};officialTestReady=null;
 modal(variant==='quick'?'短卷体验':variant==='written'?'开始 N3 笔试':'开始 N3 整卷模拟',`<p><strong>${e(bank.title)}</strong></p><p class="muted">${variant==='quick'?'两部分共 10 题，各 5 分钟，不含听力，用于体验考试流程。':variant==='written'?'词汇 30 分钟，语法阅读 70 分钟。不含听力；成绩明确标记为笔试。':bank.official?`文字词汇 30 分钟，语法阅读 70 分钟，听力 ${bank.sections[2].minutes} 分钟。原录音含例题，听力限时按完整录音长度取整。按原卷题号选择数字答案；同组翻题不会中断录音。请先试音。`:'三个部分分别限时 30 / 70 / 40 分钟。请先试音，确认本设备可以朗读日语。'}</p><ul class="detail-list"><li>开始计时后，离开页面或锁屏不会暂停。</li><li>交卷后才能查看答案和解析，未答题按错误计入。</li><li>练习原始分数不等于 JLPT 官方尺度分数。</li></ul>${variant==='full'?`<div class="audio-box">${btn(icon('volume')+(bank.official?' 试听原版录音':' 播放日语试音'),'audio-test','secondary')}<span id="audio-status">${!bank.official&&audioReady?'日语试音已播放，请确认听到声音。':'试音后才能开始整卷。'}</span><p class="source-note">如果设备无法播放日语，可先选择「仅笔试」。</p></div>`:''}`,btn('返回','close-modal','ghost')+btn(variant==='full'?'我已听清，开始考试':'开始计时','confirm-exam'));
}
function startExam() {
 const {variant,bankId}=examRequest;
 const bank=getExamBank(bankId);
 if(variant==='full'&&!(bank.official?officialTestReady===bank.id:audioReady)){toast(bank.official?'请先试听原版录音，确认听到声音。':'请先完成日语试音；没有日语语音时可选择仅笔试。');return;} let sourceSections=bank.sections;
 if(variant==='written'||variant==='quick') sourceSections=sourceSections.slice(0,2);
 const sections=sourceSections.map((s,i)=>({...s,minutes:variant==='quick'?5:s.minutes,questions:variant==='quick'?s.questions.slice(0,5):s.questions}));
 const questions=sections.flatMap(s=>s.questions.map(q=>({...q,options:[...q.options]})));
 const run=()=>{officialPlayer.dispose();state.session={id:uid(),mode:'exam',title:bank.title+(variant==='written'?' · 仅笔试':variant==='quick'?' · 短卷体验':''),variant,source:bank.source,questions,sections:sections.map(s=>({name:s.name,minutes:s.minutes,ids:s.questions.map(q=>q.id)})),answers:{},flags:[],played:[],audioProgress:{},index:0,sectionIndex:0,completedSections:[],startedAt:Date.now(),deadline:Date.now()+sections[0].minutes*60000,phase:'active'};save();navTo('session');};
 closeModal();guardNewSession(run);
}
function currentQ() {return state.session?.questions[state.session.index];}
function currentSection() {return state.session?.sections?.[state.session.sectionIndex];}
function explanation(q,answer,showAnswer=true) {
 const reason=q.distractorExplanations?.[answer];
 return `${showAnswer?`<p class="correct-answer">正确答案：<strong class="jp">${e(q.answer)}</strong></p>`:''}${reason?`<p class="chosen-reason"><strong>为什么这个选项不对？</strong><br>${e(reason)}</p>`:''}<div class="teaching">${q.point?`<h4>${e(q.point)}</h4>`:''}<p>${e(q.explanation)}</p>${q.example?`<div class="example"><p class="jp">${e(q.example)}</p>${q.translation?`<p class="muted">${e(q.translation)}</p>`:''}</div>`:''}</div>${officialExplanation(q)}${q.audioText?`<details class="audio-transcript"><summary>查看听力原文</summary><p class="jp passage">${e(q.audioText)}</p></details>`:''}`;
}
function sessionView() {
 const s=state.session;
 if(s.phase==='between') return `<div class="quiz-page">${heading('ONE STEP AT A TIME','这一部分，完成了。',`${e(s.sections[s.sectionIndex].name)}已交卷，无法返回修改。`)}<section class="panel between-card"><span class="empty-icon">${icon('check')}</span><h2>准备进入下一部分</h2><p>${e(s.sections[s.sectionIndex+1].name)} · ${s.sections[s.sectionIndex+1].minutes} 分钟</p><p class="muted">下一部分将在你点击开始后计时。先调整一下状态。</p>${btn('开始下一部分 '+icon('arrow'),'next-section')}</section></div>`;
 const q=currentQ(), a=s.answers[q.id], exam=s.mode==='exam', sec=exam?currentSection():null, position=exam?sec.ids.indexOf(q.id)+1:s.index+1, count=exam?sec.ids.length:s.questions.length, done=!!a&&!exam;
 const starred=exam?(s.stars?.[q.id]??!!state.mistakes[q.id]?.starred):!!state.mistakes[q.id]?.starred, flagged=(s.flags||[]).includes(q.id);
 return `<div class="quiz-page"><div class="quiz-top"><button class="text-button" data-action="leave-session">${icon('x')} 暂存退出</button><span>${e(s.title)}</span>${exam?`<span class="timer" id="timer" aria-label="剩余时间">--:--</span>`:`<span class="pill green">${position} / ${count}</span>`}</div><div class="quiz-progress"><div class="row between"><small>${exam?e(sec.name):'专注这一题就好。'}</small><small>${exam?`${position} / ${count}`:`已作答 ${Object.keys(s.answers).length} 题`}</small></div><div class="progress-track"><div class="progress-fill" style="width:${pct(exam?sec.ids.filter(id=>s.answers[id]).length:Object.keys(s.answers).length,count)}%"></div></div></div><section class="question-card"><div class="question-meta"><div class="row wrap"><span class="pill green">${e(q.level)} · ${SUBJECTS[q.subject]}</span><span class="subtle">${e(q.topic||'基础练习')} · ${q.kind==='input'?'输入题':'选择题'}</span></div><button class="icon-button ${starred?'active':''}" data-action="star-current" aria-label="${starred?'取消重点标记':'标为重点'}" aria-pressed="${starred}">${icon('star')}</button></div>${q.passage?`<div class="passage jp">${e(q.passage)}</div>`:''}${q.context?`<p class="context jp">${e(q.context)}</p>`:''}<h1 class="question-prompt jp">${e(q.prompt)}</h1>${paperPages(q.pageImages,q.sourceLabel)}${q.audioSrc?officialAudioView(q):''}${q.audioText?`<div class="audio-box">${s.audioTextMode?'<span class="pill warm">阅读听力稿 · 非听音测试</span>':btn(icon('volume')+' '+(exam&&s.played.includes(q.id)?'已播放一次':'播放日语音频'),'play-question','secondary audio-button',exam&&s.played.includes(q.id)?'disabled':'')}<span class="subtle">${s.audioTextMode?'当前设备没有可用日语语音':exam?'每题播放一次 · 系统合成语音':'可重复播放 · 系统合成语音'}</span>${s.audioTextMode?`<p class="passage jp">${e(q.audioText)}</p>`:''}</div>`:''}${q.kind==='choice'?`<div class="options" role="group" aria-label="答案选项">${q.options.map((option,i)=>`<button class="option ${a?.value===option?'selected':''} ${done&&option===q.answer?'correct':''} ${done&&a.value===option&&!isCorrect(q,a.value)?'wrong':''}" data-action="answer-choice" data-index="${i}" ${done?'disabled':''} aria-pressed="${a?.value===option}"><span class="option-letter">${q.pageImages?e(option):String.fromCharCode(65+i)}</span><span class="option-text jp">${q.pageImages?'选项 '+e(option):e(option)}</span><span class="option-status">${done&&option===q.answer?icon('check'):done&&a.value===option?icon('x'):''}</span></button>`).join('')}</div>`:`<form id="answer-form" class="answer-form"><label class="sr-only" for="answer-input">输入日语答案</label><input class="answer-input jp" id="answer-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入日语答案…" value="${e(a?.value||s.drafts?.[q.id]||'')}" ${done?'disabled':''}>${btn('检查答案','answer-input','primary',done?'disabled':'type="submit"')}<small class="muted">可输入假名${q.subject==='verb'?'或汉字':''}；忽略空格、全半角差异。</small></form>`}${done?`<div class="feedback ${isCorrect(q,a.value)?'good':'bad'}" role="status"><div class="feedback-title">${icon(isCorrect(q,a.value)?'check':'leaf')}${isCorrect(q,a.value)?'答对了，把它记住。':'这道题，一起再看一遍。'}</div>${explanation(q,a.value,!isCorrect(q,a.value))}</div>`:''}<div class="quiz-actions"><div>${exam?btn(icon('flag')+(flagged?' 已标记':' 稍后检查'),'flag-question','ghost flag-button'+(flagged?' active':''),'aria-pressed="'+flagged+'"'):btn(icon('back')+' 上一题','previous-question','ghost',s.index===0?'disabled':'')}</div><div class="row">${exam?btn('上一题','previous-question','ghost',position===1?'disabled':''):''}${btn((position===count?(exam?'提交本部分':'查看本轮结果'):'下一题')+' '+icon('arrow'),'next-question','primary',!exam&&!done?'disabled':'')}</div></div></section>${exam?`<section class="panel question-nav-panel"><div class="row between"><h3>答题卡</h3><span class="subtle">实心 · 已答　圆点 · 待检查</span></div><div class="question-nav">${sec.ids.map((id,i)=>`<button class="question-dot ${s.answers[id]?'answered':''} ${id===q.id?'current':''} ${s.flags.includes(id)?'flagged':''}" data-action="jump-question" data-id="${e(id)}" aria-label="第 ${i+1} 题${s.answers[id]?'，已作答':''}${s.flags.includes(id)?'，已标记':''}" ${id===q.id?'aria-current="step"':''}>${i+1}</button>`).join('')}</div>${btn('提前提交本部分','ask-submit','ghost')}</section>`:''}<p class="source-note">${exam?`来源：${e(s.source?.name||'原创模拟')} · 交卷后显示解析`:q.sourceLabel?'来源：'+e(q.sourceLabel)+' · 按原卷题号作答':'原创学习练习 · 答错自动收进错题本'}</p></div>`;
}
function resultView() {
 const r=state.lastResult, score=scoreQuestions(r.questions,r.answers), wrong=r.questions.filter(q=>!r.answers[q.id]||!isCorrect(q,r.answers[q.id].value));
 return `${heading('A MOMENT TO REFLECT','每一次回顾，都让记忆更清晰。',e(r.title))}<section class="result-card"><span class="pill green">${r.partial?'部分完成':r.mode==='exam'?'已交卷':'本轮完成'}</span><div class="result-score">${score.correct}<span> / ${score.total}</span></div><p>${pct(score.correct,score.total)}% 正确 · ${wrong.length} 道待巩固${score.answered<score.total?` · ${score.total-score.answered} 道未作答`:''}</p><p class="muted">${r.mode==='exam'?'按题计分的练习结果，不是 JLPT 官方尺度分数。':'错题已自动记录；再遇见、再想起，就会记得更牢。'}</p><div class="row wrap">${btn('重练本轮错题 '+icon('refresh'),'retry-result','primary',wrong.length?'':'disabled')}${btn('回到今日','open-home','secondary')}</div></section><div class="score-grid section">${Object.entries(score.groups).map(([key,g])=>`<div class="score-item panel"><span>${GROUPS[key]||key}</span><strong>${g.correct} <small>/ ${g.total}</small></strong><div class="progress-track"><div class="progress-fill" style="width:${pct(g.correct,g.total)}%"></div></div></div>`).join('')}</div><section class="section"><div class="section-head"><h2>逐题回顾</h2><span class="subtle">${r.questions.length} 题 · 点击展开解析</span></div><div class="review-list">${r.questions.map((q,i)=>{const a=r.answers[q.id],ok=a&&isCorrect(q,a.value);return `<details class="review-item"><summary><span class="review-status ${ok?'good':'bad'}">${icon(ok?'check':'x')}</span><span><small>${i+1}. ${SUBJECTS[q.subject]} · ${e(q.topic||'基础练习')}</small><strong class="jp">${e(q.prompt)}</strong></span>${icon('chevron')}</summary><div class="review-content">${paperPages(q.pageImages,q.sourceLabel)}${q.passage?`<p class="passage jp">${e(q.passage)}</p>`:''}${q.context?`<p class="context jp">${e(q.context)}</p>`:''}<p>你的答案：<span class="jp">${e(a?.value||'未作答')}</span></p>${explanation(q,a?.value)}${btn(icon('star')+(state.mistakes[q.id]?.starred?' 取消重点':' 标为重点'),'star-result','small ghost',`data-id="${e(q.id)}"`)}</div></details>`;}).join('')}</div></section>`;
}
function submitAnswer(value) {
 const s=state.session,q=currentQ();if(!s||!q)return;
 if(s.mode==='exam'&&Date.now()>=s.deadline){submitSection(true);return;}
 if(s.mode!=='exam'&&s.answers[q.id])return;
 if(!String(value).trim()){toast('先输入答案，再检查。');$('#answer-input')?.focus();return;}
 s.answers[q.id]={value,time:Date.now()};
 if(s.mode!=='exam') {recordAttempt(state,q,value,s.id);haptic(!isCorrect(q,value));}
 else haptic();
 save();render();
 if(s.mode!=='exam') $('.feedback')?.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
}
function nextQuestion() {
 const s=state.session;if(!s)return;
 if(s.mode!=='exam') {if(!s.answers[currentQ().id])return;if(s.index===s.questions.length-1)return finishSession();s.index++;}
 else {const ids=currentSection().ids;if(currentQ().id===ids[ids.length-1])return askSubmit();s.index++;}
 stopQuestionAudio();save();render();window.scrollTo({top:0,behavior:'instant'});
}
function askSubmit() {
 const s=state.session,ids=currentSection().ids,unanswered=ids.filter(id=>!s.answers[id]).length;
 modal('提交这一部分？',`<p>共 ${ids.length} 题，已答 ${ids.length-unanswered} 题${unanswered?`，还有 <strong>${unanswered} 题未作答</strong>`:''}。</p><p class="muted">未作答按错误计入。提交后无法返回本部分；解析在整次考试结束后显示。</p>`,btn('继续检查','close-modal','secondary')+btn('确认交卷','submit-section'));
}
function submitSection(timedOut=false) {
 const s=state.session;if(!s||s.mode!=='exam'||s.phase!=='active')return;
 closeModal();stopAudio();s.completedSections.push(s.sectionIndex);
 if(s.sectionIndex===s.sections.length-1){finishSession();if(timedOut)toast('时间到，已自动交卷。');return;}
 s.phase='between';s.deadline=null;save();render();if(timedOut)toast('本部分时间到，已自动提交。');
}
function nextSection() {const s=state.session;s.sectionIndex++;s.phase='active';s.index=s.questions.findIndex(q=>q.id===s.sections[s.sectionIndex].ids[0]);s.deadline=Date.now()+currentSection().minutes*60000;save();render();}
function finishSession(partial=false) {
 const s=state.session;if(!s)return;stopAudio();
 let questions=s.questions;
 if(partial) {const included=new Set(s.mode==='exam'?s.sections.slice(0,s.sectionIndex+1).flatMap(x=>x.ids):Object.keys(s.answers));questions=questions.filter(q=>included.has(q.id));}
 if(s.mode==='exam') {
  for(const q of questions) recordAttempt(state,q,s.answers[q.id]?.value||'',s.id);
  for(const [id,starred] of Object.entries(s.stars||{})) {
   const q=s.questions.find(q=>q.id===id); if(!q)continue;
   const time=s.starTimes?.[id] || Date.now();
   if(time >= (state.mistakes[id]?.starredAt || 0))setStarred(state,q,starred,time);
  }
 }
 const result={id:s.id,mode:s.mode,title:s.title,questions,answers:s.answers,time:Date.now(),partial,audioTextMode:s.audioTextMode};
 const score=scoreQuestions(questions,s.answers);
 if(questions.length) {state.history=state.history.filter(h=>h.id!==s.id);state.history.push({id:s.id,mode:s.mode,title:s.title,time:Date.now(),correct:score.correct,total:score.total,partial});state.history=state.history.slice(-100);state.lastResult=result;}
 state.session=null;save();navTo(questions.length?'result':'home');
}
function updateTimer() {
 const s=state.session;if(!s||s.mode!=='exam'||s.phase!=='active')return;
 const remaining=Math.max(0,Math.ceil((s.deadline-Date.now())/1000));const timer=$('#timer');
 if(timer){timer.textContent=`${String(Math.floor(remaining/60)).padStart(2,'0')}:${String(remaining%60).padStart(2,'0')}`;timer.classList.toggle('low',remaining<=300);}
 if(remaining===0)submitSection(true);
}
function toggleStar(q) {const item=setStarred(state,q,!state.mistakes[q.id]?.starred);save();return item.starred;}
function japaneseVoice() {return 'speechSynthesis' in window?speechSynthesis.getVoices().find(v=>/^ja([-_]|$)/i.test(v.lang)):null;}
function speak(text,id,onEnd,onError) {
 const voice=japaneseVoice();
 if(!voice) {toast('此设备未检测到日语语音。请在设备中安装日语声音，或先练习笔试。');return false;}
 stopAudio();const utterance=new SpeechSynthesisUtterance(text);utterance.lang='ja-JP';utterance.voice=voice;utterance.rate=0.92;speakingId=id;
 utterance.onend=()=>{speakingId=null;onEnd?.();};
 utterance.onerror=event=>{speakingId=null;if(!['canceled','interrupted'].includes(event.error)){onError?.();toast('语音播放失败，请检查设备声音后重试。');}};
 speechSynthesis.speak(utterance);return true;
}
function audioTest() {
 const bank=$('#audio-status')?getExamBank(examRequest?.bankId):null;
 if(bank?.official){officialPlayer.test(bank.sections[2].questions[0],()=>{officialTestReady=bank.id;if($('#audio-status'))$('#audio-status').textContent='原版录音正在播放，听清后可以开始。';});return;}
 speak('こんにちは。日本語の音声を確認しています。音が聞こえたら、練習を始めましょう。','test',()=>{audioReady=true;if($('#audio-status'))$('#audio-status').textContent='试音播放完成。听清日语后可以开始。';toast('试音已播放。请确认设备中听到了日语。');});}
function playQuestion() {
 const s=state.session,q=currentQ();if(!q?.audioText)return;
 if(s.mode==='exam'&&s.played.includes(q.id))return;
 if(speakingId===q.id){toast('音频正在播放。');return;}
 const started=speak(q.audioText,q.id,null,()=>{if(state.session?.id!==s.id||s.mode!=='exam')return;s.played=s.played.filter(id=>id!==q.id);save();if(route==='session')render();});
 if(started&&s.mode==='exam'){s.played.push(q.id);save();render();}
}

function download(name, data) {const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function readJSON(file,maxBytes) {if(!file)return null;if(file.size>maxBytes)throw new Error(`文件过大，请选择小于 ${Math.round(maxBytes/1024)} KB 的 JSON 文件`);return JSON.parse(await file.text());}
function exportBackup() {download(`日和-学习备份-${dayKey()}.json`,{type:'hiyori-backup',exportedAt:new Date().toISOString(),state:{...state,session:null,lastResult:null}});toast('备份已生成，包含练习记录、错题和导入题库。');}
async function handleFile(input) {
 const file=input.files[0];if(!file)return;
 try {
  if(input.id==='bank-file') {
   if(state.banks.length>=3)throw new Error('当前最多保存 3 份导入题库，请先导出备份；可以在备份中整理后恢复。');
   pendingBank=validateBank(await readJSON(file,600*1024));
   modal('题库检查通过',`<p><strong>${e(pendingBank.title)}</strong></p><p>来源：${e(pendingBank.source.name)}</p><p>三个部分，共 ${pendingBank.total} 题。将保存到本设备，听力文字使用系统日语语音朗读。</p>`,btn('取消','close-modal','ghost')+btn('保存题库','confirm-bank'));
  } else {
   pendingBackup=validateBackup(await readJSON(file,20*1024*1024));
   modal('恢复学习记录？',`<p>备份内有 <strong>${pendingBackup.attempts.length} 次作答</strong>、${Object.keys(pendingBackup.mistakes).length} 道记录题目。</p><p class="notice">${cloud.getStatus().connected?'本次会合并学习记录、错题和标记；云端已有记录不会删除。题库和未完成练习将由备份替换。':'此操作会替换本设备的学习记录、题库和未完成练习。'}建议先导出当前记录。</p>`,btn('先导出当前记录','export-backup','secondary')+btn(cloud.getStatus().connected?'合并备份记录':'确认替换并恢复','confirm-backup'));
  }
 } catch(error) {toast('无法导入：'+error.message);} finally {input.value='';}
}
function inspectMistake(id) {const item=state.mistakes[id];if(!item)return;const q=item.question;modal('这道题，再看一遍',`<span class="pill green">${e(q.level)} · ${SUBJECTS[q.subject]}</span>${q.passage?`<p class="passage jp">${e(q.passage)}</p>`:''}${q.context?`<p class="context jp">${e(q.context)}</p>`:''}<h3 class="jp">${e(q.prompt)}</h3>${paperPages(q.pageImages,q.sourceLabel)}${item.lastAnswer?`<p>上次错误答案：${e(item.lastAnswer)}</p>`:''}${explanation(q,item.lastAnswer)}`,btn('关闭','close-modal','ghost')+btn('单独练习这题','review-one','primary',`data-id="${e(id)}"`));}
const actions={
 'cloud-create':()=>modal('开启跨设备同步',`<p>会为你创建独立的学习空间，并上传这台设备已有的 <strong>${state.attempts.length} 次作答</strong>、错题和重点标记。</p><p>开启后保存同步码，再到另一台设备输入。同一同步码共用一份记录；其他人使用自己的同步码。</p><p class="source-note">学习记录保存在 Supabase 云服务。试题音频、设备文件和同步码不写入云端学习记录表。</p>`,btn('取消','close-modal','ghost')+btn('开启并合并本机记录','cloud-confirm-create')),
 'cloud-confirm-create':createCloudSpace,
 'cloud-join':joinCloudDialog,
 'cloud-show-code':showCloudCode,
 'cloud-copy-code':async()=>{try{await navigator.clipboard.writeText(cloud.getCode());toast('同步码已复制，请只粘贴到自己的设备。');}catch{$('#cloud-code')?.select();toast('请长按同步码并复制。');}},
 'cloud-sync':()=>cloud.syncNow(),
 'cloud-disconnect':()=>modal('断开这台设备的同步？','<p>云端记录和其他设备不受影响。本设备会回到原来的独立记录。</p><p>尚未上传的记录仍留在本浏览器，重新连接同一同步码后继续同步。请先保存同步码。</p>',btn('先查看同步码','cloud-show-code','secondary')+btn('断开本设备','cloud-confirm-disconnect','ghost')),
 'cloud-confirm-disconnect':()=>{try{cloud.disconnect();closeModal();render();}catch(error){toast(error.message);}},
 'settings':()=>navTo('settings'),'open-home':()=>navTo('home'),'open-practice':()=>navTo('practice'),'open-exam':()=>navTo('exam'),'open-result':()=>navTo('result'),
 'close-modal':closeModal,
 'level':el=>{state.settings.level=el.dataset.level;save();render();},
 'daily':()=>guardNewSession(()=>startPractice(dailyQuestions(state.settings.goal),'今日练习')),
 'setup-words':()=>setup('words'),'setup-grammar':()=>setup('grammar'),'setup-verbs':()=>setup('verbs'),'setup-listening':()=>setup('listening'),
 'begin-practice':el=>beginPractice(el.dataset.kind),
 'resume':()=>{closeModal();navTo('session');},
 'replace-session':()=>{const callback=pendingStart;pendingStart=null;closeModal();finishSession(true);callback?.();},
 'leave-session':()=>{if(state.session.mode==='exam'&&state.session.phase==='active')modal('暂时离开考试？','<p>本部分倒计时会继续，回到页面时会按实际经过时间计算。时间用尽后，本部分将自动交卷。</p>',btn('留在考试','close-modal','secondary')+btn('暂存并离开','confirm-leave'));else navTo('home');},
 'confirm-leave':()=>{closeModal();save();navTo('home');},
 'answer-choice':el=>{const q=currentQ();submitAnswer(q.options[Number(el.dataset.index)]);},
 'answer-input':()=>submitAnswer($('#answer-input')?.value||''),
 'next-question':nextQuestion,
 'previous-question':()=>{const s=state.session,lower=s.mode==='exam'?s.questions.findIndex(q=>q.id===currentSection().ids[0]):0;if(s.index>lower){s.index--;stopQuestionAudio();save();render();}},
 'jump-question':el=>{const s=state.session;if(s.mode!=='exam'||!currentSection().ids.includes(el.dataset.id))return;s.index=s.questions.findIndex(q=>q.id===el.dataset.id);stopQuestionAudio();save();render();window.scrollTo({top:0,behavior:'instant'});},
 'star-current':()=>{const s=state.session,q=currentQ();if(s.mode==='exam'){s.stars ||= {};s.starTimes ||= {};s.stars[q.id]=!(s.stars[q.id]??!!state.mistakes[q.id]?.starred);s.starTimes[q.id]=Math.max(Date.now(),(s.starTimes[q.id]||state.mistakes[q.id]?.starredAt||0)+1);save();}else toggleStar(q);render();},
 'star-item':el=>{toggleStar(state.mistakes[el.dataset.id].question);render();},
 'star-result':el=>{const q=state.lastResult.questions.find(q=>q.id===el.dataset.id);const starred=toggleStar(q);el.innerHTML=icon('star')+(starred?' 取消重点':' 标为重点');toast(starred?'已标为重点':'已取消重点标记');},
 'flag-question':()=>{const s=state.session,id=currentQ().id;s.flags=s.flags.includes(id)?s.flags.filter(x=>x!==id):[...s.flags,id];save();render();},
 'exam-start':el=>examIntro(el.dataset.variant,el.dataset.bank),'confirm-exam':startExam,'ask-submit':askSubmit,'submit-section':()=>submitSection(),'next-section':nextSection,
 'audio-test':audioTest,'play-question':playQuestion,
 'official-practice':el=>{const bank=getExamBank(el.dataset.bank),section=bank?.sections[Number(el.dataset.section)];if(section)guardNewSession(()=>startPractice(section.questions,bank.title+' · '+section.name));},
 'official-play':()=>officialPlayer.play(currentQ()),'official-pause':()=>officialPlayer.pause(),
 'offline-bank':el=>cacheOfficialBank(el.dataset.bank),
 'import-official-audio':el=>document.querySelector(`.official-audio-file[data-bank="${el.dataset.bank}"]`)?.click(),
 'mistake-filter':el=>{mistakeFilter=el.dataset.filter;render();},
 'review-filter':()=>{const questions=filteredMistakes().map(i=>i.question);guardNewSession(()=>startPractice(questions,'错题复习','review',questions.some(q=>q.audioText)&&!japaneseVoice()));},
 'inspect-mistake':el=>inspectMistake(el.dataset.id),
 'review-one':el=>{const q=state.mistakes[el.dataset.id]?.question;if(!q)return;closeModal();guardNewSession(()=>startPractice([q],'重点回顾','review',!!q.audioText&&!japaneseVoice()));},
 'retry-result':()=>{const r=state.lastResult;const questions=r.questions.filter(q=>!r.answers[q.id]||!isCorrect(q,r.answers[q.id].value));guardNewSession(()=>startPractice(questions,'本轮错题重练','review',questions.some(q=>q.audioText)&&!japaneseVoice()));},
 'import-bank':()=>$('#bank-file').click(),
 'confirm-bank':()=>{if(!pendingBank)return;const id='bank-'+uid();const sections=pendingBank.sections.map((s,si)=>({...s,questions:s.questions.map((q,qi)=>({...q,id:id+'-'+si+'-'+qi}))}));state.banks.push({...pendingBank,id,sections});pendingBank=null;save();closeModal();render();toast('题库已保存到这台设备。');},
 'export-backup':exportBackup,'import-backup':()=>$('#backup-file').click(),
 'confirm-backup':()=>{if(!pendingBackup)return;try{const restored=cloud.getStatus().connected?mergeStates(pendingBackup,toSyncDocument(state)):pendingBackup;stopAudio();state=restored;pendingBackup=null;storageOK=true;save();closeModal();navTo('records');toast(storageOK?'学习记录已恢复。':'记录已载入，但未能写入本机存储，请立即导出备份。');}catch(error){toast('无法恢复：'+error.message);}},
};
document.addEventListener('click',event=>{const el=event.target.closest('[data-action]');if(!el||el.disabled)return;const action=actions[el.dataset.action];if(action){event.preventDefault();action(el);}});
document.addEventListener('submit',event=>{if(event.target.id==='cloud-join-form'){connectCloudFromForm(event);return;}if(event.target.id==='answer-form'){event.preventDefault();if(!event.isComposing)submitAnswer($('#answer-input').value);}});
document.addEventListener('keydown',event=>{if(event.target.id==='answer-input'&&event.key==='Enter'&&(event.isComposing||event.keyCode===229))event.preventDefault();});
document.addEventListener('input',event=>{const el=event.target;if(el.id==='answer-input'&&state.session){state.session.drafts[currentQ().id]=el.value;save();}if(el.id==='mistake-search'){mistakeSearch=el.value;const start=el.selectionStart;render();const next=$('#mistake-search');next.focus();try{next.setSelectionRange(start,start);}catch{}}});
document.addEventListener('change',event=>{const el=event.target;if(el.matches('.official-audio-progress')&&currentQ()?.audioSrc)officialPlayer.seek(currentQ(),el.value);if(el.id==='goal-select'){state.settings.goal=Number(el.value);save();toast('每日目标已更新。');}if(el.id==='haptics'){state.settings.haptics=el.checked;save();haptic();}if(el.id==='mistake-subject'){mistakeSubject=el.value;render();}if(el.matches('.official-audio-file'))handleOfficialAudioFile(el);if(['bank-file','backup-file'].includes(el.id))handleFile(el);});
$('#modal').addEventListener('click',event=>{if(event.target!==$('#modal'))return;const rect=$('#modal').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeModal();});
window.addEventListener('hashchange',()=>{route=location.hash.slice(1)||'home';stopAudio();render();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')updateTimer();});
window.addEventListener('pagehide',()=>{save();stopAudio();});
setInterval(updateTimer,1000);
// Trigger discovery early; Safari may populate voices asynchronously.
if('speechSynthesis' in window)speechSynthesis.getVoices();
render();
if(storageOK)cloud.init();
initOfficialMedia().then(()=>{if(route==='exam')render();});
if('serviceWorker' in navigator) {
 const prepareOffline=async()=>{
  try {await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;offlineStatus='基础题库已可离线使用。官方图文可按套保存；离线录音请在模考页从本机文件导入。';}
  catch {offlineStatus='离线资源暂未准备好，请联网后重新打开。';}
  if($('#offline-status'))$('#offline-status').textContent=offlineStatus;
 };
 if(document.readyState==='complete')prepareOffline();else window.addEventListener('load',prepareOffline,{once:true});
}
