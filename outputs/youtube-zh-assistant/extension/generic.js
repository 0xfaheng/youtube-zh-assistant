(() => {
  'use strict';
  if(location.origin==='https://www.youtube.com'||globalThis.YTZWebCleanup)return;
  const core=globalThis.YTZCore;
  if(!core)return;
  const state={videoId:core.pageKey(location.href),generation:0,enabled:false,bilingual:true,semanticSubtitles:true,...core.appearanceDefaults};
  const host=document.createElement('div');host.id='ytz-assistant-overlay';
  const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style');style.textContent=core.overlayCSS;
  const zh=document.createElement('p'),original=document.createElement('p'),badge=document.createElement('p');
  original.className='original';badge.className='status';shadow.append(style,zh,original,badge);
  const drag=core.installSubtitleDrag(host,state,()=>video?.getBoundingClientRect(),position=>send({type:'SET_SUBTITLE_POSITION',...position}).catch(()=>{status='字幕位置未能保存，请重新拖动';render();}),shadow);
  const semanticChanged=value=>{if(value!==undefined)status=value;render();};
  const semantic=globalThis.YTZSemantic.track({send:message=>send(message),state,changed:semanticChanged,error:error,title:()=>document.title});
  const liveSpeech=globalThis.YTZSemantic.live({send:message=>!state.semanticSubtitles&&audio?send({...message,type:'TRANSLATE',items:message.items.map(({id,text})=>({id,text}))}).then(r=>({segments:r.items.map(c=>({sourceIds:[c.id],text:c.text}))})):send(message),state,changed:semanticChanged,error:error,title:()=>document.title});
  let video=null,media='',track=null,cues=[],trackKey='',pending=new Set(),translated=new Map(),busy=false,blocked=false;
  let status='正在寻找网页视频…',domText='',domResult=null,audio=null,audioText=null,notifyAt=0,lastBatchAt=0;
  let settingsReady=false,settingsRevision=0,captionsSuppressed=false;
  const modes=new Map(),domCache=new Map(),nativeStyles=new Map();let scanAt=0,videoPool=[],cueStyle=null,cueVideo=null;
  function deepAll(selector,root=document){
    const roots=[root],seen=new Set(),result=[];
    while(roots.length&&seen.size<256){const item=roots.shift();if(seen.has(item))continue;seen.add(item);result.push(...item.querySelectorAll(selector));if(item.shadowRoot)roots.push(item.shadowRoot);for(const node of item.querySelectorAll('*'))if(node.shadowRoot)roots.push(node.shadowRoot);}
    return [...new Set(result)];
  }
  function playerRoot(){return video?.closest('#movie_player,media-player,.video-js,.plyr,.vp-player,.player')||video?.parentElement||video?.getRootNode?.().host;}
  function restoreNative(){for(const [node,saved]of nativeStyles){if(saved.value)node.style.setProperty('visibility',saved.value,saved.priority);else node.style.removeProperty('visibility');}nativeStyles.clear();cueVideo?.removeAttribute('data-ytz-cue-hidden');cueStyle?.remove();cueStyle=null;cueVideo=null;}
  function maskNative(active){
    if(!active){restoreNative();return;}
    const root=video.getRootNode?.()||document,container=root===document?document.head||document.body:root;
    if(cueVideo&&cueVideo!==video)restoreNative();cueVideo=video;video.toggleAttribute('data-ytz-cue-hidden',true);
    if(cueStyle?.parentNode!==container){cueStyle?.remove();cueStyle=document.createElement('style');cueStyle.textContent='video[data-ytz-cue-hidden]::cue{color:transparent!important;background-color:transparent!important;text-shadow:none!important}';container.append(cueStyle);}
    const player=playerRoot();if(!player)return;
    for(const node of deepAll('.vjs-text-track-display,.plyr__captions,.vp-captions,media-captions,.ytp-caption-window-container,.subtitles_placeholder',player)){if(!nativeStyles.has(node))nativeStyles.set(node,{value:node.style.getPropertyValue('visibility'),priority:node.style.getPropertyPriority('visibility')});node.style.setProperty('visibility','hidden','important');}
  }
  const send=message=>chrome.runtime.sendMessage(message).then(r=>{if(!r?.ok)throw new Error(r?.error||'插件后台未响应');return r;});
  const snapshot=()=>({videoId:state.videoId,generation:state.generation});
  const current=s=>core.isCurrent(s,state);
  function pageState(){const rect=video?.getBoundingClientRect();return {...snapshot(),paused:!video||video.paused,currentTime:video?.currentTime||0,playbackRate:video?.playbackRate||1,title:document.title,visibleArea:rect?rect.width*rect.height:0};}
  function notify(){notifyAt=Date.now();send({type:'PAGE_STATE',...pageState()}).catch(()=>{});}
  function restoreTracks(){for(const [item,mode] of modes){try{if(item.mode==='hidden')item.mode=mode;}catch{}}modes.clear();}
  function invalidate(clear=false){state.generation++;semantic.cancel(clear);liveSpeech.cancel();pending.clear();busy=false;audio=null;audioText=null;domText='';domResult=null;blocked=false;restoreNative();if(clear){restoreTracks();track=null;cues=[];trackKey='';translated.clear();domCache.clear();}notify();}
  function metadata(){media=video?.currentSrc||video?.src||'';invalidate(true);status='媒体已更新，正在重新读取网页字幕';render();}
  function seek(){invalidate();status=cues.length?state.semanticSubtitles&&semantic.at(video.currentTime)?'':'网页字幕 · 跳转后重新预取':'网页字幕 · 等待原字幕';render();}
  function pause(){audio=null;audioText=null;liveSpeech.cancel();notify();render();}
  function attach(next){
    if(video===next)return;
    if(video){video.removeEventListener('seeking',seek);video.removeEventListener('pause',pause);video.removeEventListener('loadedmetadata',metadata);video.removeEventListener('emptied',metadata);}
    video=next;media=video?.currentSrc||video?.src||'';invalidate(true);
    if(video){video.addEventListener('seeking',seek);video.addEventListener('pause',pause);video.addEventListener('loadedmetadata',metadata);video.addEventListener('emptied',metadata);status='等待网页字幕；没有字幕时可在插件中手动开启语音识别';}
  }
  function chooseVideo(){
    if(Date.now()-scanAt>=1000||!videoPool.some(v=>v.isConnected)){videoPool=deepAll('video');scanAt=Date.now();}
    return videoPool.filter(v=>{const r=v.getBoundingClientRect();return v.isConnected&&r.width>=150&&r.height>=80&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&getComputedStyle(v).visibility!=='hidden';}).sort((a,b)=>{
      const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return Number(a.paused)-Number(b.paused)||br.width*br.height-ar.width*ar.height;
    })[0]||null;
  }
  function readTrack(){
    if(!video||!state.enabled)return;
    const available=[...video.textTracks].filter(t=>['subtitles','captions'].includes(t.kind));
    const showing=available.filter(t=>t.mode==='showing'),retained=track&&available.includes(track)?track:null;
    const selected=retained&&showing.find(t=>t!==retained&&t.language&&(t.language!==retained.language||retained.mode==='disabled'));
    const next=selected||retained||showing.find(t=>t.language)||available.find(t=>/^en(?:-|$)/i.test(t.language))||showing[0]||available[0];
    if(!next){if(track){invalidate(true);status='原字幕轨已移除，等待网页字幕';}return;}
    if(next!==track){semantic.cancel(true);liveSpeech.cancel();restoreTracks();track=next;trackKey='';cues=[];translated.clear();pending.clear();state.generation++;busy=false;domResult=null;blocked=false;notify();}
    if(track.mode==='disabled'){modes.set(track,'disabled');track.mode='hidden';}
    const native=track.cues,count=native?.length||0;
    const point=cue=>cue?[cue.startTime,cue.endTime,cue.text]:null;
    const key=JSON.stringify([track.language,count,point(native?.[0]),point(native?.[count-1]),Array.from(track.activeCues||[],point)]);
    if(key===trackKey)return;trackKey=key;
    const nextCues=core.parseTextTrack(track),byId=new Map(nextCues.map(c=>[c.id,c]));
    const obsolete=cues.some(c=>!byId.has(c.id)||byId.get(c.id).text!==c.text);
    if(obsolete){state.generation++;semantic.cancel();liveSpeech.cancel();pending.clear();busy=false;domResult=null;notify();}
    for(const cue of cues)if(!byId.has(cue.id)||byId.get(cue.id).text!==cue.text)translated.delete(cue.id);
    cues=nextCues;
    if(cues.length&&!state.semanticSubtitles&&/^zh(?:-|$)/i.test(track.language)){for(const cue of cues)translated.set(cue.id,cue.text);status='网页中文字幕 · 已同步';}
  }
  function error(e){blocked=true;liveSpeech.cancel();status=e.message+'；自动翻译已暂停，关闭再开启可重试';render();}
  async function prefetch(){
    if(!settingsReady)return;
    if(state.semanticSubtitles){if(state.enabled&&!blocked&&video&&!video.error&&video.readyState>=2&&cues.length){semantic.set(cues);await semantic.prefetch(video.currentTime);}return;}
    if(!state.enabled||blocked||busy||!video||video.error||video.readyState<2||!cues.length||Date.now()-lastBatchAt<500)return;
    const items=core.lookAhead(cues,video.currentTime,translated,pending);if(!items.length)return;
    const s=snapshot();busy=true;status='网页字幕 · 正在提前翻译';lastBatchAt=Date.now();items.forEach(i=>pending.add(i.id));
    try{const result=await send({type:'TRANSLATE',...s,items,context:document.title});if(!current(s))return;
      if(!Array.isArray(result.items)||result.items.length!==items.length||result.items.some((item,i)=>item.id!==items[i].id||!core.cleanText(item.text)))throw new Error('网页字幕翻译不完整');
      for(const item of result.items)translated.set(item.id,core.cleanText(item.text));status='网页字幕 · 已同步';
    }catch(e){if(current(s))error(e);}finally{if(current(s)){busy=false;items.forEach(i=>pending.delete(i.id));render();}}
  }
  function visibleDOM(){
    const player=playerRoot();if(!player)return '';
    const masked=node=>{for(let n=node;n;n=n.parentElement||n.getRootNode?.().host)if(nativeStyles.has(n))return true;return false;};
    return core.cleanText(deepAll('.vjs-text-track-cue,.plyr__caption,.vp-captions span,.ytp-caption-segment,.subtitles_placeholder',player).filter(e=>getComputedStyle(e).display!=='none'&&(getComputedStyle(e).visibility!=='hidden'||masked(e))).map(e=>e.textContent).join(' '));
  }
  async function observeDOM(){
    if(!settingsReady)return;
    if(!video||!state.enabled||cues.length||audio||video.error||video.readyState<2){domText='';return;}
    const text=visibleDOM();domText=text;if(busy||blocked||!text)return;
    if(state.semanticSubtitles){liveSpeech.add(text,video.currentTime);liveSpeech.tick(text,video.currentTime);return;}
    if(domCache.has(text)){domResult={text,translation:domCache.get(text),time:video.currentTime,until:Date.now()+14000};return;}
    const s=snapshot(),time=video.currentTime;busy=true;
    try{const result=await send({type:'TRANSLATE',...s,items:[{id:'dom',text}],context:document.title});if(!current(s))return;
      const translation=core.cleanText(result.items?.find(i=>i.id==='dom')?.text);if(!translation)throw new Error('网页字幕翻译为空');
      domResult={text,translation,time,until:Date.now()+14000};domCache.set(text,translation);if(domCache.size>256)domCache.delete(domCache.keys().next().value);status='网页字幕兜底 · 有处理延迟';
    }catch(e){if(current(s))error(e);}finally{if(current(s)){busy=false;render();}}
  }
  function render(){
    const rect=video?.getBoundingClientRect(),full=document.fullscreenElement;
    host.style.display=state.enabled&&video?'':'none';if(!video||!state.enabled){
      if(video&&captionsSuppressed){for(const item of video.textTracks)if(['captions','subtitles'].includes(item.kind)&&item.mode==='showing'){if(!modes.has(item))modes.set(item,'showing');item.mode='hidden';}maskNative(true);}
      else{restoreTracks();restoreNative();}
      zh.textContent='';original.textContent='';badge.textContent='';return;
    }
    const parent=full&&full.tagName!=='VIDEO'?full:document.body;
    if(host.parentElement!==parent)parent.append(host);
    core.applyAppearance(host,state);host.style.position='fixed';host.style.left=(rect.left+rect.width*.05)+'px';host.style.right='auto';host.style.width=rect.width*.9+'px';
    host.style.top=state.subtitlePosition==='top'?(rect.top+rect.height*state.subtitleOffset/100)+'px':'auto';
    host.style.bottom=state.subtitlePosition==='bottom'?(innerHeight-rect.bottom+rect.height*state.subtitleOffset/100)+'px':'auto';
    host.dataset.captionSource=cues.length?'texttrack':'dom';host.dataset.cueCount=String(cues.length);host.dataset.translatedCount=String(translated.size);host.dataset.pendingCount=String(pending.size);host.dataset.batchLimit=String(core.maxBatch);
    let source='',chinese='',delayed=false,activeSemantic=null,activeDisplay=null;
    if(state.semanticSubtitles)semantic.set(cues);
    const live=(state.semanticSubtitles||audio?.deferred)&&!blocked&&(!cues.length||audio)?liveSpeech.tick(null,video.currentTime,{audio:!!audio,lowLatency:audio?.lowLatency===true}):null;
    if(video.readyState>=2&&!video.error){
      if(audio&&(state.semanticSubtitles||audio.deferred)){if(live){source=live.text;chinese=live.translation;delayed=true;activeSemantic=live;activeDisplay=live;}}
      else if(audio&&audioText&&audioText.until>Date.now()&&!video.paused){source=audioText.text;chinese=audioText.translation;activeDisplay=audioText;}
      else if(cues.length){const cue=state.semanticSubtitles?semantic.at(video.currentTime):core.cueAt(cues,video.currentTime);if(cue){source=cue.text;chinese=state.semanticSubtitles?cue.translation:translated.get(cue.id)||'';activeDisplay=cue;if(state.semanticSubtitles)activeSemantic=cue;}}
      else if(state.semanticSubtitles){if(live){source=live.text;chinese=live.translation;delayed=true;activeSemantic=live;activeDisplay=live;}}
      else if(domText&&domResult?.until>Date.now()){source=domResult.text;chinese=domResult.translation;delayed=domText!==domResult.text;activeDisplay=domResult;}
    }
    const rawChinese=chinese,rawSource=source;
    chinese=core.subtitleText(chinese);source=core.subtitleText(source);
    host.dataset.semantic=String(state.semanticSubtitles);host.dataset.semanticCount=String(semantic.count);host.dataset.groupStart=String(activeSemantic?.start??'');host.dataset.groupEnd=String(activeSemantic?.end??'');
    if(chinese){for(const item of video.textTracks)if(['captions','subtitles'].includes(item.kind)&&item.mode==='showing'){modes.set(item,'showing');item.mode='hidden';}}
    else if(track&&modes.get(track)==='showing'){track.mode='showing';modes.delete(track);}
    maskNative(!!chinese&&!delayed);host.toggleAttribute('data-delayed',delayed);
    if(delayed&&state.subtitlePosition==='bottom')host.style.bottom=(innerHeight-rect.bottom+rect.height*Math.min(70,state.subtitleOffset+18)/100)+'px';
    const shown=globalThis.YTZSemantic.writePair(zh,original,rawChinese,state.bilingual?rawSource:'',rect.width*.88,globalThis.YTZSemantic.captionProgress(activeDisplay,video.currentTime),state.videoId+':'+state.generation);
    host.dataset.captionPage=String(shown.page);host.dataset.captionPages=String(shown.pages);
    const second=Math.max(0,Math.floor(activeSemantic?.start??domResult?.time??0)),lateStatus=Math.floor(second/60)+':'+String(second%60).padStart(2,'0')+' · 延迟译文；'+status;
    core.writeCaption(badge,core.captionStatus(video.error?'视频播放异常，恢复后继续字幕':video.readyState<2?'视频暂未就绪，恢复播放后继续字幕':full?.tagName==='VIDEO'?'浏览器原生全屏无法叠加字幕，请使用网页播放器全屏':delayed?lateStatus:status));
    drag.update();
  }
  const interval=setInterval(()=>{
    const key=core.pageKey(location.href);if(key!==state.videoId){state.videoId=key;invalidate(true);}
    attach(chooseVideo());const src=video?.currentSrc||video?.src||'';if(media!==src){media=src;invalidate(true);}
    if(state.enabled){readTrack();prefetch();observeDOM();}render();if(Date.now()-notifyAt>=2000)notify();
  },250);
  function onHide(event){if(!event.persisted)cleanup();}
  function cleanup(){semantic.cancel(true);liveSpeech.cancel();drag.cleanup();clearInterval(interval);restoreTracks();restoreNative();window.removeEventListener('pagehide',onHide);chrome.runtime.onMessage.removeListener(receive);if(video){video.removeEventListener('seeking',seek);video.removeEventListener('pause',pause);video.removeEventListener('loadedmetadata',metadata);video.removeEventListener('emptied',metadata);}host.remove();delete globalThis.YTZWebCleanup;}
  globalThis.YTZWebCleanup=cleanup;window.addEventListener('pagehide',onHide);
  function receive(message,sender,respond){
    if(sender.id!==chrome.runtime.id)return;
    if(message.type==='RECHECK_SITE'){
      const revision=settingsRevision;
      send({type:'GET_SETTINGS'}).then(settings=>{if(revision!==settingsRevision)return;Object.assign(state,core.appearance(settings),{enabled:settings.enabled===true,bilingual:settings.bilingual!==false,semanticSubtitles:settings.semanticSubtitles!==false});captionsSuppressed=settings.captionsSuppressed===true;render();}).catch(cleanup);respond({ok:true});return;
    }
    if(message.type==='GET_PAGE_STATE'){respond(pageState());return;}
    if(message.type==='SETTINGS'){
      if(message.settings.siteEnabled===false){cleanup();respond({ok:true});return;}
      settingsRevision++;settingsReady=true;
      const enabled=state.enabled,smart=state.semanticSubtitles;Object.assign(state,core.appearance(message.settings),{enabled:message.settings.enabled!==false,bilingual:message.settings.bilingual!==false,semanticSubtitles:typeof message.settings.semanticSubtitles==='boolean'?message.settings.semanticSubtitles:state.semanticSubtitles});
      captionsSuppressed=typeof message.settings.captionsSuppressed==='boolean'?message.settings.captionsSuppressed:!state.enabled;
      if(enabled!==state.enabled||smart!==state.semanticSubtitles){invalidate();if(state.enabled){restoreTracks();readTrack();prefetch();observeDOM();}}render();respond({ok:true});
    }
    if(!current({videoId:message.videoId,generation:message.pageGeneration}))return;
    if(message.type==='AUDIO_STATE'){if(message.running){if(audio?.generation!==message.generation)liveSpeech.cancel();audio={generation:message.generation,lowLatency:message.lowLatency===true};}else if(audio?.generation===message.generation){audio=null;audioText=null;liveSpeech.cancel();}status=message.message;render();}
    if(message.type==='AUDIO_RESULT'&&audio?.generation===message.generation){if(blocked)return;audio.deferred=message.deferred===true;audio.lowLatency=message.lowLatency===true;if(state.semanticSubtitles||audio.deferred){liveSpeech.add(message.text,message.start??Math.max(0,video.currentTime-7),message.end??video.currentTime);liveSpeech.tick(null,video.currentTime,{audio:true,lowLatency:audio.lowLatency});}else audioText={text:message.text,translation:message.translation,until:Date.now()+14000};status='本机语音识别 · 正在衔接翻译，有处理延迟';render();}
    if(['AUDIO_PROGRESS','AUDIO_ERROR'].includes(message.type)&&audio?.generation===message.generation){status=message.message;render();}
  }
  chrome.runtime.onMessage.addListener(receive);
  const initialRevision=settingsRevision;
  send({type:'GET_SETTINGS'}).then(settings=>{if(initialRevision!==settingsRevision)return;Object.assign(state,core.appearance(settings),{enabled:settings.enabled===true,bilingual:settings.bilingual!==false,semanticSubtitles:settings.semanticSubtitles!==false});captionsSuppressed=settings.captionsSuppressed===true;settingsReady=true;render();}).catch(cleanup);
})();
