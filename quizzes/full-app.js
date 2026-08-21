const KEY="jp_new_two_pages_wrong_v2";

const $=id=>document.getElementById(id);
const home=$("home"),quiz=$("quiz"),result=$("result"),resume=$("resumeWrong");

let filter="all",mode="part1",session=[],idx=0,score=0,wrongs=[],answered=false;

function shuffle(a){
  a=[...a];
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function mutate(s){
  const o=[];
  if(s.includes("ー")){o.push(s.replace("ー",""));o.push(s.replace("ー","ッ"))}
  const sm={"っ":"つ","ゃ":"や","ゅ":"ゆ","ょ":"よ","ッ":"ツ","ャ":"ヤ","ュ":"ユ","ョ":"ヨ"};
  for(const [a,b] of Object.entries(sm)){if(s.includes(a)){o.push(s.replace(a,b));break}}
  const pairs={
    "か":"が","き":"ぎ","く":"ぐ","け":"げ","こ":"ご","さ":"ざ","し":"じ","す":"ず","せ":"ぜ","そ":"ぞ",
    "た":"だ","ち":"ぢ","つ":"づ","て":"で","と":"ど","は":"ば","ひ":"び","ふ":"ぶ","へ":"べ","ほ":"ぼ",
    "が":"か","ぎ":"き","ぐ":"く","げ":"け","ご":"こ","ざ":"さ","じ":"し","ず":"す","ぜ":"せ","ぞ":"そ",
    "だ":"た","で":"て","ど":"と","カ":"ガ","キ":"ギ","ク":"グ","ケ":"ゲ","コ":"ゴ","ガ":"カ","ギ":"キ",
    "グ":"ク","ゲ":"ケ","ゴ":"コ","バ":"パ","ビ":"ピ","ブ":"プ","ベ":"ペ","ボ":"ポ"
  };
  for(let i=0;i<s.length;i++){if(pairs[s[i]]){o.push(s.slice(0,i)+pairs[s[i]]+s.slice(i+1));break}}
  const m=[...s.matchAll(/[ぁ-んァ-ヶ]/g)];
  if(m.length){
    const p=m[m.length-1].index;
    o.push(s.slice(0,p)+s.slice(p+1));
    o.push(s.slice(0,p+1)+s[p]+s.slice(p+1));
  }
  if(s.endsWith("ます")){o.push(s.slice(0,-2)+"まつ");o.push(s.slice(0,-2)+"ました")}
  return [...new Set(o)].filter(x=>x&&x!==s);
}

function hard(item){
  if(SPECIAL[item.jp])return SPECIAL[item.jp];
  const a=[item.near,...mutate(item.jp)].filter((x,i,r)=>x&&x!==item.jp&&r.indexOf(x)===i);
  for(const v of VOCAB){
    if(a.length>=3)break;
    if(v.jp!==item.jp&&!a.includes(v.jp))a.push(v.jp);
  }
  return a.slice(0,3);
}

function indices(){
  return VOCAB.map((v,i)=>filter==="all"||String(v.page)===filter?i:-1).filter(i=>i>=0);
}

function vocabQuestion(i,m){
  const v=VOCAB[i];
  if(m==="part1"){
    const pool=VOCAB.map(x=>x.zh).filter(x=>x!==v.zh);
    return{
      id:`p1-${i}`,kind:"mcq",itemIndex:i,mode:m,prompt:v.jp,correct:v.zh,
      options:shuffle([v.zh,...shuffle(pool).slice(0,3)])
    };
  }
  return{
    id:`p2-${i}`,kind:"mcq",itemIndex:i,mode:m,prompt:v.zh,correct:v.jp,
    options:shuffle([v.jp,...hard(v)])
  };
}

function keigoQuestion(i){
  const q=KEIGO[i];
  return{
    id:`k-${i}`,kind:"fill",keigoIndex:i,mode:"keigo",
    prompt:q.prompt,base:q.base,category:q.category,
    correct:q.answer,accepted:q.accepted
  };
}

function start(m){
  mode=m;
  if(m==="keigo"){
    session=shuffle(KEIGO.map((_,i)=>keigoQuestion(i)));
  }else{
    session=shuffle(indices().map(i=>vocabQuestion(i,m)));
  }
  begin();
}

function rebuildWrong(w){
  if(w.mode==="keigo" || w.kind==="fill")return keigoQuestion(w.keigoIndex);
  return vocabQuestion(w.itemIndex,w.mode);
}

function startWrong(list){
  list=dedupe(list);
  if(!list.length){alert("目前没有错题。");return}
  mode="wrong";
  session=shuffle(list.map(rebuildWrong));
  begin();
}

function begin(){
  idx=0;score=0;wrongs=[];answered=false;
  home.classList.add("hidden");
  result.classList.add("hidden");
  quiz.classList.remove("hidden");
  render();
}

function render(){
  answered=false;
  const q=session[idx];
  $("sessionName").textContent=
    mode==="part1"?"第一部分":
    mode==="part2"?"第二部分":
    mode==="keigo"?"第三部分：敬语填空":"错题重练";
  $("counter").textContent=`${idx+1} / ${session.length}`;
  $("bar").style.width=`${idx/session.length*100}%`;
  $("bar").classList.toggle("keigo",q.kind==="fill");
  $("prompt").textContent=q.prompt;
  $("feedback").textContent="";
  $("nextBtn").classList.add("hidden");

  $("options").innerHTML="";
  $("options").classList.toggle("hidden",q.kind==="fill");
  $("fillWrap").classList.toggle("hidden",q.kind!=="fill");
  $("category").classList.toggle("hidden",q.kind!=="fill");
  $("base").classList.toggle("hidden",q.kind!=="fill");

  if(q.kind==="fill"){
    $("promptLabel").textContent="括号里的普通表达改成合适的敬语";
    $("category").innerHTML=`<span class="pill keigo">${esc(q.category)}</span>`;
    $("base").textContent=`原来的说法：${q.base}`;
    $("fillInput").value="";
    $("fillInput").disabled=false;
    $("fillInput").className="fill-input";
    $("checkFill").disabled=false;
    setTimeout(()=>$("fillInput").focus(),100);
  }else{
    $("promptLabel").textContent=q.mode==="part1"?"请选择正确的中文意思":"请选择正确的日语写法";
    q.options.forEach(t=>{
      const b=document.createElement("button");
      b.className="option";
      b.textContent=t;
      b.onclick=()=>chooseMCQ(b,t);
      $("options").appendChild(b);
    });
  }
}

function chooseMCQ(btn,selected){
  if(answered)return;
  answered=true;
  const q=session[idx];
  [...document.querySelectorAll(".option")].forEach(b=>{
    b.disabled=true;
    if(b.textContent===q.correct)b.classList.add("correct");
  });

  if(selected===q.correct){
    score++;
    $("feedback").textContent="✓ 回答正确";
    removeSaved(q.id);
  }else{
    btn.classList.add("wrong");
    $("feedback").innerHTML=`✕ 正确答案：<strong>${esc(q.correct)}</strong>`;
    registerWrong(q,selected);
  }
  $("nextBtn").classList.remove("hidden");
}

function normalize(s){
  return String(s||"")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[　\s。、，,．.!！?？「」『』（）()]/g,"")
    .replace(/ご存知/g,"ご存じ")
    .replace(/頂/g,"いただ")
    .replace(/戴/g,"いただ")
    .replace(/致/g,"いた")
    .replace(/伺/g,"うかが")
    .replace(/拝見/g,"はいけん")
    .replace(/参/g,"まい")
    .replace(/召し上が/g,"めしあが")
    .replace(/申/g,"もう")
    .replace(/お目/g,"おめ")
    .replace(/お帰り/g,"おかえり")
    .replace(/お休み/g,"おやすみ");
}

