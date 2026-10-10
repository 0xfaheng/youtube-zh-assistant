const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const popupPath = path.join(__dirname, '../popup.js');
function makePopup(config = {}) {
  const ids = ['apiSettings','version','toggleEnabled','activationStatus','bilingual','semanticSubtitles','status','save','token','check','settings','start','stop','subtitlePosition','subtitleOffset','fontSize','backgroundOpacity','subtitleColor','originalColor','subtitleOffsetValue','fontSizeValue','backgroundOpacityValue','previewChinese','previewOriginal','resetAppearance','enableSite','disableSite','siteStatus'];
  const elements = Object.fromEntries(ids.map(id => [id, {id, checked:true, value:'', textContent:'', dataset:{},style:{}, disabled:false, listeners:{}, addEventListener(type, listener) {this.listeners[type] = listener;}}]));
  let currentTab = {id:1};
  let getSettings = config.getSettings || (() => ({enabled:true,bilingual:true,paired:true,capture:null,audioStatus:{running:false,droppedChunks:0,processedChunks:0}}));
  let connection = config.connection || {health:{configured:true,provider:'codex',audioConfigured:true,audioProvider:'local'},status:{provider:'codex',audioProvider:'local',config:{audioProvider:'local'},localAsr:{available:true,ready:true,state:'ready',model:'Qwen3-ASR-1.7B'}}};
  let startResult = config.startResult || {ok:true,running:true};
  const sent = [], intervalCallbacks = [];
  const sandbox = {
    URL,setTimeout,clearTimeout,
    document:{getElementById:id => elements[id]},
    window:{addEventListener(){}},
    setInterval:callback => {intervalCallbacks.push(callback);return intervalCallbacks.length;}, clearInterval(){},
    chrome:{
      runtime:{getManifest:()=>({version:config.version||'9.8.7'}),sendMessage:async message=>{
        sent.push(message);
        if(message.type==='GET_SETTINGS') return {ok:true,...await getSettings()};
        if(message.type==='CHECK_CONNECTION') return config.checkConnection?config.checkConnection():{ok:true,...connection};
        if(message.type==='START_AUDIO') return startResult;
        if(message.type==='STOP_AUDIO') return {ok:true,running:false};
        if(message.type==='SAVE_TOKEN') return {ok:true,paired:true};
        if(message.type==='SET_SETTINGS') {if(config.setSettings)return config.setSettings(message);return {ok:true,enabled:message.enabled};}
        if(message.type==='OPEN_SETTINGS') return {ok:true};
        return {ok:false,error:'未知测试消息'};
      }},
      tabs:{query:async()=>[currentTab]}
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../core.js'),'utf8'),sandbox);
  vm.runInContext(fs.readFileSync(popupPath,'utf8'),sandbox,{filename:popupPath});
  const tick = () => new Promise(resolve=>setImmediate(resolve));
  const ready = async () => {await tick(); await tick();};
  const click = async id => {const handler=elements[id].listeners.click;assert.ok(handler,`缺少 ${id} click handler`);await handler();await tick();};
  return {elements,sent,ready,click,intervalCallbacks,setSettings:fn=>{getSettings=fn;},setConnection:value=>{connection=value;},setStartResult:value=>{startResult=value;},setCurrentTab:value=>{currentTab=value;}};
}

test('拖动后调字号和颜色保留坐标，预览更新且恢复默认外观',async()=>{
 const p=makePopup({getSettings:()=>({subtitlePosition:'custom',subtitleX:22,subtitleY:33,fontSize:20})});await p.ready();
 assert.equal(p.elements.subtitlePosition.value,'custom');assert.equal(p.elements.subtitleOffset.disabled,true);
 p.elements.fontSize.value='28';p.elements.fontSize.listeners.input();await new Promise(r=>setTimeout(r,220));
 const saved=p.sent.findLast(m=>m.type==='SET_SETTINGS');assert.equal(saved.subtitleX,22);assert.equal(saved.subtitleY,33);assert.equal(saved.subtitlePosition,'custom');assert.equal(saved.fontSize,28);
 p.elements.subtitleColor.value='#ffd43b';p.elements.subtitleColor.listeners.input();p.elements.originalColor.value='#74c0fc';p.elements.originalColor.listeners.input();await new Promise(r=>setTimeout(r,220));
 const colors=p.sent.findLast(m=>m.type==='SET_SETTINGS');assert.equal(colors.subtitleColor,'#ffd43b');assert.equal(colors.originalColor,'#74c0fc');assert.equal(colors.subtitleX,22);assert.equal(colors.subtitleY,33);assert.equal(p.elements.previewChinese.style.color,'#ffd43b');assert.equal(p.elements.previewOriginal.style.color,'#74c0fc');
 await p.click('resetAppearance');await new Promise(r=>setTimeout(r,220));assert.equal(p.sent.findLast(m=>m.type==='SET_SETTINGS').subtitlePosition,'bottom');
 assert.equal(p.sent.findLast(m=>m.type==='SET_SETTINGS').subtitleColor,'#ffffff');assert.equal(p.sent.findLast(m=>m.type==='SET_SETTINGS').originalColor,'#dedede');
});

test('本机 Qwen3-ASR 可用时不要求 API 密钥', async()=>{
  const popup=makePopup(); await popup.ready(); await popup.click('check');
  assert.match(popup.elements.status.textContent,/本机 Qwen3-ASR · 可用/);
  assert.match(popup.elements.status.textContent,/本机 Qwen3-ASR：已就绪 · Qwen3-ASR-1\.7B/);
  assert.doesNotMatch(popup.elements.status.textContent,/需要 API 密钥|API 密钥未配置/);
});

test('较晚初始化不会覆盖用户已选外观，自动保存使用用户新值',async()=>{
 let finish,calls=0;const popup=makePopup({getSettings:()=>++calls===1?new Promise(r=>finish=r):({enabled:true,bilingual:false,paired:true,audioStatus:{running:false}})});
 for(const [key,value]of Object.entries({subtitlePosition:'top',subtitleOffset:'8',fontSize:'28',backgroundOpacity:'65'}))popup.elements[key].value=value;
 popup.elements.subtitlePosition.listeners.change();finish({subtitlePosition:'bottom',subtitleOffset:14,fontSize:20,backgroundOpacity:78,enabled:true,bilingual:false,paired:true});await popup.ready();
 await new Promise(r=>setTimeout(r,210));assert.equal(popup.elements.subtitlePosition.value,'top');assert.equal(popup.elements.fontSize.value,'28');
 const patch=popup.sent.find(m=>m.type==='SET_SETTINGS');assert.equal(patch.subtitlePosition,'top');assert.equal(patch.fontSize,28);
});

test('显式启用按钮只修改启用字段，不改动双语设置',async()=>{
 const popup=makePopup({getSettings:()=>({enabled:false,bilingual:false,paired:true,audioStatus:{running:false}})});await popup.ready();
 assert.equal(popup.elements.version.textContent,'9.8.7');assert.equal(popup.elements.toggleEnabled.textContent,'启用译幕');assert.equal(popup.elements.start.disabled,true);
 await popup.click('toggleEnabled');assert.equal(popup.elements.toggleEnabled.textContent,'停用译幕');assert.equal(popup.elements.start.disabled,false);assert.equal(popup.elements.bilingual.checked,false);
 const patch=popup.sent.find(m=>m.type==='SET_SETTINGS');assert.equal(patch.enabled,true);assert.equal(patch.bilingual,undefined);
});
test('打开面板不自动写开关，停用按钮关闭采音入口，失败保留原状态',async()=>{
 let failed=false;const p=makePopup({getSettings:()=>({enabled:false}),setSettings:message=>failed?{ok:false,error:'保存失败'}:{ok:true,enabled:message.enabled}});await p.ready();
 assert.equal(p.sent.some(m=>m.type==='SET_SETTINGS'),false);
 await p.click('start');assert.equal(p.sent.some(m=>m.type==='START_AUDIO'),false);
 failed=true;await p.click('toggleEnabled');assert.equal(p.elements.toggleEnabled.textContent,'启用译幕');assert.equal(p.elements.start.disabled,true);
 failed=false;await p.click('toggleEnabled');await p.click('toggleEnabled');assert.equal(p.elements.toggleEnabled.textContent,'启用译幕');assert.equal(p.elements.start.disabled,true);
});
test('按钮初始化和保存期间拒绝重复点击，旧轮询不覆盖已确认的手动启用',async()=>{
 let initial,save,calls=0;const p=makePopup({getSettings:()=>++calls===1?new Promise(r=>initial=r):{enabled:false},setSettings:()=>new Promise(r=>save=r)});
 await p.click('toggleEnabled');assert.equal(p.sent.some(m=>m.type==='SET_SETTINGS'),false);
 initial({enabled:false});await p.ready();
 let stale;p.setSettings(()=>new Promise(r=>stale=r));const poll=p.intervalCallbacks[0]();await p.ready();
 const click=p.click('toggleEnabled');await p.ready();await p.click('toggleEnabled');assert.equal(p.sent.filter(m=>m.type==='SET_SETTINGS').length,1);
 save({ok:true,enabled:true});await click;stale({enabled:false});await poll;
 assert.equal(p.elements.toggleEnabled.textContent,'停用译幕');assert.equal(p.elements.start.disabled,false);
});

test('选用云端语音 API 时如实提示尚未配置', async()=>{
  const popup=makePopup({connection:{health:{configured:true,provider:'api',audioConfigured:false,audioProvider:'api'},status:{provider:'api',audioProvider:'api',config:{audioProvider:'api'},localAsr:{available:true,ready:false,state:'stopped',model:'Qwen3-ASR-1.7B'}}}});
  await popup.ready(); await popup.click('check');
  assert.match(popup.elements.status.textContent,/语音识别方式：云端语音 API · 未就绪/);
  assert.match(popup.elements.status.textContent,/本机 Qwen3-ASR：未预热/);
});

test('轮询只显示当前标签页与当前 generation 的分片计数', async()=>{
  let snapshot={enabled:true,bilingual:true,paired:true,capture:1,audioStatus:{running:true,tabId:1,generation:'generation-1',pageGeneration:3,videoId:'dQw4w9WgXcQ',processedChunks:2,droppedChunks:1}};
  const popup=makePopup({getSettings:()=>snapshot}); await popup.ready();
  assert.match(popup.elements.status.textContent,/已处理 2 片 · 忙时跳过 1 片/);

  popup.setCurrentTab({id:2});
  await popup.intervalCallbacks[0]();
  assert.doesNotMatch(popup.elements.status.textContent,/采音运行中/);
  snapshot={...snapshot,audioStatus:{...snapshot.audioStatus,generation:'generation-2',processedChunks:0,droppedChunks:0}};
  await popup.intervalCallbacks[0]();
  popup.setCurrentTab({id:1});
  await popup.intervalCallbacks[0]();
  assert.match(popup.elements.status.textContent,/已处理 0 片 · 忙时跳过 0 片/);

  snapshot={...snapshot,audioStatus:{...snapshot.audioStatus,generation:'generation-1',processedChunks:99,droppedChunks:99}};
  await popup.intervalCallbacks[0]();
  assert.match(popup.elements.status.textContent,/已处理 0 片 · 忙时跳过 0 片/);
  assert.doesNotMatch(popup.elements.status.textContent,/已处理 99 片/);
});

test('启动失败保留醒目错误，后续进度刷新不会覆盖', async()=>{
  const popup=makePopup({getSettings:()=>({enabled:true,bilingual:true,paired:true,capture:1,audioStatus:{running:true,tabId:1,generation:'generation-active',pageGeneration:3,videoId:'dQw4w9WgXcQ',processedChunks:1,droppedChunks:0}}),startResult:{ok:false,error:'本地模型不可用或语音 API 未配置，请打开设置页检查'}});
  await popup.ready(); await popup.click('start');
  assert.equal(popup.elements.status.dataset.tone,'error');
  assert.match(popup.elements.status.textContent,/本地模型不可用或语音 API 未配置/);
  assert.equal(popup.sent.some(message=>message.type==='START_AUDIO'),true);
  assert.equal(popup.sent.some(message=>message.type==='CHECK_CONNECTION'),false);
  await popup.intervalCallbacks[0]();
  assert.equal(popup.elements.status.dataset.tone,'error');
  assert.match(popup.elements.status.textContent,/本地模型不可用或语音 API 未配置/);
});
test('较晚的初始化读取不会覆盖已经确认的配对成功提示',async()=>{
 let finish,calls=0;const popup=makePopup({getSettings:()=>++calls===1?new Promise(r=>finish=r):({enabled:true,bilingual:true,paired:true,audioStatus:{running:false}})});
 await popup.click('save');assert.match(popup.elements.status.textContent,/配对码已验证并保存/);
 finish({enabled:true,bilingual:true,paired:false,audioStatus:{running:false}});await popup.ready();assert.match(popup.elements.status.textContent,/配对码已验证并保存/);
});


test('开关未送达当前视频页时提示刷新；启用如实提示首次翻译等待',async()=>{
 const p=makePopup({getSettings:()=>({enabled:false}),setSettings:()=>({ok:true,enabled:true,refreshRequired:true})});await p.ready();await p.click('toggleEnabled');assert.match(p.elements.status.textContent,/当前视频页未响应.*刷新/);
 const normal=makePopup({getSettings:()=>({enabled:false})});await normal.ready();await normal.click('toggleEnabled');assert.match(normal.elements.status.textContent,/首次中文需等待翻译/);
});


test('启用自动检测翻译连接，服务未启动会显示错误；旧检测不覆盖后续停用',async()=>{
 const p=makePopup({getSettings:()=>({enabled:false}),checkConnection:async()=>({ok:false,error:'无法连接本机服务，请双击 start.cmd'})});await p.ready();await p.click('toggleEnabled');assert.match(p.elements.status.textContent,/翻译连接失败.*start.cmd/);
 let finish;const slow=makePopup({getSettings:()=>({enabled:false}),checkConnection:()=>new Promise(r=>finish=r)});await slow.ready();await slow.click('toggleEnabled');await slow.click('toggleEnabled');finish({ok:false,error:'旧请求失败'});await slow.ready();assert.equal(slow.elements.status.textContent,'已关闭原字幕和译文');
});

test('第三方 API 入口直接请求对应设置板块，不传递密钥', async()=>{
 const popup=makePopup();await popup.ready();await popup.click('apiSettings');
 assert.deepEqual(JSON.parse(JSON.stringify(popup.sent.find(m=>m.type==='OPEN_SETTINGS'))),{type:'OPEN_SETTINGS',section:'api'});
});
