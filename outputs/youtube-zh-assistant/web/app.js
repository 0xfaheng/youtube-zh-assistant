const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
let token = params.get('token') || sessionStorage.getItem('ytzh-token') || '';
if (location.hash) history.replaceState(null, '', location.pathname);
if (token) { sessionStorage.setItem('ytzh-token', token); $('token').value = token; }
const configNames = ['provider','codexModel','codexSpeed','apiBaseUrl','apiMode','apiModel','audioProvider','localAsrLanguage','audioBaseUrl','audioModel','maxRequestsPerHour','maxAudioSecondsPerHour'];
function notice(message, bad = false) { $('notice').textContent = message; $('notice').style.display = 'block'; $('notice').style.background = bad ? '#572c36' : '#203b34'; }
async function request(route, body) {
  const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '请求失败'); return data;
}
function panels() {
  $('codex-panel').hidden = $('provider').value !== 'codex'; $('api-panel').hidden = $('provider').value !== 'api';
  const localAudio = $('audioProvider').value !== 'api';
  $('local-audio-panel').hidden = !localAudio; $('api-audio-panel').hidden = localAudio;
}
function display(data, setConfig = true) {
  if (setConfig) for (const name of configNames) if (Object.hasOwn(data.config, name)) $(name).value = data.config[name];
  panels();
  const counts = data.counts, localAsr = data.localAsr || {}, audioProvider = data.config.audioProvider || 'local';
  const localState = localAsr.ready ? '已就绪' : localAsr.available ? (localAsr.state || '尚未预热') : (localAsr.state || '不可用');
  const audioConfigured = audioProvider === 'local' ? !!localAsr.available : !!data.hasApiKey;
  const localSummary = `本机模型：${localState}${localAsr.model ? ` · ${localAsr.model}` : ''}${localAsr.error ? ` · 错误：${localAsr.error}` : ''}`;
  $('state').textContent = `本机连接：当前配对码已验证\n翻译接入：${data.provider === 'codex' ? 'ChatGPT / Codex CLI' : 'API'}${data.configured ? ' · 已配置，请测试连接' : ' · 尚未配置'}\n语音识别：${audioProvider === 'local' ? '本机 Qwen3-ASR' : '云端语音 API'}${audioConfigured ? ' · 已配置' : ' · 未配置'}\n${localSummary}\nCLI 登录：${data.codex.authMode}${data.codex.loggedIn ? '（已登录）' : '（未登录）'}\nAPI 密钥：${data.hasApiKey ? '已配置' : '未配置'} · 保存方式：${data.keySource}\n缓存字幕：${counts.cachedLines} 条 · 缓存命中：${counts.cacheHits} 次 · 待处理：${counts.pending}\n最近一小时：${counts.requestsLastHour} 次模型调用 / ${counts.audioSecondsLastHour} 秒语音`;
  if (data.lastError) $('state').textContent += `\n${data.lastError.code==='PAIRING_REQUIRED'?'历史配对失败':'最近错误'}：${data.lastError.message}`;
}
async function action(fn, button) { if (button) button.disabled = true; try { await fn(); } catch (error) { notice(error.message, true); } finally { if (button) button.disabled = false; } }
async function pairExtension() {
  token = $('token').value.trim();
  if (!token) throw new Error('请先双击 start.cmd 打开带有效配对码的设置页');
  const state = await request('/status');
  sessionStorage.setItem('ytzh-token', token); display(state);
  const requestId = crypto.randomUUID();
  $('extension-state').textContent = '正在与当前浏览器的插件配对…';
  const result = await new Promise((resolve,reject) => {
    const finish = () => {clearTimeout(timer);window.removeEventListener('message',receive);};
    const receive = event => {
      const data=event.data;
      if(event.source!==window || event.origin!==location.origin || data?.source!=='ytz-local-pair-result-v1' || data.requestId!==requestId)return;
      finish(); if(data.ok && data.paired && data.verified)resolve(data);else reject(new Error(data.error || '插件未完成配对'));
    };
    const timer=setTimeout(()=>{finish();reject(new Error('未收到插件回应：请重新加载译幕插件，再刷新设置页并重试。此页必须在安装插件的同一浏览器配置中打开。'));},20000);
    window.addEventListener('message',receive);
    window.postMessage({source:'ytz-local-pair-request-v1',requestId,token},location.origin);
  }).catch(error=>{$('extension-state').textContent=error.message;throw error;});
  $('extension-state').textContent=`浏览器插件 ${result.version} · 配对已验证，可以返回 YouTube`;
  notice('插件已与当前本机服务配对。返回 YouTube 后刷新视频页面。');
}
$('provider').addEventListener('change', panels); $('audioProvider').addEventListener('change', panels);
$('pair-extension').addEventListener('click', () => action(pairExtension,$('pair-extension')));
$('connect').addEventListener('click', () => action(async () => { token = $('token').value.trim(); sessionStorage.setItem('ytzh-token', token); display(await request('/status')); notice('本机连接已验证。点击“一键配对浏览器插件”完成插件连接。'); }, $('connect')));
$('copy').addEventListener('click', () => action(async () => { await navigator.clipboard.writeText($('token').value.trim()); notice('配对码已复制，请在扩展弹窗中粘贴。'); }, $('copy')));
$('settings').addEventListener('submit', event => { event.preventDefault(); action(async () => {
  const body = Object.fromEntries(configNames.map(name => [name, name.startsWith('max') ? Number($(name).value) : $(name).value.trim()]));
  body.apiKey = $('apiKey').value; body.rememberApiKey = $('rememberApiKey').checked;
  display(await request('/settings', body)); $('apiKey').value = ''; notice('设置已保存。');
}, event.submitter); });
$('test').addEventListener('click', () => action(async () => { notice('正在翻译测试句，会消耗一次模型调用……'); const data = await request('/test', {}); $('result').hidden = false; $('result').textContent = `${data.items[0].text}\n耗时：${(data.elapsedMs / 1000).toFixed(1)} 秒${data.cached ? '（缓存）' : ''}\n${JSON.stringify(data.lastActual, null, 2)}`; display(await request('/status'), false); notice('翻译测试完成。'); }, $('test')));
$('refresh').addEventListener('click', () => action(async () => display(await request('/status'), false), $('refresh')));
$('clear-key').addEventListener('click', () => action(async () => { display(await request('/settings', { clearApiKey: true })); notice('已移除服务内存和本机加密文件中的 API 密钥。'); }, $('clear-key')));
$('clear-cache').addEventListener('click', () => action(async () => { await request('/clear-cache', {}); display(await request('/status'), false); notice('翻译缓存已清空。'); }, $('clear-cache')));
$('warmup-local-asr').addEventListener('click', () => action(async () => { notice('正在预热本地模型；首次加载可能需要较长时间……'); await request('/local-asr/warmup', {}); display(await request('/status'), false); notice('本地模型预热请求已完成，状态已刷新。'); }, $('warmup-local-asr')));
$('stop-local-asr').addEventListener('click', () => action(async () => { await request('/local-asr/stop', {}); display(await request('/status'), false); notice('本地模型已收到释放请求，状态已刷新。'); }, $('stop-local-asr')));
panels(); if (token) action(async () => display(await request('/status')));

