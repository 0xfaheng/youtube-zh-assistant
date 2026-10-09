const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness(config = {}) {
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../manifest.json'),'utf8'));
  let listener, fetches = [], local = config.local||{token:'local-pairing-token-12345', enabled:true,bilingual:true,enabledSites:config.enabledSites||[]}, session = config.session||(config.sessionEnabled===false?{}:{manualActivation:{version:manifest.version,enabled:true}}), documentOpen = false, closedDocuments = 0;
  const registrations=[],granted=new Set(config.granted||[]);
  const messages = [], runtimeMessages = [], createdTabs = [], events = {}, delays = [];
  const pageState = {videoId:'dQw4w9WgXcQ',generation:1,paused:false,title:'Example',...config.pageState};
  const event = name => ({addListener:callback=>{events[name]=callback;}});
  const storage = data => ({get:async keys => Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in data).map(k=>[k,data[k]])),set:async value=>Object.assign(data,value),remove:async key=>{delete data[key];},setAccessLevel:async ()=>{}});
  const sandbox = {URL, URLSearchParams, Date,console, AbortSignal, AbortController, clearTimeout,setInterval,clearInterval, setTimeout:(callback,delay)=>{delays.push(delay);return setTimeout(callback,config.fastTimeout && delay>=100000 ? 10 : delay===800 ? 0 : delay);}, crypto:require('node:crypto').webcrypto,
    chrome:{runtime:{id:'testextension',getManifest:()=>manifest,getURL:name=>'chrome-extension://testextension/'+name,onMessage:{addListener:f=>{listener=f;}},sendMessage:async message=>{runtimeMessages.push(message);return config.runtimeImpl?config.runtimeImpl(message):{ok:true};}},storage:{local:storage(local),session:storage(session)},
      permissions:{contains:async({origins})=>origins.every(p=>granted.has(p)),remove:async({origins})=>{origins.forEach(p=>granted.delete(p));return true;},onRemoved:event('permissionsRemoved')},scripting:{getRegisteredContentScripts:async()=>registrations,registerContentScripts:async scripts=>{registrations.push(...scripts);},updateContentScripts:async scripts=>{registrations.splice(0,registrations.length,...scripts);},unregisterContentScripts:async()=>{registrations.length=0;},executeScript:async()=>[]},
      tabs:{onRemoved:event('removed'),onUpdated:event('updated'),onActivated:event('activated'),get:async id=>({id,active:true,url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',windowId:2,...config.tab}),query:async()=>[{id:1,active:true,url:config.tab?.url}],create:async tab=>{createdTabs.push(tab);},sendMessage:async(tabId,message,options)=>{messages.push({tabId,frameId:options?.frameId,...message});return config.sendImpl?config.sendImpl(message):message.type==='GET_PAGE_STATE' ? {...pageState} : {ok:true};}},
      tabCapture:{getMediaStreamId:async()=> 'fake-stream'},offscreen:{hasDocument:async()=>documentOpen,createDocument:async()=>{documentOpen=true;},closeDocument:async()=>{closedDocuments++;documentOpen=false;}}},
    fetch:async(url,options)=>{fetches.push({url,options});if(config.fetchImpl) {const custom=await config.fetchImpl(url,options);if(custom)return custom;}return {ok:true,json:async()=>url.endsWith('/pairing') ? {ok:true,service:'youtube-zh-assistant'} : url.endsWith('/health') ? {ok:true,configured:true,audioConfigured:true} : url.endsWith('/transcribe') ? {text:'Hello',translation:'你好'} : {items:JSON.parse(options.body).items.map(i=>({...i,text:'中文'}))}};}};
  vm.createContext(sandbox); vm.runInContext(fs.readFileSync(path.join(__dirname,'../core.js'),'utf8'),sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../background.js'),'utf8').replace("import './core.js';",''),sandbox);
  const call = (message,sender) => new Promise(resolve=>listener(message,sender,resolve));
  return {call,fetches,messages,runtimeMessages,createdTabs,local,session,pageState,events,delays,registrations,granted,get closedDocuments(){return closedDocuments;},get documentOpen(){return documentOpen;}};
}
const page = {id:'testextension',url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',frameId:0,tab:{id:1}};
const popup = {id:'testextension',url:'chrome-extension://testextension/popup.html'};
const offscreen = {id:'testextension',url:'chrome-extension://testextension/offscreen.html'};
test('旧版本地开关不会自动启用；配对、外观和网站授权仍保持停用',async()=>{
 const h=harness({sessionEnabled:false,granted:['https://vimeo.com/*','https://player.vimeo.com/*'],tab:{url:'https://vimeo.com/123'}});
 assert.equal((await h.call({type:'GET_SETTINGS'},popup)).enabled,false);
 await h.call({type:'SAVE_TOKEN',token:'b'.repeat(64)},popup);
 await h.call({type:'SET_SETTINGS',fontSize:28},popup);
 await h.call({type:'ENABLE_SITE',tabId:1,origin:'https://vimeo.com'},popup);
 assert.equal(h.local.enabled,false);assert.equal(h.session.manualActivation,undefined);
 const before=h.fetches.length;
 for(const type of ['GET_CAPTIONS','TRANSLATE','TRANSLATE_SEGMENTS','START_AUDIO','AUDIO_CHUNK']){
  const result=await h.call({type},type==='START_AUDIO'?popup:type==='AUDIO_CHUNK'?offscreen:page);
  assert.equal(result.ok,false);assert.match(result.error,/尚未启用/);
 }
 assert.equal(h.fetches.length,before);assert.equal(h.documentOpen,false);
});
test('手动启用会话在worker重启后恢复；新会话、版本变化和手动停用均保持关闭',async()=>{
 const h=harness({sessionEnabled:false});await h.call({type:'SET_SETTINGS',enabled:true},popup);
 assert.equal(h.local.enabled,true);assert.equal(h.session.manualActivation.enabled,true);
 const resumed=harness({local:h.local,session:h.session});assert.equal((await resumed.call({type:'GET_SETTINGS'},popup)).enabled,true);
 const restart=harness({local:{...h.local},session:{}});assert.equal((await restart.call({type:'GET_SETTINGS'},popup)).enabled,false);
 const upgraded=harness({local:{...h.local},session:{manualActivation:{version:'0.4.1',enabled:true}}});assert.equal((await upgraded.call({type:'GET_SETTINGS'},popup)).enabled,false);
 await resumed.call({type:'SET_SETTINGS',enabled:false},popup);
 assert.equal(resumed.session.manualActivation.enabled,false);
 assert.equal((await harness({local:resumed.local,session:resumed.session}).call({type:'GET_SETTINGS'},popup)).enabled,false);
});
test('停用中止在途和排队翻译，并关闭采音，不显示迟到结果',async()=>{
 const pending=[];const h=harness({fetchImpl:async(url,options)=>url.endsWith('/translate')?new Promise((_resolve,reject)=>{pending.push(options.signal);options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}):null});
 await start(h);
 const requests=['one','two','three'].map(id=>h.call({type:'TRANSLATE',videoId:'dQw4w9WgXcQ',items:[{id,text:id}]},page));
 await until(()=>pending.length===2);
 assert.equal((await h.call({type:'SET_SETTINGS',enabled:false},popup)).enabled,false);
 assert.ok((await Promise.all(requests)).every(r=>r.ok===false));assert.ok(pending.every(s=>s.aborted));
 assert.equal(pending.length,2);assert.equal(h.documentOpen,false);assert.equal(h.session.capture,undefined);
 assert.ok(h.messages.some(m=>m.type==='SETTINGS'&&m.settings.enabled===false));
});
test('同一翻译由多个网页等待时，跳转只撤销自己的等待者',async()=>{
 let release,signal;
 const h=harness({fetchImpl:async(url,options)=>url.endsWith('/translate')?new Promise((resolve,reject)=>{signal=options.signal;release=()=>resolve({ok:true,json:async()=>({items:[{id:'a',text:'共享译文'}]})});signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}):null});
 const message={type:'TRANSLATE',videoId:'dQw4w9WgXcQ',generation:1,items:[{id:'a',text:'Shared'}]},other={...page,tab:{id:2}};
 const first=h.call(message,page),second=h.call(message,other);await until(()=>h.fetches.length===1);
 await h.call({type:'PAGE_STATE',videoId:message.videoId,generation:2,paused:false},page);
 assert.equal((await first).ok,false);assert.equal(signal.aborted,false);assert.equal(h.fetches.length,1);
 release();assert.equal((await second).items[0].text,'共享译文');
});
test('跳转取消在途与未开始的旧请求，释放并发槽，拒绝迟到旧代次',async()=>{
 const pending=new Map();
 const h=harness({fetchImpl:async(url,options)=>url.endsWith('/translate')?new Promise((resolve,reject)=>{const id=JSON.parse(options.body).items[0].id;pending.set(id,{signal:options.signal,release:()=>resolve({ok:true,json:async()=>({items:[{id,text:'译文'}]})})});options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}):null});
 const message=id=>({type:'TRANSLATE',videoId:'dQw4w9WgXcQ',generation:1,items:[{id,text:id}]}),other={...page,tab:{id:2}};
 const a=h.call(message('a'),page),b=h.call(message('b'),other),queued=h.call(message('c'),page);await until(()=>pending.size===2);
 await h.call({type:'PAGE_STATE',videoId:'dQw4w9WgXcQ',generation:2,paused:false},page);
 assert.equal((await a).ok,false);assert.equal((await queued).ok,false);assert.equal(pending.get('a').signal.aborted,true);assert.equal(pending.has('c'),false);
 const next=h.call({...message('d'),generation:2},page);await until(()=>pending.has('d'));
 assert.equal((await h.call(message('old'),page)).ok,false);assert.equal(pending.has('old'),false);
 pending.get('d').release();pending.get('b').release();assert.equal((await next).ok,true);assert.equal((await b).ok,true);
});
test('倍速采音的时间跨度按视频播放速率换算',async()=>{
 const h=harness({pageState:{currentTime:28,playbackRate:2}});const generation=await start(h);await h.call(chunk(generation),offscreen);
 const result=h.messages.find(m=>m.type==='AUDIO_RESULT');assert.equal(result.start,14);assert.equal(result.end,28);await h.call({type:'STOP_AUDIO'},popup);
});

test('语义翻译走独立认证接口，保留时间上下文、去重与150秒进度等待，并拒绝过期视频',async()=>{
 const h=harness({fetchImpl:async(url,options)=>url.endsWith('/translate-segments')?{ok:true,json:async()=>({segments:[{sourceIds:JSON.parse(options.body).items.map(c=>c.id),text:'完整的句子'}]})}:null});
 assert.equal((await h.call({type:'GET_SETTINGS'},page)).semanticSubtitles,true);
 const message={type:'TRANSLATE_SEGMENTS',videoId:'dQw4w9WgXcQ',generation:1,items:[{id:'a',text:'Complete',start:0,end:2},{id:'b',text:'sentence.',start:2,end:4}],context:'before and after'};
 const results=await Promise.all([h.call(message,page),h.call(message,page)]);assert.ok(results.every(r=>r.ok));assert.equal(h.fetches.length,1);const request=h.fetches[0];assert.equal(request.url,'http://127.0.0.1:17865/translate-segments');assert.deepEqual(JSON.parse(request.options.body),{items:message.items,context:message.context});assert.equal(request.options.headers['X-YTZ-Progress'],'1');assert.equal(request.options.headers.Authorization,'Bearer local-pairing-token-12345');assert.ok(h.delays.includes(150000));
 for(const change of [{videoId:'old-video'},{items:[{...message.items[0],end:0}]},{items:[message.items[1],message.items[0]]},{items:[message.items[0],message.items[0]]}])assert.equal((await h.call({...message,...change},page)).ok,false);assert.equal(h.fetches.length,1);
 await h.call({type:'SET_SETTINGS',semanticSubtitles:false},popup);await h.call({type:'SET_SETTINGS',fontSize:28},popup);assert.equal(h.local.semanticSubtitles,false);
});

test('完整语句采音先识别原文、延后翻译，并携带采集片段时间',async()=>{
 const h=harness({pageState:{currentTime:14},fetchImpl:async url=>url.endsWith('/transcribe')?{ok:true,json:async()=>({text:'Because we need',translation:'',deferred:true})}:null});const generation=await start(h);await h.call(chunk(generation),offscreen);const body=JSON.parse(h.fetches.find(r=>r.url.endsWith('/transcribe')).options.body);assert.equal(body.deferTranslation,true);const result=h.messages.find(m=>m.type==='AUDIO_RESULT');assert.equal(result.start,7);assert.equal(result.end,14);assert.equal(result.deferred,true);assert.equal(result.translation,'');await h.call({type:'STOP_AUDIO'},popup);
});

test('低延迟采音使用实际分片时长与采集时间，倍速换算，逐片模式也先识别再翻译',async()=>{
 const h=harness({local:{enabled:true,semanticSubtitles:false,token:'fixture'},pageState:{currentTime:20,playbackRate:2},fetchImpl:async url=>url.endsWith('/transcribe')?{ok:true,json:async()=>({text:'Short phrase',translation:'',deferred:true})}:null});const generation=await start(h);
 await h.call({...chunk(generation),durationSeconds:1.25,capturedAt:Date.now()-500},offscreen);const body=JSON.parse(h.fetches.find(r=>r.url.endsWith('/transcribe')).options.body);assert.equal(body.deferTranslation,true);
 const result=h.messages.find(m=>m.type==='AUDIO_RESULT');assert.ok(result.end>=18.8&&result.end<=19.1);assert.ok(Math.abs(result.end-result.start-2.5)<.01);assert.equal(result.lowLatency,true);
 const before=h.fetches.length;assert.equal((await h.call({...chunk(generation),durationSeconds:2,capturedAt:Date.now()-4000},offscreen)).reason,'stale');assert.equal(h.fetches.length,before);
 for(const value of [NaN,-1,0,11,'2'])assert.equal((await h.call({...chunk(generation),durationSeconds:value},offscreen)).ok,false);
 assert.equal((await h.call({...chunk(generation),capturedAt:Date.now()+1000},offscreen)).ok,false);await h.call({type:'STOP_AUDIO'},popup);
});

test('拖拽仅能保存合法坐标，不改变开关与字号；未授权网页不能写入',async()=>{
 const h=harness();await h.call({type:'SET_SETTINGS',fontSize:32,bilingual:false},popup);
 const result=await h.call({type:'SET_SUBTITLE_POSITION',subtitlePosition:'custom',subtitleX:25.4,subtitleY:31.7,enabled:false,fontSize:48},page);
 assert.equal(result.ok,true);assert.equal(h.local.subtitleX,25);assert.equal(h.local.subtitleY,32);assert.equal(h.local.enabled,true);assert.equal(h.local.fontSize,32);assert.equal(h.local.bilingual,false);
 for(const x of [NaN,Infinity,-1,101,'50'])assert.equal((await h.call({type:'SET_SUBTITLE_POSITION',subtitlePosition:'custom',subtitleX:x,subtitleY:50},page)).ok,false);
 assert.equal((await h.call({type:'SET_SUBTITLE_POSITION',subtitlePosition:'custom',subtitleX:50,subtitleY:50},{...page,url:'https://unknown.example/watch'})).ok,false);
 assert.ok(h.messages.some(m=>m.type==='SETTINGS'&&m.settings.subtitlePosition==='custom'));
 await h.call({type:'SET_SETTINGS',subtitlePosition:'bottom'},popup);assert.equal(h.local.subtitlePosition,'bottom');
});

test('Khan内嵌播放器获对应路径授权后可翻译，但其他路径不能读取设置',async()=>{
 const h=harness({enabledSites:['https://www.khanacademy.org'],granted:['https://www.khanacademy.org/*','https://www.youtube-nocookie.com/embed/*']});
 const sender={...page,url:'https://www.youtube-nocookie.com/embed/Uiqro5TUyLA/',frameId:2,tab:{id:1,url:'https://www.khanacademy.org/video/test'}};
 const r=await h.call({type:'TRANSLATE',videoId:'web:https://www.youtube-nocookie.com/embed/Uiqro5TUyLA/',items:[{id:'1',text:'Cells are the building blocks of life.'}]},sender);assert.equal(r.ok,true);
 assert.equal((await h.call({type:'GET_SETTINGS'},{...sender,url:'https://www.youtube-nocookie.com/watch?v=Uiqro5TUyLA'})).ok,false);
 assert.equal((await h.call({type:'GET_CAPTIONS',track:{baseUrl:'https://www.youtube.com/api/timedtext?v=Uiqro5TUyLA'}},sender)).ok,false);
});
test('只更新外观不改变开关，范围限值有效且页面看不到配对码',async()=>{
  const h=harness();await h.call({type:'SET_SETTINGS',enabled:false,bilingual:false},popup);
  const update=await h.call({type:'SET_SETTINGS',subtitlePosition:'top',subtitleOffset:99,fontSize:28,backgroundOpacity:0},popup);
  assert.equal(update.enabled,false);assert.equal(update.bilingual,false);assert.equal(update.subtitleOffset,70);
  const settings=await h.call({type:'GET_SETTINGS'},page);assert.equal(settings.token,undefined);assert.equal(settings.subtitlePosition,'top');assert.equal(settings.fontSize,28);
});
test('其他网站必须有独立授权和启用记录，翻译不能越过当前文档',async()=>{
  const sender={...page,url:'https://videos.example/watch/one',tab:{id:1,url:'https://videos.example/watch/one'}};
  const no=harness({granted:['https://videos.example/*']});assert.equal((await no.call({type:'GET_SETTINGS'},sender)).ok,false);
  const h=harness({enabledSites:['https://videos.example'],granted:['https://videos.example/*']});
  const settings=await h.call({type:'GET_SETTINGS'},sender);assert.equal(settings.ok,true);assert.equal(settings.token,undefined);
  const current=await h.call({type:'TRANSLATE',videoId:'web:https://videos.example/watch/one',items:[{id:'1',text:'Hello'}]},sender);assert.equal(current.ok,true);
  assert.equal((await h.call({type:'TRANSLATE',videoId:'web:https://videos.example/watch/old',items:[{id:'1',text:'Hello'}]},sender)).ok,false);
  assert.equal((await h.call({type:'GET_CAPTIONS',track:{baseUrl:'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ'}},sender)).ok,false);
  h.granted.clear();assert.equal((await h.call({type:'GET_SETTINGS'},sender)).ok,false);
});
test('启用Vimeo只注册已授予的网站和播放器，停用后撤销且不允许网页自行启用',async()=>{
  const patterns=['https://vimeo.com/*','https://player.vimeo.com/*'];
  const h=harness({granted:patterns,tab:{url:'https://vimeo.com/123'}});
  assert.equal((await h.call({type:'ENABLE_SITE',tabId:1,origin:'https://evil.example'},popup)).ok,false);
  const on=await h.call({type:'ENABLE_SITE',tabId:1,origin:'https://vimeo.com'},popup);assert.equal(on.siteEnabled,true);
  assert.equal(h.registrations[0].allFrames,true);assert.deepEqual(Array.from(h.registrations[0].matches),patterns);
  const embedded={...page,frameId:2,url:'https://player.vimeo.com/video/123',tab:{id:1,url:'https://vimeo.com/123'}};
  assert.equal((await h.call({type:'GET_SETTINGS'},embedded)).ok,true);
  assert.equal((await h.call({type:'ENABLE_SITE',tabId:1,origin:'https://vimeo.com'},embedded)).ok,false);
  assert.equal((await h.call({type:'DISABLE_SITE',tabId:1,origin:'https://vimeo.com'},popup)).siteEnabled,false);
  assert.equal(h.registrations.length,0);assert.equal(h.granted.size,0);assert.equal((await h.call({type:'GET_SETTINGS'},embedded)).ok,false);
});
test('采音选取已启用的内嵌播放器frame，其他frame暂停不会停止正在采音的播放器',async()=>{
  const id='web:https://player.vimeo.com/video/123';
  const h=harness({enabledSites:['https://vimeo.com'],granted:['https://vimeo.com/*','https://player.vimeo.com/*'],tab:{url:'https://vimeo.com/123'},pageState:{videoId:id}});
  const embedded={...page,frameId:2,url:'https://player.vimeo.com/video/123',tab:{id:1,url:'https://vimeo.com/123'}};
  assert.equal((await h.call({type:'PAGE_STATE',videoId:id,generation:1,paused:false,visibleArea:500000},embedded)).ok,true);
  assert.equal((await h.call({type:'START_AUDIO',tabId:1},popup)).ok,true);assert.equal(h.session.capture.frameId,2);
  assert.ok(h.messages.filter(m=>m.type==='GET_PAGE_STATE').every(m=>m.frameId===2));
  assert.equal((await h.call({type:'PAGE_STATE',videoId:'web:https://vimeo.com/123',generation:0,paused:true}, {...embedded,frameId:0,url:'https://vimeo.com/123'})).ok,true);assert.ok(h.session.capture);
  await h.call({type:'PAGE_STATE',videoId:id,generation:2,paused:true},embedded);assert.equal(h.session.capture,undefined);assert.equal(h.documentOpen,false);
});
const tick = () => new Promise(resolve=>setImmediate(resolve));
async function until(predicate) {for(let i=0;i<30;i++){if(predicate())return;await tick();}assert.fail('异步状态未达到预期');}
async function start(h) {assert.equal((await h.call({type:'START_AUDIO',tabId:1},popup)).ok,true);return h.session.capture.generation;}
function chunk(generation) {return {type:'AUDIO_CHUNK',generation,mime:'audio/wav',audioBase64:'ZmFrZQ=='};}
test('拒绝外部来源、子 frame 及页面发起的高权限操作', async () => {
  const h=harness();
  for(const sender of [{...page,id:'external'},{...page,url:'https://evil.example/'},{...page,frameId:1}]) assert.equal((await h.call({type:'GET_SETTINGS'},sender)).ok,false);
  for(const type of ['SAVE_TOKEN','START_AUDIO','OPEN_SETTINGS','FETCH','API']) assert.equal((await h.call({type,token:'another-token-12345',url:'https://evil.example/'},page)).ok,false);
  assert.equal(h.fetches.length,0);
});
test('页面设置响应不包含 token；翻译在后台附加 token，重复请求去重', async () => {
  const h=harness(); const settings=await h.call({type:'GET_SETTINGS'},page);
  assert.equal(settings.ok,true); assert.equal(settings.token,undefined);
  const message={type:'TRANSLATE',videoId:'dQw4w9WgXcQ',items:[{id:'1',text:'Hello'}]};
  const results=await Promise.all([h.call(message,page),h.call(message,page)]);
  assert.ok(results.every(r=>r.ok)); assert.equal(h.fetches.length,1);
  assert.equal(h.fetches[0].url,'http://127.0.0.1:17865/translate');
  assert.equal(h.fetches[0].options.headers.Authorization,'Bearer local-pairing-token-12345');
  assert.equal(JSON.parse(h.fetches[0].options.body).token,undefined);
});
test('拒绝换视频、超大批次、任意字幕 URL，且不触发 fetch', async () => {
  const h=harness();
  for(const message of [{type:'TRANSLATE',videoId:'aaaaaaaaaaa',items:[{id:'1',text:'hello'}]},{type:'TRANSLATE',videoId:'dQw4w9WgXcQ',items:Array.from({length:41},(_,i)=>({id:String(i),text:'hello'}))},{type:'GET_CAPTIONS',track:{baseUrl:'http://127.0.0.1:17865/status'}}]) assert.equal((await h.call(message,page)).ok,false);
  assert.equal(h.fetches.length,0);
});
test('YouTube SPA 换视频采用当前 tab URL，拒绝旧文档视频字幕', async () => {
  const h=harness(), sender={...page,tab:{id:1,url:'https://www.youtube.com/watch?v=abcdefghijk'}};
  const current=await h.call({type:'TRANSLATE',videoId:'abcdefghijk',items:[{id:'1',text:'hello'}]},sender);
  assert.equal(current.ok,true);
  const stale=await h.call({type:'TRANSLATE',videoId:'dQw4w9WgXcQ',items:[{id:'2',text:'old video'}]},sender);
  assert.equal(stale.ok,false);assert.equal(h.fetches.length,1);
});
test('OPEN_SETTINGS 使用已保存 token 的 fragment 配对，只允许 popup 调用', async()=>{
  const h=harness();const result=await h.call({type:'OPEN_SETTINGS'},popup);assert.equal(result.ok,true);assert.equal(result.token,undefined);
  const url=new URL(h.createdTabs[0].url);assert.equal(url.origin,'http://127.0.0.1:17865');assert.equal(url.search,'');assert.equal(new URLSearchParams(url.hash.slice(1)).get('token'),h.local.token);
  assert.equal((await h.call({type:'OPEN_SETTINGS'},page)).ok,false);assert.equal(h.createdTabs.length,1);
});
test('保存配对码先验证当前服务；错误码不会替换已有配对',async()=>{
  const candidate='b'.repeat(64);
  const h=harness({fetchImpl:async(url,options)=>url.endsWith('/pairing')?{ok:true,json:async()=>({ok:true,version:'0.2.2',service:'youtube-zh-assistant'})}:undefined});
  const result=await h.call({type:'SAVE_TOKEN',token:candidate},popup);assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(h.local.token,candidate);
  assert.equal(h.fetches[0].options.headers.Authorization,'Bearer '+candidate);assert.equal(result.token,undefined);
  const bad=harness({fetchImpl:async()=>({ok:false,status:401,json:async()=>({error:'配对码无效'})})});const before=bad.local.token;
  const refused=await bad.call({type:'SAVE_TOKEN',token:candidate},popup);assert.equal(refused.ok,false);assert.match(refused.error,/不匹配/);assert.equal(bad.local.token,before);assert.equal(bad.fetches.length,1);
});
test('本机设置页可一键配对；YouTube、其他主机、路径和子frame不能发起',async()=>{
  const candidate='c'.repeat(64), sender={id:'testextension',url:'http://127.0.0.1:17865/',frameId:0,tab:{id:3}};
  const h=harness({fetchImpl:async(url)=>url.endsWith('/pairing')?{ok:true,json:async()=>({ok:true,service:'youtube-zh-assistant'})}:undefined});
  assert.equal((await h.call({type:'PAIR_LOCAL',token:candidate},sender)).paired,true);assert.equal(h.local.token,candidate);
  for(const hostile of [page,{...sender,url:'http://localhost:17865/'},{...sender,url:'http://127.0.0.1:17865/other'},{...sender,frameId:1},{...sender,id:'external'}])assert.equal((await h.call({type:'PAIR_LOCAL',token:candidate},hostile)).ok,false);
  assert.equal((await h.call({type:'START_AUDIO',tabId:1},sender)).ok,false);assert.equal(h.fetches.length,1);
});
test('配对无效时启动音频立即失败，不创建采音文档或识别请求',async()=>{
  const h=harness({fetchImpl:async(url)=>url.endsWith('/pairing')?{ok:false,status:401,json:async()=>({error:'配对码无效'})}:undefined});
  const result=await h.call({type:'START_AUDIO',tabId:1},popup);assert.equal(result.ok,false);assert.match(result.error,/配对码无效/);assert.equal(h.documentOpen,false);assert.equal(h.fetches.some(f=>f.url.endsWith('/transcribe')),false);
});
test('付费 POST 的 HTTP 错误与网络错误均只发一次，不自动重试', async()=>{
  for(const path of ['/translate','/transcribe']) for(const failure of ['network',502,503,504]) {
    const h=harness({fetchImpl:async(url)=>{if(!url.endsWith(path))return;if(failure==='network')throw new TypeError('Failed to fetch');return {ok:false,status:failure,json:async()=>({error:'上游暂不可用'})};}});
    const generation=path==='/transcribe' ? await start(h) : null;
    const result=await h.call(path==='/transcribe' ? chunk(generation) : {type:'TRANSLATE',videoId:'dQw4w9WgXcQ',items:[{id:'1',text:'hello'}]},path==='/transcribe' ? offscreen : page);
    assert.equal(result.ok,false);assert.match(result.error,/未自动重试/);assert.equal(h.fetches.filter(f=>f.url.endsWith(path)).length,1);
    if(generation)await h.call({type:'STOP_AUDIO'},popup);
  }
});
test('POST 超时清楚报错，翻译150秒与语音300秒，不重试', async()=>{
  for(const path of ['/translate','/transcribe']) {
    const h=harness({fastTimeout:true,fetchImpl:async(url,options)=>{if(!url.endsWith(path))return;return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
    const generation=path==='/transcribe' ? await start(h) : null;
    const result=await h.call(generation ? chunk(generation) : {type:'TRANSLATE',videoId:'dQw4w9WgXcQ',items:[{id:'1',text:'hello'}]},generation ? offscreen : page);
    assert.equal(result.ok,false);assert.match(result.error,/超时.*未自动重试/);assert.ok(h.delays.includes(path==='/transcribe'?300000:150000));assert.equal(h.fetches.filter(f=>f.url.endsWith(path)).length,1);
    if(generation)await h.call({type:'STOP_AUDIO'},popup);
  }
});
test('暂停中止旧请求的等待、关闭采音文档、归零计数，旧响应不显示', async()=>{
  let signal;
  const h=harness({fetchImpl:async(url,options)=>{if(!url.endsWith('/transcribe'))return;signal=options.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
  const generation=await start(h);const pending=h.call(chunk(generation),offscreen);await until(()=>signal);
  h.pageState.paused=true;assert.equal((await h.call({type:'PAGE_STATE',videoId:h.pageState.videoId,generation:1,paused:true},page)).ok,true);
  const result=await pending;assert.equal(result.discarded,true);assert.equal(signal.aborted,true);assert.equal(h.closedDocuments,1);assert.equal(h.documentOpen,false);
  assert.equal(h.messages.some(m=>m.type==='AUDIO_RESULT'),false);const stopped=h.messages.find(m=>m.type==='AUDIO_STATE'&&!m.running);assert.match(stopped.message,/已经提交的模型调用可能继续完成/);assert.equal(stopped.droppedChunks,0);assert.equal(stopped.processedChunks,0);
});
test('识别结束二次校验跳转状态，丢弃旧字幕且释放捕获', async()=>{
  let resolve;
  const h=harness({fetchImpl:async(url)=>{if(!url.endsWith('/transcribe'))return;return new Promise(done=>{resolve=done;});}});
  const generation=await start(h);const pending=h.call(chunk(generation),offscreen);await until(()=>resolve);
  h.pageState.generation=2;resolve({ok:true,json:async()=>({text:'old',translation:'旧'})});assert.equal((await pending).discarded,true);
  assert.equal(h.messages.some(m=>m.type==='AUDIO_RESULT'),false);assert.equal(h.closedDocuments,1);
});
test('新捕获拒绝旧 generation 的片段和进度；当前进度携带页面代次', async()=>{
  const h=harness(), first=await start(h);await h.call({type:'STOP_AUDIO'},popup);const current=await start(h);
  assert.notEqual(first,current);assert.equal((await h.call(chunk(first),offscreen)).discarded,true);
  assert.equal((await h.call({type:'AUDIO_PROGRESS',generation:first,droppedChunks:9,processedChunks:3},offscreen)).discarded,true);
  assert.equal((await h.call({type:'AUDIO_PROGRESS',generation:current,droppedChunks:2,processedChunks:1},offscreen)).ok,true);
  const progress=h.messages.find(m=>m.type==='AUDIO_PROGRESS');assert.equal(progress.generation,current);assert.equal(progress.pageGeneration,1);assert.equal(progress.videoId,'dQw4w9WgXcQ');assert.equal(progress.droppedChunks,2);
  const settings=await h.call({type:'GET_SETTINGS'},popup);assert.equal(settings.capture,1);assert.equal(settings.audioStatus.running,true);assert.equal(settings.audioStatus.generation,current);assert.equal(settings.audioStatus.droppedChunks,2);assert.equal(settings.audioStatus.processedChunks,1);assert.equal(h.session.capture.droppedChunks,2);
  await h.call({type:'STOP_AUDIO'},popup);const stopped=await h.call({type:'GET_SETTINGS'},popup);assert.equal(stopped.capture,null);assert.equal(stopped.audioStatus.running,false);assert.equal(stopped.audioStatus.droppedChunks,0);assert.equal(stopped.audioStatus.processedChunks,0);
  assert.equal((await h.call({type:'GET_SETTINGS'},page)).audioStatus,undefined);
});
test('切换同窗口标签页会停止捕获，关闭文档', async()=>{
  const h=harness();await start(h);h.events.activated({tabId:2,windowId:2});await until(()=>h.closedDocuments===1);assert.equal(h.session.capture,undefined);
});

test('进度传输中的HTTP200错误仍拒绝结果，只提交一次模型请求',async()=>{
 const h=harness({fetchImpl:async(url,options)=>url.endsWith('/translate')?{ok:true,status:200,json:async()=>({ok:false,status:429,error:'模型限流',code:'RATE_LIMIT'})}:null});
 const result=await h.call({type:'TRANSLATE',videoId:'dQw4w9WgXcQ',items:[{id:'a',text:'Hello'}]},page);
 assert.equal(result.ok,false);assert.match(result.error,/429.*限流/);const calls=h.fetches.filter(f=>f.url.endsWith('/translate'));assert.equal(calls.length,1);assert.equal(calls[0].options.headers['X-YTZ-Progress'],'1');
});
test('浏览器撤销站点权限后停止对应采音，并通知已有页面重新核对权限',async()=>{
 const origin='https://videos.example',id='web:'+origin+'/watch/one';
 const h=harness({enabledSites:[origin],granted:[origin+'/*'],tab:{url:origin+'/watch/one'},pageState:{videoId:id}});
 await h.call({type:'START_AUDIO',tabId:1},popup);assert.ok(h.session.capture);
 h.granted.clear();await h.events.permissionsRemoved({origins:[origin+'/*']});await tick();
 assert.equal(h.session.capture,undefined);assert.ok(h.messages.some(m=>m.type==='RECHECK_SITE'));assert.equal(h.documentOpen,false);
});
test('并发外观与开关补丁按顺序合并，不互相覆盖保存的设置',async()=>{
 const h=harness();await h.call({type:'GET_SETTINGS'},popup);
 await Promise.all([h.call({type:'SET_SETTINGS',subtitlePosition:'top'},popup),h.call({type:'SET_SETTINGS',fontSize:32},popup),h.call({type:'SET_SETTINGS',enabled:false},popup)]);
 const result=await h.call({type:'GET_SETTINGS'},popup);assert.equal(result.subtitlePosition,'top');assert.equal(result.fontSize,32);assert.equal(result.enabled,false);
});

test('撤销无关权限不应停止仍获授权的Khan内嵌采音，实际撤销该播放器才停止',async()=>{
 const url='https://www.youtube-nocookie.com/embed/Uiqro5TUyLA/',id='web:'+url;
 const h=harness({enabledSites:['https://www.khanacademy.org'],granted:['https://www.khanacademy.org/*','https://www.youtube-nocookie.com/embed/*'],tab:{url:'https://www.khanacademy.org/video/test'},pageState:{videoId:id}});
 const sender={...page,url,frameId:2,tab:{id:1,url:'https://www.khanacademy.org/video/test'}};
 await h.call({type:'PAGE_STATE',videoId:id,generation:1,paused:false,visibleArea:90000},sender);
 assert.equal((await h.call({type:'START_AUDIO',tabId:1},popup)).ok,true);assert.equal(h.session.capture.frameId,2);
 await h.events.permissionsRemoved({origins:['https://unrelated.example/*']});await tick();assert.ok(h.session.capture,'无关权限变化不应误停仍授权的播放器');
 h.granted.delete('https://www.youtube-nocookie.com/embed/*');await h.events.permissionsRemoved({origins:['https://www.youtube-nocookie.com/embed/*']});await tick();assert.equal(h.session.capture,undefined);
});


test('采音停止回执延迟时，先将字幕停用消息送达视频页',async()=>{
 let finish;const h=harness({runtimeImpl:m=>m.type==='STOP'?new Promise(r=>finish=r):{ok:true}});await start(h);
 const disabling=h.call({type:'SET_SETTINGS',enabled:false},popup);await until(()=>typeof finish==='function');
 assert.ok(h.messages.some(m=>m.type==='SETTINGS'&&m.settings.enabled===false&&m.settings.captionsSuppressed===true));
 finish({ok:true});assert.equal((await disabling).enabled,false);
});

test('视频页没有收到开关时返回刷新提示；初始停用不控制原生字幕',async()=>{
 const h=harness({sessionEnabled:false,sendImpl:async()=>{throw new Error('Receiving end does not exist');}});
 await h.call({type:'GET_SETTINGS'},popup);assert.equal(h.local.captionsSuppressed,false);
 assert.equal((await h.call({type:'SET_SETTINGS',enabled:true},popup)).refreshRequired,true);
 await h.call({type:'SET_SETTINGS',enabled:false},popup);assert.equal(h.local.captionsSuppressed,true);
 assert.equal((await harness({local:h.local,session:h.session}).call({type:'GET_SETTINGS'},page)).captionsSuppressed,true);
});

test('API 设置导航仅接受固定板块，不允许自定义跳转目标',async()=>{
 const h=harness();await h.call({type:'OPEN_SETTINGS',section:'api'},popup);
 const url=new URL(h.createdTabs[0].url),fragment=new URLSearchParams(url.hash.slice(1));
 assert.equal(url.origin,'http://127.0.0.1:17865');assert.equal(url.search,'');assert.equal(fragment.get('section'),'api');assert.equal(fragment.get('token'),h.local.token);
 await h.call({type:'OPEN_SETTINGS',section:'https://evil.example/'},popup);
 assert.equal(new URLSearchParams(new URL(h.createdTabs[1].url).hash.slice(1)).has('section'),false);
 assert.equal((await h.call({type:'OPEN_SETTINGS',section:'api'},page)).ok,false);
 const unpaired=harness({local:{}});await unpaired.call({type:'OPEN_SETTINGS',section:'api'},popup);
 assert.equal(new URL(unpaired.createdTabs[0].url).hash,'#section=api');
});
