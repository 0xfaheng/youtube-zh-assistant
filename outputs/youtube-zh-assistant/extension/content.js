(() => {
  'use strict';
  const core = globalThis.YTZCore;
  const state = {videoId: '', generation: 0, enabled: false,captionsSuppressed:false, bilingual: true,semanticSubtitles:true,...core.appearanceDefaults};
  let video = null, cues = [], tracks = [], loadedTrack = '', nativeTrackKey = '', loading = false, pending = new Set(), translated = new Map(), attemptedTracks = new Set();
  let status = '正在寻找字幕轨…', lastDom = '', domTranslation = '', domResult = null, domAt = 0, domTimer = null, domBusy = null, fallback = false, ccAttempted = false;
  let retryAt = 0, failures = 0, audio = null, audioText = null, lastBatchAt = 0, translationBlocked = false;
  let cueSource = 'native', timePrecision = 'milliseconds', transcriptRequested = false, fallbackSince = Date.now();
  let settingsReady=false,settingsRevision=0;
  const cueLabel = () => cueSource==='transcript' ? '文字稿模式' : '字幕轨模式';
  const domCache = new Map();
  const host = document.createElement('div'); host.id = 'ytz-assistant-overlay';
  const shadow = host.attachShadow({mode: 'closed'});
  const style = document.createElement('style');
  style.textContent = core.overlayCSS;
  const zh = document.createElement('p'), original = document.createElement('p'), badge = document.createElement('p');
  const nativeStyles = new Map();
  original.className = 'original'; badge.className = 'status'; shadow.append(style, zh, original, badge);
  const drag=core.installSubtitleDrag(host,state,()=>{const p=host.parentElement;return p?{left:0,top:0,width:p.clientWidth,height:p.clientHeight}:null;},position=>send({type:'SET_SUBTITLE_POSITION',...position}).catch(()=>{status='字幕位置未能保存，请重新拖动';render();}),shadow);
  const semanticChanged=value=>{if(value!==undefined)status=value;render();};
  const semantic=globalThis.YTZSemantic.track({send,state,changed:semanticChanged,error:translationError,title:()=>document.title});
  const liveSpeech=globalThis.YTZSemantic.live({send:message=>!state.semanticSubtitles&&audio?send({...message,type:'TRANSLATE',items:message.items.map(({id,text})=>({id,text}))}).then(r=>({segments:r.items.map(c=>({sourceIds:[c.id],text:c.text}))})):send(message),state,changed:semanticChanged,error:translationError,title:()=>document.title});
  function send(message) { return chrome.runtime.sendMessage(message).then(r => {if (!r?.ok) throw new Error(r?.error || '扩展后台未响应'); return r;}); }
  function snapshot() { return {videoId:state.videoId, generation:state.generation}; }
  function current(s) { return core.isCurrent(s, state); }
  function pageState() { return {...snapshot(), paused: !video || video.paused, currentTime:video?.currentTime || 0, playbackRate:video?.playbackRate || 1, title:document.title}; }
  function requestNative() {window.postMessage({source:'ytz-native-captions-request-v1',videoId:state.videoId},location.origin);}
  function syncNativeCC() {
    if(!state.videoId||ccAttempted||(!state.enabled&&!state.captionsSuppressed))return;
    const button=document.querySelector('.ytp-subtitles-button');
    if(!button||button.getAttribute('aria-disabled')==='true')return;
    const pressed=button.getAttribute('aria-pressed');if(!['true','false'].includes(pressed))return;
    ccAttempted=true;
    if((pressed==='true')!==state.enabled)button.click();
  }
  function notifyState() { send({type:'PAGE_STATE', ...pageState()}).catch(() => {}); }
  function invalidate() { state.generation++;semantic.cancel();liveSpeech.cancel(); pending.clear(); loading = false; audio = null; audioText = null; translationBlocked = false; domTranslation = ''; domResult = null; lastDom = ''; domBusy = null; clearTimeout(domTimer); domTimer = null; notifyState(); render(); }
  function videoChanged(id) {
    window.postMessage({source:'ytz-transcript-cancel-v1',videoId:videoNowForCancel()},location.origin);
    state.videoId = id; invalidate();semantic.cancel(true); cues = []; tracks = []; translated.clear(); domCache.clear(); attemptedTracks.clear(); loadedTrack = ''; nativeTrackKey = ''; fallback = false; ccAttempted = false; failures = 0; retryAt = 0; cueSource='native';timePrecision='milliseconds';transcriptRequested=false;fallbackSince=Date.now(); status = id ? '正在寻找字幕轨…' : ''; render();
  }
  function videoNowForCancel() {return new URL(location.href).searchParams.get('v')||'';}
  function attachVideo(next) {
    if (video === next) return;
    if (video) {video.removeEventListener('seeking', seek); video.removeEventListener('pause', pause);}
    video = next;
    if (video) {video.addEventListener('seeking', seek); video.addEventListener('pause', pause);}
  }
  function seek() {invalidate(); if(transcriptRequested&&!cues.length&&state.enabled)window.postMessage({source:'ytz-transcript-request-v1',...snapshot()},location.origin); status = cues.length ? state.semanticSubtitles&&semantic.at(video.currentTime)?'':`${cueLabel()} · 跳转后重新预取` : 'DOM 字幕兜底 · 有延迟';render();}
  function pause() { audio = null; audioText = null;liveSpeech.cancel(); notifyState(); render(); }
  function showError(error) {
    failures++; retryAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(failures, 4));
    status = error.message.includes('429') ? error.message + '（60 秒后重试）' : error.message;
    if (error.message.includes('429')) retryAt = Date.now() + 60000;
    render();
  }
  function translationError(error) {
    translationBlocked = true;
    liveSpeech.cancel();
    showError(new Error(error.message + '；自动翻译已暂停，关闭再开启中文字幕可重试'));
  }
  function mount() {
    const player = document.getElementById('movie_player') || video?.parentElement;
    if (player && host.parentElement !== player) player.append(host);
  }
  function render() {
    mount();
    core.applyAppearance(host,state);
    host.style.display = state.enabled && state.videoId ? '' : 'none';
    host.dataset.captionMode = cues.length ? 'track' : fallback ? 'dom' : 'loading';
    host.dataset.batchLimit = String(core.maxBatch);
    host.dataset.captionSource = cueSource;
    host.dataset.timePrecision = timePrecision;
    host.dataset.cueCount = String(cues.length);
    host.dataset.firstCueStart = String(cues[0]?.start ?? '');
    host.dataset.lastCueEnd = String(cues.at(-1)?.end ?? '');
    host.dataset.lastCueStart = String(cues.at(-1)?.start ?? '');
    host.dataset.translatedCount = String(translated.size);
    host.dataset.pendingCount = String(pending.size);
    let source = '', chinese = '', delayedDom = false,activeSemantic=null,activeDisplay=null;
    if(state.semanticSubtitles)semantic.set(cues);
    const live=(state.semanticSubtitles||audio?.deferred)&&!translationBlocked&&Date.now()>=retryAt&&(!cues.length||audio)?liveSpeech.tick(null,video?.currentTime||0,{audio:!!audio,lowLatency:audio?.lowLatency===true}):null;
    if(audio&&(state.semanticSubtitles||audio.deferred)){if(live){source=live.text;chinese=live.translation;delayedDom=true;activeSemantic=live;activeDisplay=live;}}
    else if (audio && audioText && audioText.until > Date.now() && !video?.paused) {
      source = audioText.text; chinese = audioText.translation;activeDisplay=audioText;
    } else if (cues.length && video && !video.error && video.readyState>=2) {
      const cue = state.semanticSubtitles?semantic.at(video.currentTime):core.cueAt(cues, video.currentTime);
      if (cue) {source = cue.text; chinese = state.semanticSubtitles?cue.translation:translated.get(cue.id) || '';activeDisplay=cue;if(state.semanticSubtitles)activeSemantic=cue;}
    } else if (fallback) {
      if(state.semanticSubtitles){if(live){source=live.text;chinese=live.translation;delayedDom=true;activeSemantic=live;activeDisplay=live;}}
      else if (lastDom && domTranslation && Date.now() - domAt < 10000) {source = lastDom; chinese = domTranslation;if(domResult?.text===lastDom&&domResult.until>Date.now())activeDisplay=domResult;}
      else if (domResult && domResult.until > Date.now()) {source = domResult.text; chinese = domResult.translation; delayedDom = true;activeDisplay=domResult;}
      else if (lastDom && Date.now() - domAt < 10000) source = lastDom;
    }
    const rawChinese=chinese,rawSource=source;
    chinese=core.subtitleText(chinese);source=core.subtitleText(source);
    host.dataset.semantic=String(state.semanticSubtitles);host.dataset.semanticCount=String(semantic.count);host.dataset.groupStart=String(activeSemantic?.start??'');host.dataset.groupEnd=String(activeSemantic?.end??'');
    // Only replace native captions once an actual translation is available.
    // A pending/failed model request must never leave the user without subtitles.
    const replaceNative = !!(state.captionsSuppressed || state.enabled && state.videoId && chinese && !delayedDom);
    const nativeNodes = [...document.querySelectorAll('.ytp-caption-window-container')];
    for (const node of nativeNodes) {
      if (replaceNative) {
        if (!nativeStyles.has(node)) nativeStyles.set(node, {value:node.style.getPropertyValue('visibility'), priority:node.style.getPropertyPriority('visibility')});
        node.style.setProperty('visibility','hidden','important');
      }
    }
    for (const [node, saved] of nativeStyles) {
      if (!replaceNative || !node.isConnected) {
        if (saved.value) node.style.setProperty('visibility',saved.value,saved.priority); else node.style.removeProperty('visibility');
        nativeStyles.delete(node);
      }
    }
    if (!state.enabled) {zh.textContent='';original.textContent='';badge.textContent='';return;}
    const captionWidth=(host.parentElement?.clientWidth||1000)*.88;
    host.toggleAttribute('data-delayed', delayedDom);
    const nativeHasText = !replaceNative && core.captionSegments(document).some(node => node.textContent?.trim());
    const shown=globalThis.YTZSemantic.writePair(zh,original,rawChinese,state.bilingual && (!nativeHasText || delayedDom)?rawSource:'',captionWidth,globalThis.YTZSemantic.captionProgress(activeDisplay,video?.currentTime),state.videoId+':'+state.generation);
    host.dataset.captionPage=String(shown.page);host.dataset.captionPages=String(shown.pages);
    const seconds = Math.max(0, Math.floor(activeSemantic?.start??domResult?.videoTime ?? 0));
    const time = `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
    core.writeCaption(badge, core.captionStatus(video?.error ? '视频播放异常，恢复播放后继续字幕' : video&&video.readyState<2 ? '视频暂未就绪，恢复播放后继续字幕' : status + (delayedDom ? ` · 显示 ${time} 处的延迟译文` : '')));
    drag.update();
  }
  async function loadTrack() {
    if (!state.enabled || loading || !tracks.length || cues.length || Date.now() < retryAt) return;
    const track = tracks[0], key = track.baseUrl;
    if (loadedTrack === key) return;
    loading = true; attemptedTracks.add(key); const s = snapshot(); status = '正在读取字幕轨…';
    try {
      const result = await send({type:'GET_CAPTIONS', track});
      if (!current(s)) return;
      cues = result.cues; cueSource='native';timePrecision='milliseconds'; loadedTrack = key; translated.clear(); pending.clear(); fallback = false; failures = 0;
      if (!state.semanticSubtitles&&/^zh(?:-|$)/i.test(track.languageCode)) {
        for (const cue of cues) translated.set(cue.id, cue.text);
        status = '中文字幕轨 · 已同步';
      } else {status = '字幕轨模式 · 提前翻译 90 秒'; await prefetch();}
    } catch (error) {
      if (!current(s)) return;
      tracks.shift(); loadedTrack = ''; fallback = true;
      status = '字幕轨读取失败；DOM 字幕兜底 · 有延迟';
      // Exhausting tracks must not block DOM translation through the shared retry clock.
      if (!tracks.length) retryAt = 0;
    } finally {if (current(s)) loading = false;}
  }
  async function prefetch() {
    if(!settingsReady)return;
    if(state.semanticSubtitles){if(state.enabled&&!translationBlocked&&Date.now()>=retryAt&&video&&!video.error&&video.readyState>=2&&cues.length){semantic.set(cues);await semantic.prefetch(video.currentTime);}return;}
    if (!state.enabled || translationBlocked || !video || video.error || video.readyState<2 || !cues.length || Date.now() < retryAt || pending.size || Date.now() - lastBatchAt < 500) return;
    const items = core.lookAhead(cues, video.currentTime, translated, pending);
    if (!items.length) return;
    const s = snapshot(); items.forEach(i => pending.add(i.id)); lastBatchAt = Date.now();
    try {
      const result = await send({type:'TRANSLATE', items, ...s, context:document.title});
      if (!current(s)) return;
      const allowed = new Set(items.map(i => i.id));
      if (!Array.isArray(result.items)) throw new Error('翻译服务返回格式不正确');
      let received = 0;
      for (const item of result.items) if (allowed.has(item?.id) && typeof item.text === 'string' && item.text.trim()) {translated.set(item.id, core.cleanText(item.text)); received++;}
      if (!received) throw new Error('翻译服务没有返回字幕');
      failures = 0; retryAt = 0; status = cueSource==='transcript' ? `文字稿模式 · 已预取（${timePrecision==='seconds'?'秒级时间':'毫秒时间'}）` : '字幕轨模式 · 已同步';
    } catch (error) {if (current(s)) translationError(error);}
    finally {if (current(s)) {items.forEach(i => pending.delete(i.id)); render();}}
  }
  function observeDOM() {
    if(!settingsReady)return;
    if (!fallback || cues.length || !state.enabled || audio) return;
    const text = core.cleanText(core.captionSegments(document).map(n => n.textContent).join(' '));
    if(state.semanticSubtitles){if(!translationBlocked&&Date.now()>=retryAt){liveSpeech.add(text,video?.currentTime||0);liveSpeech.tick(text,video?.currentTime||0);}return;}
    if (text === lastDom) {if (text) domAt = Date.now();}
    else {clearTimeout(domTimer); domTimer = null; lastDom = text; domTranslation = domCache.get(text) || ''; domAt = Date.now(); render();}
    if (!text || domTranslation || translationBlocked || domTimer || domBusy || Date.now() < retryAt) return;
    const s = snapshot();
    domTimer = setTimeout(async () => {
      domTimer = null;
      if (!current(s) || lastDom !== text || !state.enabled) return;
      domBusy = s;
      const videoTime = video?.currentTime || 0;
      try {
        const result = await send({type:'TRANSLATE', items:[{id:'dom', text}], ...s, context:document.title});
        if (!current(s)) return;
        const item = result.items?.find(i => i.id === 'dom');
        if (!item?.text) throw new Error('DOM 字幕翻译为空');
        const translation = core.cleanText(item.text);
        domResult = {text,translation,videoTime,until:Date.now()+14000};
        domCache.set(text, translation);
        if (domCache.size > 256) domCache.delete(domCache.keys().next().value);
        failures = 0; retryAt = 0;
        if (lastDom === text) {domTranslation = translation; status = 'DOM 字幕兜底 · 随原字幕出现后翻译，有延迟'; render();}
        else {status = 'DOM 字幕翻译有延迟，原句与中文对应显示'; render();}
      } catch (error) {if (current(s)) translationError(error);}
      finally {if (domBusy === s) domBusy = null;}
    }, 400);
  }
  window.addEventListener('message', event => {
    const locationVideo = new URL(location.href).searchParams.get('v') || '';
    if (event.source===window && event.origin===location.origin && event.data?.source==='ytz-transcript-captions-v1' && event.data.videoId===locationVideo && state.enabled && !cues.length && current(event.data) && transcriptRequested) {
      let transcriptCues;
      try {if(JSON.stringify(event.data.segments).length>8000000)return;transcriptCues=core.parseTranscript(event.data.segments,video?.duration);} catch {return;}
      if(!transcriptCues.length)return;
      invalidate();cues=transcriptCues;cueSource='transcript';timePrecision=event.data.precision==='milliseconds'?'milliseconds':'seconds';translated.clear();tracks=[];fallback=false;retryAt=0;failures=0;
      status='文字稿模式 · 正在提前翻译，请稍候';prefetch();render();return;
    }
    if (event.source === window && event.origin === location.origin && event.data?.source === 'ytz-native-captions-v1' && event.data.videoId === locationVideo && state.enabled) {
      if (locationVideo !== state.videoId && /^[\w-]{11}$/.test(locationVideo)) videoChanged(locationVideo);
      const track = core.validateTrack(event.data.track, state.videoId);
      const key = track && `${track.languageCode}|${track.kind}`;
      if (!track || !event.data.track.native || loadedTrack === track.baseUrl || (cues.length && nativeTrackKey === key) || !Array.isArray(event.data.data?.events) || event.data.data.events.length > 50000) return;
      let nativeCues;
      try {if (JSON.stringify(event.data.data).length > 10000000) return; nativeCues = core.parseJSON3(event.data.data);} catch {return;}
      if (!nativeCues.length) return;
      window.postMessage({source:'ytz-transcript-cancel-v1',videoId:state.videoId},location.origin);
      invalidate(); cues = nativeCues; cueSource='native';timePrecision='milliseconds'; loadedTrack = track.baseUrl; nativeTrackKey = key; translated.clear(); tracks = []; fallback = false; retryAt = 0; failures = 0;
      if (!state.semanticSubtitles&&/^zh(?:-|$)/i.test(track.languageCode)) {
        for (const cue of cues) translated.set(cue.id, cue.text);
        status = '中文字幕轨 · 已同步';
      } else {status = '字幕轨模式 · 正在提前翻译，请稍候'; prefetch();}
      render(); return;
    }
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'ytz-caption-tracks-v1' || event.data.videoId !== locationVideo || !Array.isArray(event.data.tracks)) return;
    if (locationVideo !== state.videoId && /^[\w-]{11}$/.test(locationVideo)) videoChanged(locationVideo);
    const valid = event.data.tracks.slice(0, 40).map(t => core.validateTrack(t, state.videoId)).filter(Boolean);
    if (valid.length && !cues.length && !loading && !tracks.length && attemptedTracks.size < 3) {
      tracks = valid.filter(t => !attemptedTracks.has(t.baseUrl)).sort((a,b) => (/^zh/.test(a.languageCode) ? -100 : /^en/.test(a.languageCode) ? -10 : 0) + (a.kind === 'asr' ? 1 : 0) - ((/^zh/.test(b.languageCode) ? -100 : /^en/.test(b.languageCode) ? -10 : 0) + (b.kind === 'asr' ? 1 : 0))).slice(0, 3 - attemptedTracks.size);
      if (tracks.length) {retryAt = 0; loadTrack();}
    }
    if (!valid.length && !cues.length && !loading && !fallback) {fallback = true; if (Date.now() >= retryAt) status = '未找到可读取字幕轨；DOM 翻译完成前保留原字幕';}
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'GET_PAGE_STATE') {respond(pageState()); return;}
    if (message.type === 'SETTINGS') {
      settingsRevision++;settingsReady=true;
      const id=new URL(location.href).searchParams.get('v')||'';
      if(id!==state.videoId)videoChanged(/^[\w-]{11}$/.test(id)?id:'');
      attachVideo(document.querySelector('video'));
      const wasEnabled = state.enabled,wasSemantic=state.semanticSubtitles; Object.assign(state, {enabled:message.settings.enabled!==false, bilingual:message.settings.bilingual!==false,semanticSubtitles:typeof message.settings.semanticSubtitles==='boolean'?message.settings.semanticSubtitles:state.semanticSubtitles,...core.appearance(message.settings)});
      state.captionsSuppressed=typeof message.settings.captionsSuppressed==='boolean'?message.settings.captionsSuppressed:!state.enabled;
      if (wasEnabled !== state.enabled||wasSemantic!==state.semanticSubtitles) {invalidate();ccAttempted=false; if (state.enabled) {retryAt = 0;transcriptRequested=false; requestNative(); loadTrack();prefetch();} else window.postMessage({source:'ytz-transcript-cancel-v1',videoId:state.videoId},location.origin);}
      syncNativeCC();
      render(); respond({ok:true});
    }
    if (message.type === 'AUDIO_STATE') {
      if (!current({videoId:message.videoId, generation:message.pageGeneration})) return;
      if (!message.running && audio && audio.generation !== message.generation) return;
      if (message.running) {if(audio?.generation!==message.generation)liveSpeech.cancel();audio = {generation:message.generation,lowLatency:message.lowLatency===true};} else {audio = null; audioText = null;liveSpeech.cancel();}
      status = message.message; render();
    }
    if (message.type === 'AUDIO_PROGRESS' && audio?.generation === message.generation && current({videoId:message.videoId, generation:message.pageGeneration})) {
      status = message.message; render();
    }
    if (message.type === 'AUDIO_RESULT' && audio?.generation === message.generation && current({videoId:message.videoId, generation:message.pageGeneration})) {
      if(translationBlocked||Date.now()<retryAt)return;
      audio.deferred=message.deferred===true;audio.lowLatency=message.lowLatency===true;
      if(state.semanticSubtitles||audio.deferred){liveSpeech.add(message.text,message.start??Math.max(0,(video?.currentTime||0)-7),message.end??video?.currentTime);liveSpeech.tick(null,video?.currentTime||0,{audio:true,lowLatency:audio.lowLatency});}
      else audioText = {text:message.text, translation:message.translation, until:Date.now()+14000}; status = '音频识别 Beta · 等待后文，有处理延迟'; render();
    }
    if (message.type === 'AUDIO_ERROR' && audio?.generation === message.generation && current({videoId:message.videoId, generation:message.pageGeneration})) {status = '音频识别：' + message.message; render();}
  });
  const initialRevision=settingsRevision;
  send({type:'GET_SETTINGS'}).then(settings => {if(initialRevision!==settingsRevision)return;state.enabled = settings.enabled === true;state.captionsSuppressed=settings.captionsSuppressed===true; state.bilingual = settings.bilingual !== false;state.semanticSubtitles=settings.semanticSubtitles!==false;Object.assign(state,core.appearance(settings));settingsReady=true;syncNativeCC(); render();}).catch(showError);
  setInterval(() => {
    const id = new URL(location.href).searchParams.get('v') || '';
    if (id !== state.videoId) {videoChanged(/^[\w-]{11}$/.test(id) ? id : ''); if (state.videoId) requestNative();}
    attachVideo(document.querySelector('video'));
    syncNativeCC();
    if(state.enabled && fallback && !cues.length && !audio && !transcriptRequested && !translationBlocked && Date.now()-fallbackSince>=20000 && state.videoId) {
      transcriptRequested=true;
      window.postMessage({source:'ytz-transcript-request-v1',...snapshot()},location.origin);
    }
    if (state.enabled) {loadTrack(); prefetch(); observeDOM();} render();
  }, 250);
})();
