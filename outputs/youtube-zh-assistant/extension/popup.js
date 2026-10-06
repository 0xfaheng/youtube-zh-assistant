'use strict';
const $ = id => document.getElementById(id);
let statusText = '', errorText = '', audioStatus = null, observedCapture = null, pollBusy = false, pollTimer = null,statusRevision=0;
const core=globalThis.YTZCore;
$('version').textContent=chrome.runtime.getManifest().version;
let activeEnabled=false,activationReady=false,activationBusy=false,activationRevision=0;
function renderActivation(){
  $('toggleEnabled').textContent=activeEnabled?'停用译幕':'启用译幕';
  $('toggleEnabled').disabled=!activationReady||activationBusy;
  $('activationStatus').textContent=activeEnabled?'已启用 · 点击停用可关闭原字幕和译文':'已停用 · 点击启用后开始翻译';
  $('start').disabled=!activeEnabled||activationBusy;
}
let appearanceTimer=null,currentSite=null,appearanceChanged=false;
let customPosition={subtitleX:50,subtitleY:75};
const appearanceControls=['subtitlePosition','subtitleOffset','fontSize','backgroundOpacity','subtitleColor','originalColor'];
const changedSwitches=new Set();
function drawAppearance(){
  $('previewChinese').textContent=core.subtitleText('让每一段视频，都能读懂。');$('previewOriginal').textContent=core.subtitleText('A new view of every video.');
  const s=core.appearance({...customPosition,...Object.fromEntries(appearanceControls.map(key=>[key,['subtitleOffset','fontSize','backgroundOpacity'].includes(key)?Number($(key).value):$(key).value]))});
  $('subtitleOffset').disabled=s.subtitlePosition==='custom';
  $('subtitleOffsetValue').textContent=s.subtitleOffset+'%';$('fontSizeValue').textContent=s.fontSize+'px';$('backgroundOpacityValue').textContent=s.backgroundOpacity+'%';
  for(const id of ['previewChinese','previewOriginal'])$(id).style.background=`rgba(0,0,0,${s.backgroundOpacity/100})`;
  $('previewChinese').style.color=s.subtitleColor;$('previewOriginal').style.color=s.originalColor;
  $('previewChinese').style.fontSize=Math.min(24,s.fontSize)+'px';return s;
}
function setAppearance(value){const s=core.appearance(value);customPosition={subtitleX:s.subtitleX,subtitleY:s.subtitleY};for(const key of appearanceControls)$(key).value=String(s[key]);drawAppearance();}
function saveAppearance(){clearTimeout(appearanceTimer);appearanceTimer=setTimeout(()=>request({type:'SET_SETTINGS',...drawAppearance()}).then(()=>show('字幕外观已保存，并应用到已启用网页')).catch(e=>show(e.message,true)),180);}
for(const key of appearanceControls)$(key).addEventListener(key==='subtitlePosition'?'change':'input',()=>{appearanceChanged=true;drawAppearance();saveAppearance();});
$('resetAppearance').addEventListener('click',()=>{appearanceChanged=true;setAppearance(core.appearanceDefaults);saveAppearance();});
async function refreshSite(){
  try{currentSite=await request({type:'GET_SITE'});const site=currentSite;
    $('enableSite').disabled=!site.origin||site.youtube;$('enableSite').hidden=site.siteEnabled||site.youtube;$('disableSite').hidden=!site.siteEnabled;
    $('siteStatus').textContent=site.youtube?'YouTube · 可用，请按需启用译幕':!site.origin?'请打开 HTTPS 视频网页':new URL(site.origin).hostname+(site.siteEnabled?' · 已授权':' · 尚未授权');
  }catch(e){$('siteStatus').textContent=e.message;}
}
$('enableSite').addEventListener('click',()=>run($('enableSite'),async()=>{
  if(!currentSite?.origin)throw new Error('请先打开 HTTPS 视频网页');const site=currentSite;
  const granted=await chrome.permissions.request({origins:site.patterns});if(!granted)throw new Error('未授予网站访问权限，此网站尚未启用');
  const result=await request({type:'ENABLE_SITE',tabId:site.tabId,origin:site.origin});await refreshSite();show(result.refreshRequired?'此网站已授权，请刷新视频网页，再按需启用译幕':'此网站已授权，请按需启用译幕，并开启网页播放器的字幕');
}));
$('disableSite').addEventListener('click',()=>run($('disableSite'),async()=>{if(!currentSite?.origin)return;const result=await request({type:'DISABLE_SITE',tabId:currentSite.tabId,origin:currentSite.origin});await refreshSite();show(result.permissionRetained?'此网站已停用；浏览器保留了访问权限，可在扩展设置中取消':'此网站已停用，访问权限已撤销');}));
const retiredGenerations = new Set();
function renderStatus() {
  const lines = [errorText || statusText];
  if (audioStatus?.running) lines.push(`采音运行中 · 已处理 ${audioStatus.processedChunks} 片 · 忙时跳过 ${audioStatus.droppedChunks} 片（避免积压）`);
  $('status').textContent = lines.filter(Boolean).join('\n');
  $('status').dataset.tone = errorText ? 'error' : 'normal';
}
function show(text, isError = false) {statusRevision++;if (isError) errorText = text; else {statusText = text; errorText = '';} renderStatus();}
async function request(message) {const r = await chrome.runtime.sendMessage(message); if (!r?.ok) throw new Error(r?.error || '扩展后台未响应'); return r;}
async function run(button, action) {button.disabled = true; try {await action();} catch(error) {show(error.message, true);} finally {button.disabled = false;if(button.id==='start')renderActivation();}}
function retireCurrentGeneration() {
  for (const generation of [audioStatus?.generation, observedCapture?.generation]) if (generation) {
    retiredGenerations.add(generation);
    while (retiredGenerations.size > 16) retiredGenerations.delete(retiredGenerations.values().next().value);
  }
  audioStatus = null; observedCapture = null;
}
async function refreshAudioStatus() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const revision=activationRevision;
    const settings = await request({type:'GET_SETTINGS'});
    if(activationReady&&!activationBusy&&revision===activationRevision){activeEnabled=settings.enabled===true;renderActivation();}
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    const current = settings.audioStatus;
    const countersValid = Number.isSafeInteger(current?.processedChunks) && current.processedChunks >= 0 && Number.isSafeInteger(current?.droppedChunks) && current.droppedChunks >= 0;
    const activeCapture = current?.running === true && countersValid && typeof current.generation === 'string' && current.generation.length > 0 && Number.isInteger(current.tabId) && settings.capture === current.tabId;
    const isCurrentCapture = activeCapture && tab?.id === current.tabId;
    if (!activeCapture) retireCurrentGeneration();
    else if (retiredGenerations.has(current.generation)) { if (!isCurrentCapture) audioStatus = null; /* stale generation: keep newer counts only for its active tab */ }
    else {
      if (observedCapture?.tabId === current.tabId && observedCapture.generation !== current.generation) {
        retiredGenerations.add(observedCapture.generation);
        while (retiredGenerations.size > 16) retiredGenerations.delete(retiredGenerations.values().next().value);
      }
      observedCapture = {tabId:current.tabId,generation:current.generation};
      audioStatus = isCurrentCapture ? {generation:current.generation,tabId:current.tabId,processedChunks:current.processedChunks,droppedChunks:current.droppedChunks,running:true} : null;
    }
    renderStatus();
  } catch { /* status refresh must not erase a visible runtime error */ }
  finally {pollBusy = false;}
}
function voiceDetails(status = {}, health = {}) {
  const localAsr = status.localAsr || health.localAsr || {};
  const provider = status.config?.audioProvider || status.audioProvider || health.audioProvider || 'local';
  const states = {unknown:'待检测',starting:'正在启动',idle:'未加载',unavailable:'不可用',error:'出错',loading:'正在加载',warming:'正在加载',ready:'已就绪',transcribing:'识别中',stopping:'正在释放',stopped:'未预热'};
  const localState = localAsr.ready ? '已就绪' : states[localAsr.state] || (localAsr.available ? '可用，尚未预热' : '不可用');
  const localSummary = `本机 Qwen3-ASR：${localState}${localAsr.model ? ` · ${localAsr.model}` : ''}${localAsr.error ? ` · ${localAsr.error}` : ''}`;
  return {provider, localSummary, providerLabel: provider === 'local' ? '本机 Qwen3-ASR' : '云端语音 API', configured: !!health.audioConfigured};
}
const initialStatusRevision=statusRevision;
request({type:'GET_SETTINGS'}).then(s => {activeEnabled=s.enabled===true;activationReady=true;renderActivation();for(const id of ['bilingual','semanticSubtitles'])if(!changedSwitches.has(id))$(id).checked=s[id]!==false;if(!appearanceChanged)setAppearance(s); if(statusRevision===initialStatusRevision)show(s.paired ? '已配对 · 字幕外观会自动保存' : '双击 start.cmd 打开本机设置页，点击“一键配对浏览器插件”。'); return refreshAudioStatus();}).catch(e => {if(statusRevision===initialStatusRevision)show(e.message, true);});
renderActivation();
$('toggleEnabled').addEventListener('click',async()=>{
  if(!activationReady||activationBusy)return;
  const desired=!activeEnabled;activationBusy=true;activationRevision++;renderActivation();
  try{
    const result=await request({type:'SET_SETTINGS',enabled:desired});activeEnabled=typeof result.enabled==='boolean'?result.enabled:desired;
    show(result.refreshRequired?'开关已保存；当前视频页未响应，请刷新视频页后再使用':activeEnabled?'已开启字幕；首次中文需等待翻译，无字幕时请手动开始采音':'已关闭原字幕和译文');
    if(activeEnabled&&!result.refreshRequired){const revision=activationRevision,noticeRevision=statusRevision;
      request({type:'CHECK_CONNECTION'}).then(check=>{if(activeEnabled&&revision===activationRevision&&noticeRevision===statusRevision&&!check.health?.configured)show('字幕已开启；翻译服务未配置，请打开本机设置完成配置',true);}).catch(e=>{if(activeEnabled&&revision===activationRevision&&noticeRevision===statusRevision)show('字幕已开启，但翻译连接失败；请双击 start.cmd 启动服务并检查配对：'+e.message,true);});
    }
  }
  catch(e){show(e.message,true);}
  finally{activationBusy=false;renderActivation();}
});
refreshSite();
pollTimer = setInterval(refreshAudioStatus, 1000);
window.addEventListener('unload', () => {if (pollTimer !== null) clearInterval(pollTimer);if(appearanceTimer!==null)clearTimeout(appearanceTimer);});
for (const id of ['bilingual','semanticSubtitles']) $(id).addEventListener('change', () => {changedSwitches.add(id);return request({type:'SET_SETTINGS',[id]:$(id).checked}).then(() => show('设置已生效')).catch(e => show(e.message));});
$('save').addEventListener('click', () => run($('save'), async () => {await request({type:'SAVE_TOKEN',token:$('token').value.trim()}); $('token').value = ''; show('配对码已验证并保存');}));
$('check').addEventListener('click', () => run($('check'), async () => {
  show('正在检测本机服务…'); const r = await request({type:'CHECK_CONNECTION'});
  const voice = voiceDetails(r.status, r.health);
  show(`连接成功；字幕服务：${r.health.configured ? '已配置' : '待配置'}\n翻译方式：${r.health.provider || '未知'}\n语音识别方式：${voice.providerLabel} · ${voice.configured ? '可用' : '未就绪'}\n${voice.localSummary}`);
}));
$('settings').addEventListener('click', () => run($('settings'), async () => {await request({type:'OPEN_SETTINGS'});}));
$('start').addEventListener('click', () => run($('start'), async () => {
  if(!activeEnabled)throw new Error('请先点击“启用译幕”，再开始采音');
  show('正在启动标签页采音…首次本地模型加载可能较久。');
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id) throw new Error('无法确定当前标签页，请切换到正在播放的 YouTube 视频。');
  await request({type:'START_AUDIO',tabId:tab.id});
  let voiceLine = '语音识别方式按本机设置执行。', translationLine = '识别文本随后由设置页选定的 ChatGPT／Codex 或 API 翻译。';
  try { const check = await request({type:'CHECK_CONNECTION'}), voice = voiceDetails(check.status, check.health); voiceLine = `语音识别：${voice.providerLabel}${voice.provider === 'local' ? ` · ${voice.localSummary}` : ''}`; translationLine = `识别文本随后由${check.health.provider === 'codex' ? 'ChatGPT／Codex' : 'API'}翻译。`; } catch {}
  show(`低延迟采音已启动 · Beta\n${voiceLine}\n音频约每 2 秒分片，停顿会提前提交；识别后尽快送译。首次模型加载和翻译服务仍需等待。\n${translationLine}`); await refreshAudioStatus();
}));
$('stop').addEventListener('click', () => run($('stop'), async () => {await request({type:'STOP_AUDIO'}); show('音频识别已停止'); await refreshAudioStatus();}));