function checkFill(){
  if(answered)return;
  const q=session[idx];
  const raw=$("fillInput").value.trim();
  if(!raw){
    $("feedback").textContent="先输入答案再检查。";
    $("fillInput").focus();
    return;
  }

  answered=true;
  const accepted=q.accepted.map(normalize);
  const ok=accepted.includes(normalize(raw));
  $("fillInput").disabled=true;
  $("checkFill").disabled=true;

  if(ok){
    score++;
    $("fillInput").classList.add("correct");
    $("feedback").textContent="✓ 回答正确";
    removeSaved(q.id);
  }else{
    $("fillInput").classList.add("wrong");
    $("feedback").innerHTML=`✕ 正确答案：<strong>${esc(q.correct)}</strong>`;
    registerWrong(q,raw);
  }
  $("nextBtn").classList.remove("hidden");
}

function registerWrong(q,selected){
  const w={
    id:q.id,kind:q.kind,mode:q.mode,
    itemIndex:q.itemIndex,keigoIndex:q.keigoIndex,
    prompt:q.prompt,selected,correct:q.correct,
    category:q.category||""
  };
  wrongs.push(w);
  saveWrong(w);
}

function next(){
  idx++;
  idx>=session.length?finish():render();
}

function finish(){
  quiz.classList.add("hidden");
  result.classList.remove("hidden");
  $("score").textContent=`${score} / ${session.length}`;
  $("resultMessage").textContent=wrongs.length
    ?`这一轮有${wrongs.length}道错题，已汇总在下面。`
    :"这一轮全部答对，没有新增错题。";
  $("retryWrong").disabled=!wrongs.length;
  $("retryAllWrong").disabled=!saved().length;
  $("resultType").textContent=
    mode==="keigo"?"敬语填空完成":
    mode==="wrong"?"错题重练完成":"本部分完成";
  renderWrongs();
  updateResume();
}

