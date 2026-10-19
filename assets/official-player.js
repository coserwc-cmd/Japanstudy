import {audioSource} from './official-media.js';

// One persistent audio element per group: rendering an answer never restarts it.
export function createOfficialPlayer({getSession, save, changed, error}) {
  let audio=null, key=null, group=null, owner=null, preview=false, lastSaved=0, previewTimer=null;
  function makeAudio(src) {
    const element=new Audio(audioSource(src));element.id='official-recording';element.hidden=true;
    document.body.append(element);return element;
  }
  function progress() {
    const s=getSession();
    if (!audio || preview || s?.id!==owner) return;
    s.audioProgress ||= {};
    s.audioProgress[group]={position:audio.currentTime || 0, ended:audio.ended, duration:Number.isFinite(audio.duration)?audio.duration:0};
  }
  function pause() { if(audio) {audio.pause();progress();save();changed();} }
  function dispose() {
    clearTimeout(previewTimer); pause();
    if(audio) {audio.removeAttribute('src');audio.load();audio.remove();}
    audio=null;key=null;
  }
  function state(q) {
    const s=getSession(), active=key===`${s?.id}:${q.audioGroup}` && !preview;
    const stored=s?.audioProgress?.[q.audioGroup] || {};
    return {playing:active && audio && !audio.paused, position:active?audio.currentTime:stored.position || 0,
      duration:active && Number.isFinite(audio.duration)?audio.duration:stored.duration || 0,
      seekable:!!(active && audio?.seekable.length && audio.seekable.end(audio.seekable.length-1)>0),
      ended:active?audio.ended || stored.ended:!!stored.ended};
  }
  async function play(q) {
    const s=getSession();if(!s || !q.audioSrc)return;
    const stored=s.audioProgress?.[q.audioGroup] || {};
    if(s.mode==='exam' && stored.ended)return;
    const nextKey=`${s.id}:${q.audioGroup}`;
    if(key!==nextKey || preview) {
      dispose();key=nextKey;owner=s.id;group=q.audioGroup;preview=false;
      audio=makeAudio(q.audioSrc);audio.preload='metadata';
      const element=audio;
      element.addEventListener('loadedmetadata',()=>{
        if(audio!==element)return;
        if(stored.position && !stored.ended) element.currentTime=Math.min(stored.position,element.duration || stored.position);
        changed();
      });
      element.addEventListener('timeupdate',()=>{
        if(audio!==element)return;
        progress();changed();
        if(Date.now()-lastSaved>3000){lastSaved=Date.now();save();}
      });
      element.addEventListener('ended',()=>{if(audio===element){progress();save();changed();}});
      element.addEventListener('error',()=>{if(audio===element){progress();save();changed();error('原版音频加载失败，请检查网络，或在模考页导入从官网保存的原版录音后重试。');}});
    }
    if(audio.ended && s.mode!=='exam')audio.currentTime=0;
    try { await audio.play();changed(); }
    catch { error('音频未能播放，请再次点击播放，并检查网络和设备音量。'); }
  }
  function seek(q,position) {
    if(getSession()?.mode==='exam')return;
    if(key===`${getSession()?.id}:${q.audioGroup}` && audio && Number.isFinite(audio.duration)) {
      audio.currentTime=Math.max(0,Math.min(Number(position)||0,audio.duration));progress();save();changed();
    }
  }
  async function test(q,onPlayed) {
    dispose();preview=true;key='preview';audio=makeAudio(q.audioSrc);
    const element=audio;
    element.addEventListener('playing',()=>{
      if(audio!==element)return;
      onPlayed();previewTimer=setTimeout(()=>{if(audio===element)dispose();},8000);
    },{once:true});
    try {await element.play();} catch {error('原版录音试音失败，请检查网络和设备音量后重试。');}
  }
  function navigate(q) {
    if(preview || group!==q?.audioGroup || owner!==getSession()?.id)pause();
  }
  return {play,pause,dispose,state,seek,test,navigate};
}
