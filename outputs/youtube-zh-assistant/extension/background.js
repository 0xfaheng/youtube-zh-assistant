import './core.js';
const core = globalThis.YTZCore;
const BASE = 'http://127.0.0.1:17865';
const defaults = {enabled: false,captionsSuppressed:false, bilingual: true,semanticSubtitles:true,...core.appearanceDefaults};
const version=chrome.runtime.getManifest().version;
const settingKeys = ['enabled','captionsSuppressed','bilingual','semanticSubtitles',...Object.keys(core.appearanceDefaults)];
const frameStates = new Map();
const inFlight = new Map();
let active = 0, queue = [], capture = null, offscreenCreating = null, audioOperation = Promise.resolve(), captureRequest = null;
const restored = chrome.storage.session.get('capture').then(value => {capture = value.capture || null;});
// Content scripts cannot read pairing credentials through chrome.storage.
chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}).catch(console.error);
const ready = Promise.all([chrome.storage.local.get(settingKeys),chrome.storage.session.get('manualActivation')]).then(([value,session])=>chrome.storage.local.set({...defaults,...value,enabled:session.manualActivation?.version===version&&session.manualActivation.enabled===true,captionsSuppressed:session.manualActivation?.version===version&&session.manualActivation.enabled===false}));
let siteOperation=Promise.resolve(),settingsOperation=Promise.resolve();
async function enabledPatterns() {const {enabledSites=[]}=await chrome.storage.local.get('enabledSites');return [...new Set(enabledSites.flatMap(origin=>core.sitePatterns(origin)))];}
async function isWebPage(sender) {
  if(sender.id!==chrome.runtime.id || !(sender.tab?.id>=0) || !Number.isInteger(sender.frameId) || sender.frameId<0 || isYouTube(sender))return false;
  const origin=core.siteOrigin(sender.url);if(!origin || origin==='https://www.youtube.com')return false;
  for(const pattern of await enabledPatterns())if(core.siteMatches(sender.url,[pattern])&&await chrome.permissions?.contains({origins:[pattern]}))return true;
  return false;
}
async function syncSites() {
  if(!chrome.scripting || !chrome.permissions)return;
  const permitted=[];for(const pattern of await enabledPatterns())if(await chrome.permissions.contains({origins:[pattern]}))permitted.push(pattern);
  const exists=(await chrome.scripting.getRegisteredContentScripts({ids:['web-video-sites']})).length>0;
  const script={id:'web-video-sites',matches:permitted,js:['core.js','semantic.js','generic.js'],allFrames:true,runAt:'document_idle',persistAcrossSessions:true};
  if(permitted.length){if(exists)await chrome.scripting.updateContentScripts([script]);else await chrome.scripting.registerContentScripts([script]);}
  else if(exists)await chrome.scripting.unregisterContentScripts({ids:['web-video-sites']});
}
ready.then(async()=>{await restored;if(capture&&!(await chrome.storage.local.get('enabled')).enabled)await stopCapture('译幕未启用，音频识别已停止');await syncSites();}).catch(console.error);
async function reconcileSites(){
  await syncSites();await restored;
  if(capture){
    const current=capture;
    const frame=frameStates.get(current.tabId+':'+(current.frameId??0));
    const url=current.frameUrl||frame?.url||current.frameOrigin||frame?.origin||(await chrome.tabs.get(current.tabId).catch(()=>null))?.url;
    const origin=core.siteOrigin(url);
    if(origin!=='https://www.youtube.com'&&!await isWebPage({id:chrome.runtime.id,url,frameId:current.frameId??0,tab:{id:current.tabId}}))await stopCapture('网站访问权限已撤销，音频识别已停止',current.generation);
  }
  // Host permissions may already be gone, so query IDs rather than URL matches.
  // Each injected frame checks its own authorization through the background.
  await Promise.all((await chrome.tabs.query({})).map(tab=>tell(tab.id,{type:'RECHECK_SITE'})));
}
chrome.permissions?.onRemoved?.addListener(()=>{siteOperation=siteOperation.catch(()=>{}).then(reconcileSites);siteOperation.catch(console.error);return siteOperation;});
async function configureSite(message) {
  const tab=await chrome.tabs.get(message.tabId),origin=core.siteOrigin(tab.url);
  if(!tab.active || !origin || origin==='https://www.youtube.com' || origin!==message.origin)throw new Error('当前网页已变化，请重新打开插件');
  const patterns=core.sitePatterns(origin),{enabledSites=[]}=await chrome.storage.local.get('enabledSites');
  if(message.type==='ENABLE_SITE'){
    if(!await chrome.permissions.contains({origins:patterns}))throw new Error('尚未授权此网站');
    await chrome.storage.local.set({enabledSites:[...new Set([...enabledSites,origin])]});await syncSites();
    try{await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},files:['core.js','semantic.js','generic.js']});}catch{return {siteEnabled:true,refreshRequired:true};}
    return {siteEnabled:true};
  }
  await chrome.storage.local.set({enabledSites:enabledSites.filter(item=>item!==origin)});await syncSites();
  const settings=await chrome.storage.local.get(settingKeys);
  for(const target of await chrome.tabs.query({url:patterns}))await tell(target.id,{type:'SETTINGS',settings:{...settings,siteEnabled:false}});
  if(capture?.tabId===tab.id)await stopCapture('已停用此网站');
  for(const key of frameStates.keys())if(key.startsWith(tab.id+':'))frameStates.delete(key);
  // Keep a shared embedded-player grant if another enabled website still needs it.
  const remaining=await enabledPatterns(),remove=patterns.filter(p=>!remaining.includes(p));
  if(remove.length){try{const removed=await chrome.permissions.remove({origins:remove});if(!removed)return {siteEnabled:false,permissionRetained:true};}catch{return {siteEnabled:false,permissionRetained:true};}}
  return {siteEnabled:false};
}
function isYouTube(sender) {
  try { const u = new URL(sender.url); return sender.id === chrome.runtime.id && sender.tab?.id >= 0 && sender.frameId === 0 && u.origin === 'https://www.youtube.com'; } catch { return false; }
}
function isOwnPage(sender, name) { return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(name); }
function isLocalSettings(sender) {
  try { const url = new URL(sender.url); return sender.id === chrome.runtime.id && sender.frameId === 0 && sender.tab?.id >= 0 && url.origin === BASE && url.pathname === '/'; } catch { return false; }
}
async function saveVerifiedToken(candidate) {
  if (typeof candidate !== 'string' || !/^[a-f0-9]{64}$/.test(candidate)) throw new Error('配对码应为 64 位；请从 start.cmd 打开的设置页一键配对');
  let response;
  try {
    response = await fetch(BASE + '/pairing', {headers:{Authorization:`Bearer ${candidate}`},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
  } catch { throw new Error('无法连接本机服务，请先双击 start.cmd；原配对码未改动'); }
  if (!response.ok) throw new Error('配对码与当前服务不匹配，请双击 start.cmd，使用设置页的“一键配对浏览器插件”；原配对码未改动');
  const status = await response.json();
  if (status.ok !== true || status.service !== 'youtube-zh-assistant') throw new Error('本机服务未确认配对，原配对码未改动');
  await chrome.storage.local.set({token:candidate});
  return {paired:true,verified:true,version};
}
// sender.url can retain the document's first URL after YouTube SPA navigation.
function pageVideo(sender) { return isYouTube(sender) ? new URL(sender.tab?.url || sender.url).searchParams.get('v') : core.pageKey(sender.frameId===0 ? sender.tab?.url || sender.url : sender.url); }
async function api(path, body, authenticated = true, externalSignal = null) {
  if (!['/health', '/status', '/pairing', '/translate', '/translate-segments', '/transcribe'].includes(path)) throw new Error('不允许的接口');
  const {token} = authenticated ? await chrome.storage.local.get('token') : {};
  if (authenticated && !token) throw new Error('请在扩展中保存本机配对 token');
  const post = body !== undefined && body !== null;
  const timeoutMs = path === '/transcribe' ? 300000 : ['/translate','/translate-segments'].includes(path) ? 150000 : 15000;
  // Only reads are safe to repeat. A failed POST may already have consumed model usage.
  for (let attempt = 0; attempt < (post ? 1 : 2); attempt++) {
    const controller = new AbortController(); let timedOut = false;
    const cancel = () => controller.abort();
    externalSignal?.addEventListener('abort', cancel, {once:true});
    if (externalSignal?.aborted) cancel();
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, timeoutMs);
    // A paused video may emit no events during model work. Keep only this bounded
    // operation active; the interval always ends on completion, error or cancel.
    const keepAlive=post?setInterval(()=>chrome.storage.session.get('capture').catch(()=>{}),20000):null;
    try {
      if (controller.signal.aborted) throw new Error('请求已取消');
      const response = await fetch(BASE + path, {method: post ? 'POST' : 'GET', headers: {...(authenticated ? {Authorization: `Bearer ${token}`} : {}), ...(post ? {'Content-Type': 'application/json'} : {}), ...(['/translate','/translate-segments','/transcribe'].includes(path)?{'X-YTZ-Progress':'1'}:{})}, body: post ? JSON.stringify(body) : undefined, signal: controller.signal});
      let data;
      try {data = await response.json();} catch {throw new Error('本机服务返回了无效 JSON');}
      if (controller.signal.aborted) throw new Error('请求已取消');
      if (!response.ok || data.ok===false) {
        const status=!response.ok?response.status:Number.isInteger(data.status)&&data.status>=400&&data.status<=599?data.status:502;
        const error = new Error(status === 429 ? '429：服务限流，请稍后再试或检查账户额度' : `${status}：${String(data.error?.message || data.error || '本机服务请求失败').slice(0, 300)}`);
        error.status = status; throw error;
      }
      return data;
    } catch (error) {
      if (externalSignal?.aborted) {const cancelled = new Error('已停止等待旧请求；已经提交的模型调用可能继续完成'); cancelled.code = 'CAPTURE_CANCELLED'; throw cancelled;}
      if (timedOut) throw new Error(`本机${path === '/transcribe' ? '语音识别与翻译' : '服务'}请求超时${post ? '，结果尚未确认；未自动重试' : ''}`);
      if (post) throw new Error(`${error.message}${error.status === 429 ? '' : '；未自动重试'}`);
      if (attempt || (error.status && ![502, 503, 504].includes(error.status))) throw error;
      await new Promise(resolve => setTimeout(resolve, 800));
    } finally {
      clearTimeout(timer);if(keepAlive)clearInterval(keepAlive); externalSignal?.removeEventListener('abort', cancel);
    }
  }
}
function enqueue(key, work, owner=null) {
  let task=inFlight.get(key);
  if(task?.settled)return task.error?Promise.reject(task.error):Promise.resolve(task.value);
  if(!task){
    if(queue.length>=12)return Promise.reject(new Error('翻译队列已满，请稍后再试'));
    task={key,work,controller:new AbortController(),waiters:new Set()};inFlight.set(key,task);queue.push(task);
  }
  const promise=new Promise((resolve,reject)=>task.waiters.add({owner,resolve,reject}));
  drain();return promise;
}
function cancelTranslations(matches) {
  for(const task of inFlight.values()){
    if(task.settled)continue;
    for(const waiter of task.waiters){
      if(waiter.owner&&matches(waiter.owner)){task.waiters.delete(waiter);waiter.reject(new Error('旧字幕请求已取消；已开始的模型调用可能继续完成'));}
    }
    if(!task.waiters.size){
      task.controller.abort();queue=queue.filter(item=>item!==task);
      if(inFlight.get(task.key)===task)inFlight.delete(task.key);
    }
  }
}
function translationOwner(sender,message){
  const frameKey=sender.tab.id+':'+sender.frameId,frame=frameStates.get(frameKey);
  const sameDocument=!sender.documentId||!frame?.documentId||sender.documentId===frame.documentId;
  const generation=message.generation??(sameDocument?frame?.generation:0)??0;
  if(!Number.isSafeInteger(generation)||generation<0||sameDocument&&frame&&frame.videoId===message.videoId&&generation<frame.generation)throw new Error('字幕请求已过期');
  return {tabId:sender.tab.id,frameKey,documentId:sender.documentId,videoId:message.videoId,generation};
}
function drain() {
  while (active < 2 && queue.length) {
    const task = queue.shift(); active++;
    Promise.resolve().then(()=>{if(task.controller.signal.aborted)throw new Error('旧字幕请求已取消');return task.work(task.controller.signal);}).then(
      value=>{task.settled=true;task.value=value;for(const waiter of task.waiters)waiter.resolve(value);},error=>{task.settled=true;task.error=error;for(const waiter of task.waiters)waiter.reject(error);}
    ).finally(()=>{task.waiters.clear();if(inFlight.get(task.key)===task)inFlight.delete(task.key);active--;drain();});
  }
}
async function tell(tabId, message, frameId) { try { return await chrome.tabs.sendMessage(tabId, message,frameId===undefined?undefined:{frameId}); } catch { return null; } }
function serializeAudio(operation) {
  const task = audioOperation.catch(() => {}).then(operation);
  audioOperation = task; return task;
}
function stopCapture(reason = '音频识别已停止', expectedGeneration) {return serializeAudio(() => releaseCapture(reason, expectedGeneration));}
async function releaseCapture(reason, expectedGeneration) {
  await restored;
  if (expectedGeneration && capture?.generation !== expectedGeneration) return;
  const previous = capture; capture = null;
  let stoppedReason = reason;
  if (captureRequest && (!previous || captureRequest.generation === previous.generation)) {
    stoppedReason += '；已停止等待旧请求，已经提交的模型调用可能继续完成';
    captureRequest.controller.abort(); captureRequest = null;
  }
  await chrome.storage.session.remove('capture');
  if (offscreenCreating) await offscreenCreating;
  try {
    if (await chrome.offscreen.hasDocument()) {
      try { await chrome.runtime.sendMessage({target: 'offscreen', type: 'STOP'}); } catch {}
      // Closing the owning document also releases any stream if STOP did not acknowledge.
      await chrome.offscreen.closeDocument();
    }
  } finally {
    if (previous) await tell(previous.tabId, {type: 'AUDIO_STATE', running: false, generation:previous.generation, pageGeneration:previous.pageGeneration, videoId:previous.videoId, droppedChunks:0,processedChunks:0,message: stoppedReason},previous.frameId);
  }
}
async function makeOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreating) offscreenCreating = chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: '采集用户手动开启的标签页音频并保持回放'}).finally(() => {offscreenCreating = null;});
  await offscreenCreating;
}
function startCapture(tabId) {return serializeAudio(() => beginCapture(tabId));}
async function beginCapture(tabId) {
  if ((await chrome.storage.local.get('enabled')).enabled !== true) throw new Error('请先在插件面板点击“启用译幕”');
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active || !(tab.url?.startsWith('https://www.youtube.com/') || await isWebPage({id:chrome.runtime.id,url:tab.url,frameId:0,tab}))) throw new Error('请先切换到 YouTube 或已启用的 HTTPS 视频网站');
  await api('/pairing');
  const health = await api('/health', null, false);
  if (!health.audioConfigured) throw new Error('本地模型不可用或语音 API 未配置，请打开设置页检查');
  const frame=[...frameStates.values()].filter(s=>s.tabId===tabId&&!s.paused&&Date.now()-s.at<10000).sort((a,b)=>b.visibleArea-a.visibleArea)[0];
  const frameId=frame?.frameId ?? 0;
  const state = await tell(tabId, {type: 'GET_PAGE_STATE'},frameId);
  if (!state?.videoId || state.paused) throw new Error('请先播放网页视频，并刷新已打开的页面');
  await releaseCapture('正在重新开启音频识别');
  const generation = crypto.randomUUID();
  try {
    await makeOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId: tabId});
    const freshState = await tell(tabId, {type:'GET_PAGE_STATE'},frameId);
    const freshTab = await chrome.tabs.get(tabId);
    if (!freshState || freshState.paused || freshState.videoId !== state.videoId || freshState.generation !== state.generation || !freshTab.active) throw new Error('视频状态已变化，音频识别启动已取消');
    capture = {tabId, frameId, frameOrigin:frame?.origin||core.siteOrigin(tab.url),frameUrl:frame?.url||tab.url, windowId:tab.windowId, generation, videoId: state.videoId, pageGeneration: state.generation, droppedChunks:0, processedChunks:0};
    await chrome.storage.session.set({capture});
    const result = await chrome.runtime.sendMessage({target: 'offscreen', type: 'START', streamId, generation});
    if (!result?.ok) throw new Error(result?.error || '无法启动音频采集');
    if (capture?.generation !== generation) throw new Error('视频状态已变化，音频识别启动已取消');
    const afterStart = await tell(tabId, {type:'GET_PAGE_STATE'},frameId);
    if (!afterStart || afterStart.paused || afterStart.videoId !== state.videoId || afterStart.generation !== state.generation) throw new Error('视频状态已变化，音频识别启动已取消');
    await tell(tabId, {type: 'AUDIO_STATE', running: true,lowLatency:true, generation, pageGeneration: state.generation, videoId:state.videoId, droppedChunks:0,processedChunks:0,message: '低延迟采音：约 2 秒一片，停顿提前提交，识别和翻译衔接处理'},frameId);
    return {running: true};
  } catch (error) { await releaseCapture('音频识别启动失败'); throw error; }
}
async function handle(message, sender) {
  await restored;
  await ready;
  if (message.target === 'offscreen') return;
  const popup = isOwnPage(sender, 'popup.html'), offscreen = isOwnPage(sender, 'offscreen.html'), page = isYouTube(sender) || await isWebPage(sender), local = isLocalSettings(sender);
  if (!popup && !offscreen && !page && !local) throw new Error('不允许的消息来源');
  if(['GET_CAPTIONS','TRANSLATE','TRANSLATE_SEGMENTS','START_AUDIO','AUDIO_CHUNK'].includes(message.type)&&!(await chrome.storage.local.get('enabled')).enabled)throw new Error('译幕尚未启用，请在插件面板点击“启用译幕”');
  if (local) {
    if (message.type !== 'PAIR_LOCAL') throw new Error('设置页只允许配对操作');
    return saveVerifiedToken(message.token);
  }
  if (popup) {
    switch (message.type) {
      case 'GET_SETTINGS': {
        await ready; const s = await chrome.storage.local.get([...settingKeys,'token']);
        const c = capture;
        const audioStatus = c ? {running:true,tabId:c.tabId,generation:c.generation,pageGeneration:c.pageGeneration,videoId:c.videoId,droppedChunks:c.droppedChunks || 0,processedChunks:c.processedChunks || 0} : {running:false,droppedChunks:0,processedChunks:0};
        return {...core.appearance(s),enabled: s.enabled, bilingual: s.bilingual,semanticSubtitles:s.semanticSubtitles!==false, paired: !!s.token, capture: c?.tabId || null, audioStatus};
      }
      case 'SAVE_TOKEN':
        return saveVerifiedToken(message.token);
      case 'SET_SETTINGS': {
        const task=settingsOperation.catch(()=>{}).then(async()=>{
          await ready;const previous=await chrome.storage.local.get(settingKeys);
          const settings = {...core.appearance({...previous,...message}),enabled: typeof message.enabled==='boolean'?message.enabled:previous.enabled===true,captionsSuppressed:typeof message.enabled==='boolean'?!message.enabled:previous.captionsSuppressed===true, bilingual:typeof message.bilingual==='boolean'?message.bilingual:previous.bilingual!==false,semanticSubtitles:typeof message.semanticSubtitles==='boolean'?message.semanticSubtitles:previous.semanticSubtitles!==false};
          if(typeof message.enabled==='boolean')await chrome.storage.session.set({manualActivation:{version,enabled:settings.enabled}});
          await chrome.storage.local.set(settings);
          if (!settings.enabled) cancelTranslations(()=>true);
          const tabs=await chrome.tabs.query({url: ['https://www.youtube.com/*',...await enabledPatterns()]});
          const delivered=await Promise.all(tabs.map(async tab=>({tab,reply:await tell(tab.id,{type:'SETTINGS',settings})})));
          // Hide captions before waiting for an in-progress audio operation to release.
          if (!settings.enabled) await stopCapture('已关闭中文字幕');
          return {...settings,refreshRequired:delivered.some(({tab,reply})=>tab.active&&reply?.ok!==true)};
        });settingsOperation=task;return task;
      }
      case 'GET_SITE': {
        const [tab]=await chrome.tabs.query({active:true,currentWindow:true}),origin=core.siteOrigin(tab?.url);
        const {enabledSites=[]}=await chrome.storage.local.get('enabledSites');
        return {tabId:tab?.id,origin,patterns:core.sitePatterns(origin),youtube:origin==='https://www.youtube.com',siteEnabled:enabledSites.includes(origin)&&await chrome.permissions.contains({origins:core.sitePatterns(origin)})};
      }
      case 'ENABLE_SITE': case 'DISABLE_SITE': {
        const task=siteOperation.catch(()=>{}).then(()=>configureSite(message));siteOperation=task;return task;
      }
      case 'CHECK_CONNECTION': return {health: await api('/health', null, false), status: await api('/status')};
      case 'OPEN_SETTINGS': {
        const {token} = await chrome.storage.local.get('token');
        const url = new URL(BASE + '/'), fragment = new URLSearchParams();
        if (token) fragment.set('token', token);
        if (message.section === 'api') fragment.set('section', 'api');
        url.hash = fragment.toString();
        await chrome.tabs.create({url: url.href}); return {opened: true};
      }
      case 'START_AUDIO': return startCapture(message.tabId);
      case 'STOP_AUDIO': await stopCapture(); return {running: false};
      default: throw new Error('不允许的扩展操作');
    }
  }
  if (page) {
    switch (message.type) {
      case 'SET_SUBTITLE_POSITION': {
        if(message.subtitlePosition!=='custom'||!Number.isFinite(message.subtitleX)||!Number.isFinite(message.subtitleY)||message.subtitleX<0||message.subtitleX>100||message.subtitleY<0||message.subtitleY>100)throw new Error('字幕位置无效');
        const task=settingsOperation.catch(()=>{}).then(async()=>{
          await ready;const previous=await chrome.storage.local.get(settingKeys);
          const settings={...previous,...core.appearance({...previous,subtitlePosition:'custom',subtitleX:message.subtitleX,subtitleY:message.subtitleY})};
          await chrome.storage.local.set(settings);
          for(const tab of await chrome.tabs.query({url:['https://www.youtube.com/*',...await enabledPatterns()]}))await tell(tab.id,{type:'SETTINGS',settings});
          return settings;
        });settingsOperation=task;return task;
      }
      case 'GET_SETTINGS': await ready; return chrome.storage.local.get(settingKeys);
      case 'GET_CAPTIONS': {
        if(!isYouTube(sender))throw new Error('此网站通过网页字幕读取，不允许请求 YouTube 字幕接口');
        const track = core.validateTrack(message.track, pageVideo(sender));
        if (!track) throw new Error('字幕轨地址校验失败');
        return enqueue(track.baseUrl, async () => {
          const response = await fetch(track.baseUrl, {credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000)});
          if (!response.ok) throw new Error(`字幕读取失败：${response.status}`);
          const raw = await response.text(); if (raw.length > 10000000) throw new Error('字幕文件过大');
          const cues = core.parseJSON3(JSON.parse(raw)); if (!cues.length) throw new Error('字幕轨为空'); return {cues};
        });
      }
      case 'TRANSLATE_SEGMENTS': {
        if(!Array.isArray(message.items)||!message.items.length||message.items.length>40||message.items.some((i,n)=>typeof i?.id!=='string'||!i.id||i.id.length>160||typeof i.text!=='string'||!i.text.trim()||i.text.length>4000||!Number.isFinite(i.start)||!Number.isFinite(i.end)||i.start<0||i.end<=i.start||n&&i.start<message.items[n-1].start)||new Set(message.items.map(i=>i.id)).size!==message.items.length||message.items.reduce((n,i)=>n+i.text.length,0)>16000)throw new Error('完整语句字幕格式无效');
        if(message.videoId!==pageVideo(sender))throw new Error('视频已切换');
        const body={items:message.items.map(i=>({id:i.id,text:i.text,start:i.start,end:i.end})),context:core.cleanText(message.context).slice(0,4000)};
        return enqueue('semantic-v1:'+JSON.stringify(body),signal=>api('/translate-segments',body,true,signal),translationOwner(sender,message));
      }
      case 'TRANSLATE': {
        if (!Array.isArray(message.items) || !message.items.length || message.items.length > 40 || message.items.some(i => typeof i?.id !== 'string' || i.id.length > 100 || typeof i.text !== 'string' || i.text.length > 4000) || message.items.reduce((n, i) => n + i.text.length, 0) > 16000) throw new Error('翻译批次格式不正确');
        if (message.videoId !== pageVideo(sender)) throw new Error('视频已切换');
        const body = {items: message.items.map(i => ({id:i.id, text:i.text})), context: core.cleanText(message.context).slice(0, 500)};
        return enqueue(JSON.stringify(body), signal=>api('/translate',body,true,signal),translationOwner(sender,message));
      }
      case 'PAGE_STATE':
        if(message.videoId!==pageVideo(sender)||!Number.isSafeInteger(message.generation)||message.generation<0||typeof message.paused!=='boolean')throw new Error('视频状态格式不正确');
        const previousFrame=frameStates.get(sender.tab.id+':'+sender.frameId);
        if(previousFrame&&(!sender.documentId||!previousFrame.documentId||sender.documentId===previousFrame.documentId)&&previousFrame.videoId===message.videoId&&previousFrame.generation>message.generation)return {discarded:true};
        cancelTranslations(owner=>owner.frameKey===sender.tab.id+':'+sender.frameId&&(owner.videoId!==message.videoId||owner.generation<message.generation||sender.documentId&&owner.documentId&&sender.documentId!==owner.documentId));
        if(frameStates.size>200)frameStates.clear();
        frameStates.set(sender.tab.id+':'+sender.frameId,{tabId:sender.tab.id,frameId:sender.frameId,documentId:sender.documentId,origin:core.siteOrigin(sender.url),url:sender.url,videoId:message.videoId,generation:message.generation,paused:message.paused,visibleArea:Math.min(10000000,Math.max(0,Number(message.visibleArea)||0)),at:Date.now()});
        if (capture?.tabId === sender.tab.id && (capture.frameId ?? 0)===sender.frameId && (message.videoId !== capture.videoId || message.generation !== capture.pageGeneration || message.paused)) await stopCapture('暂停、跳转或换视频后音频识别已停止，请手动重新开启', capture.generation);
        return {ok: true};
      default: throw new Error('不允许的页面操作');
    }
  }
  if (offscreen) {
    if (message.type === 'AUDIO_ENDED') { if (capture?.generation === message.generation) await stopCapture(core.cleanText(message.reason).slice(0, 300) || '音频流已结束', message.generation); return {ok:true}; }
    if (message.type === 'AUDIO_PROGRESS') {
      if (!capture || message.generation !== capture.generation) return {discarded:true};
      if (![message.droppedChunks,message.processedChunks].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000)) throw new Error('音频进度格式不正确');
      return serializeAudio(async () => {
        if (capture?.generation !== message.generation) return {discarded:true};
        capture = {...capture,droppedChunks:message.droppedChunks,processedChunks:message.processedChunks};
        await chrome.storage.session.set({capture});
        await tell(capture.tabId, {type:'AUDIO_PROGRESS',generation:capture.generation,pageGeneration:capture.pageGeneration,videoId:capture.videoId,droppedChunks:message.droppedChunks,processedChunks:message.processedChunks,message:`音频识别 Beta · 已完成 ${message.processedChunks} 片 · 忙时跳过 ${message.droppedChunks} 片（防止积压）`},capture.frameId);
        return {ok:true};
      });
    }
    if (message.type !== 'AUDIO_CHUNK' || !capture || message.generation !== capture.generation) return {discarded:true};
    if (message.mime !== 'audio/wav' || typeof message.audioBase64 !== 'string' || message.audioBase64.length > 5592410) throw new Error('音频分片不正确');
    if(message.durationSeconds!==undefined&&(!Number.isFinite(message.durationSeconds)||message.durationSeconds<=0||message.durationSeconds>10))throw new Error('音频分片时长不正确');
    if(message.capturedAt!==undefined&&(!Number.isFinite(message.capturedAt)||message.capturedAt>Date.now()+250))throw new Error('音频分片时间不正确');
    if(message.capturedAt!==undefined&&Date.now()-message.capturedAt>3000)return {discarded:true,reason:'stale'};
    if (captureRequest?.generation === capture.generation) return {discarded:true,reason:'busy'};
    const snapshot = {...capture};
    const controller = new AbortController(); captureRequest = {generation:snapshot.generation,controller};
    try {
      const state = await tell(snapshot.tabId, {type:'GET_PAGE_STATE'},snapshot.frameId);
      if (!state || state.paused || state.videoId !== snapshot.videoId || state.generation !== snapshot.pageGeneration || capture?.generation !== snapshot.generation) { await stopCapture('视频状态变化，音频识别已停止',snapshot.generation); return {discarded:true}; }
      const rate=Number.isFinite(state.playbackRate)&&state.playbackRate>0?state.playbackRate:1;
      const duration=message.durationSeconds??7,lag=message.capturedAt===undefined?0:Math.max(0,(Date.now()-message.capturedAt)/1000);
      const end=Math.max(.1,(state.currentTime||0)-lag*rate),start=Math.max(0,end-duration*rate);
      const result = await api('/transcribe', {audioBase64: message.audioBase64, mime:'audio/wav', context: core.cleanText(state.title).slice(0, 500),deferTranslation:true}, true, controller.signal);
      const latest = await tell(snapshot.tabId, {type:'GET_PAGE_STATE'},snapshot.frameId);
      if (!latest || latest.paused || latest.videoId !== snapshot.videoId || latest.generation !== snapshot.pageGeneration || capture?.generation !== snapshot.generation) { await stopCapture('视频状态变化，音频识别已停止',snapshot.generation); return {discarded:true}; }
      if (capture?.generation === snapshot.generation) await tell(snapshot.tabId, {type:'AUDIO_RESULT',lowLatency:true, generation:snapshot.generation, pageGeneration:snapshot.pageGeneration, videoId:snapshot.videoId, text:core.cleanText(result.text), translation:core.cleanText(result.translation),start,end,deferred:result.deferred===true},snapshot.frameId);
      return {ok:true};
    } catch (error) {
      if (error.code === 'CAPTURE_CANCELLED' || capture?.generation !== snapshot.generation) return {discarded:true};
      if (capture?.generation === snapshot.generation) await tell(snapshot.tabId, {type:'AUDIO_ERROR', generation:snapshot.generation,pageGeneration:snapshot.pageGeneration,videoId:snapshot.videoId,message: error.message},snapshot.frameId);
      throw error;
    } finally {
      if (captureRequest?.controller === controller) captureRequest = null;
    }
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message.type !== 'string' || message.target === 'offscreen') return;
  handle(message, sender).then(value => respond({ok: true, ...value}), error => respond({ok: false, error: error.message})); return true;
});
function clearFrameStates(tabId){cancelTranslations(owner=>owner.tabId===tabId);for(const key of frameStates.keys())if(key.startsWith(tabId+':'))frameStates.delete(key);}
chrome.tabs.onRemoved.addListener(tabId => {clearFrameStates(tabId);restored.then(() => {if (capture?.tabId === tabId) return stopCapture('标签页已关闭',capture.generation);}).catch(console.error);});
chrome.tabs.onUpdated.addListener((tabId, change) => {if(change.url||change.status==='loading')clearFrameStates(tabId);restored.then(() => {if (capture?.tabId === tabId && (change.url||change.status==='loading')) return stopCapture('页面已切换，音频识别已停止',capture.generation);}).catch(console.error);});
chrome.tabs.onActivated.addListener(info => {restored.then(() => {if(capture && info.tabId !== capture.tabId && (capture.windowId == null || capture.windowId === info.windowId)) return stopCapture('已切换标签页，音频识别已停止',capture.generation);}).catch(console.error);});