function renderWrongs(){
  const box=$("wrongList");
  box.innerHTML="";
  if(!wrongs.length)return;

  const h=document.createElement("h3");
  h.textContent="本轮错题汇总";
  box.appendChild(h);

  wrongs.forEach((w,i)=>{
    const d=document.createElement("div");
    d.className="wrong-item";
    let tag="";
    if(w.mode==="keigo"||w.kind==="fill"){
      tag=`<span class="pill keigo">${esc(w.category||"敬语填空")}</span>`;
    }else{
      tag=`<span class="pill">第${VOCAB[w.itemIndex].page}页</span>`;
    }
    d.innerHTML=`
      <div class="wrong-q">${i+1}. ${esc(w.prompt)} ${tag}</div>
      <div class="wrong-a bad">你的答案：${esc(w.selected||"（未填写）")}</div>
      <div class="wrong-a good-text">正确答案：${esc(w.correct)}</div>
    `;
    box.appendChild(d);
  });
}

function saved(){
  try{return JSON.parse(localStorage.getItem(KEY)||"[]")}catch{return[]}
}
function setSaved(a){localStorage.setItem(KEY,JSON.stringify(dedupe(a)))}
function dedupe(a){
  const m=new Map();
  a.forEach(w=>m.set(w.id,w));
  return[...m.values()];
}
function saveWrong(w){setSaved([...saved(),w])}
function removeSaved(id){setSaved(saved().filter(w=>w.id!==id))}
function updateResume(){
  const n=saved().length;
  resume.disabled=!n;
  resume.textContent=n?`练习已保存错题（${n}题）`:"练习已保存错题（暂无）";
}
function esc(s){
  return String(s??"")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

document.querySelectorAll(".filter").forEach(b=>b.onclick=()=>{
  filter=b.dataset.filter;
  document.querySelectorAll(".filter").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
});

$("startPart1").onclick=()=>start("part1");
$("startPart2").onclick=()=>start("part2");
$("startKeigo").onclick=()=>start("keigo");
$("nextBtn").onclick=next;
$("checkFill").onclick=checkFill;
$("fillInput").addEventListener("keydown",e=>{
  if(e.key==="Enter"){e.preventDefault();checkFill()}
});
$("retryWrong").onclick=()=>startWrong(wrongs);
$("retryAllWrong").onclick=()=>startWrong(saved());
$("restartSame").onclick=()=>{
  if(mode==="part1"||mode==="part2"||mode==="keigo")start(mode);
  else startWrong(saved());
};
$("backHome").onclick=()=>{
  result.classList.add("hidden");
  quiz.classList.add("hidden");
  home.classList.remove("hidden");
  updateResume();
};
resume.onclick=()=>startWrong(saved());
updateResume();
