const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(translate,options={}) {
  let now = 100000, interval, receiver, nextTimer = 0;
  const timers = new Map(), events = new Map(), videoEvents = new Map(), requests = [], posted=[];
  class Element {
    constructor() {
      this.textContent = ''; this.children = []; this.isConnected = true;this.dataset={};
      this.attributes = new Set();
      const values = new Map();
      this.style = {getPropertyValue:key=>values.get(key)?.value || '',getPropertyPriority:key=>values.get(key)?.priority || '',setProperty:(key,value,priority='')=>values.set(key,{value,priority}),removeProperty:key=>values.delete(key)};
    }
    append(...nodes) {for(const node of nodes){node.parentElement=this;this.children.push(node);}}
    addEventListener() {}
    removeEventListener() {}
    attachShadow() {this.shadow = new Element(); return this.shadow;}
    toggleAttribute(name, force) {if(force)this.attributes.add(name);else this.attributes.delete(name);}
  }
  const player = new Element(), native = new Element(), segment = new Element(); segment.textContent = 'English subtitle';
  const hint = new Element();hint.textContent='英语（自动生成）点击查看设置';
  segment.closest = selector => selector === '.caption-window' ? {classList:{contains:()=>false}} : null;
  hint.closest = () => null;
  const video = {currentTime:1,duration:40,readyState:4,error:null,paused:false,parentElement:player,addEventListener:(name,fn)=>videoEvents.set(name,fn),removeEventListener:name=>videoEvents.delete(name)};
  let ccOn=options.ccOn===true,ccClicks=0;
  const cc={getAttribute:key=>key==='aria-pressed'?String(ccOn):'false',click:()=>{ccOn=!ccOn;ccClicks++;}};
  const location = {href:'https://www.youtube.com/watch?v=abcdefghijk',origin:'https://www.youtube.com'};
  const sandbox = {URL,Map,Set,Date:{now:()=>now},location,document:{title:'Public video',createElement:()=>new Element(),getElementById:id=>id==='movie_player'?player:null,querySelector:selector=>selector==='video'?video:selector==='.ytp-subtitles-button'&&options.ccButton?cc:null,querySelectorAll:selector=>selector==='.ytp-caption-window-container'?[native]:selector==='.ytp-caption-segment'?[segment,hint]:[]},setInterval:fn=>{interval=fn;},setTimeout:(fn)=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),chrome:{runtime:{id:'test-extension',onMessage:{addListener:fn=>{receiver=fn;}},sendMessage:async message=>{
    requests.push(message);
    if(message.type==='GET_SETTINGS')return options.getSettings?options.getSettings():{ok:true,enabled:true,bilingual:true,semanticSubtitles:options.semantic===true};
    if(message.type==='GET_CAPTIONS')return {ok:true,cues:[{id:'cue',start:0,end:3,text:'English subtitle'}]};
    if(message.type==='TRANSLATE')return translate(message);
    if(message.type==='TRANSLATE_SEGMENTS')return options.segmentTranslate(message);
    return {ok:true};
  }}}};
  sandbox.window=sandbox;sandbox.addEventListener=(name,fn)=>events.set(name,fn);sandbox.postMessage=data=>posted.push(data);
  vm.createContext(sandbox);
  for(const file of ['core.js','semantic.js','content.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),sandbox);
  const overlay = () => player.children.find(node=>node.id==='ytz-assistant-overlay');
  return {native,segment,video,requests,posted,get ccOn(){return ccOn;},get ccClicks(){return ccClicks;},async tick(){interval();await flush();},async timers(){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());await flush();},tracks(list){sandbox.__tracks=list;sandbox.__receive=events.get('message');vm.runInContext("__receive({source:window,origin:location.origin,data:{source:'ytz-caption-tracks-v1',videoId:'abcdefghijk',tracks:__tracks}})",sandbox);},nativeCaptions(data,videoId='abcdefghijk',nativeTrack={...track,native:true}){sandbox.__data={source:'ytz-native-captions-v1',videoId,track:nativeTrack,data};sandbox.__receive=events.get('message');vm.runInContext('__receive({source:window,origin:location.origin,data:__data})',sandbox);},transcript(overrides={}){const request=posted.findLast(p=>p.source==='ytz-transcript-request-v1');sandbox.__data={...request,source:'ytz-transcript-captions-v1',precision:'seconds',segments:[{start:0,text:'Transcript opening'},{start:35,text:'Transcript ending'}],...overrides};sandbox.__receive=events.get('message');vm.runInContext('__receive({source:window,origin:location.origin,data:__data})',sandbox);},message(message){receiver(message,{id:'test-extension'},()=>{});},seek(time){video.currentTime=time;videoEvents.get('seeking')();},advance(ms){now+=ms;},text(){return overlay()?.shadow.children.slice(1).map(node=>node.textContent) || [];},overlay};
}
const track = {baseUrl:'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en',languageCode:'en'};

test('YouTube长字幕分页保留所有文字，暂停保持当前页并可向前向后跳转',async()=>{
 const translation='首先说明我们需要保留全部字幕内容，然后按照自然的分句依次显示，最后确认屏幕上每种语言都不会超过两行。'.repeat(3);
 const f=fixture(async()=>({ok:true,items:[]}),{semantic:true,segmentTranslate:m=>Promise.resolve({ok:true,segments:[{sourceIds:m.items.map(c=>c.id),text:translation}]})});
 await f.tick();f.nativeCaptions({events:[{tStartMs:0,dDurationMs:12000,segs:[{utf8:'The complete source sentence contains all the information about readable subtitles and natural clauses.'}]}]});await flush();
 const total=Number(f.overlay().dataset.captionPages);assert.ok(total>1);const seen=[];
 for(let i=0;i<total;i++){f.video.currentTime=(i+.1)*12/total;await f.tick();assert.equal(f.overlay().dataset.captionPage,String(i+1));assert.ok(f.text()[0].split('\n').length<=2);assert.ok(f.text()[1].split('\n').length<=2);seen.push(f.text()[0]);}
 assert.equal(seen.join('').replace(/\s/g,''),translation.replace(/[，。\s]/g,''));
 f.video.paused=true;const last=f.text()[0];f.advance(30000);await f.tick();assert.equal(f.text()[0],last);
 f.seek(.1);await f.tick();assert.equal(f.overlay().dataset.captionPage,'1');f.seek(11.9);await f.tick();assert.equal(f.overlay().dataset.captionPage,String(total));
 f.video.currentTime=12;await f.tick();assert.equal(f.text()[0],'');assert.equal(f.text()[2],'');
});

test('字幕整理中和后续预取不显示第三行提示，已完成的中英字幕保持可见',async()=>{
 let finish;
 const f=fixture(async()=>({ok:true,items:[]}),{semantic:true,segmentTranslate:m=>m.items[0].start===0?Promise.resolve({ok:true,segments:m.items.map(c=>({sourceIds:[c.id],text:'第一句中文'}))}):new Promise(r=>finish=()=>r({ok:true,segments:m.items.map(c=>({sourceIds:[c.id],text:'后续中文'}))}))});
 await f.tick();assert.equal(f.text()[2],'');
 const first={tStartMs:0,dDurationMs:4000,segs:[{utf8:'First sentence.'}]};
 f.nativeCaptions({events:[first,{tStartMs:100000,dDurationMs:4000,segs:[{utf8:'Later sentence.'}]}]});await flush();
 assert.equal(f.text()[0],'第一句中文');assert.equal(f.text()[1],'First sentence');assert.equal(f.text()[2],'');
 f.advance(1000);f.video.currentTime=11;await f.tick();assert.equal(typeof finish,'function');assert.equal(f.text()[2],'');
 f.video.currentTime=1;await f.tick();assert.equal(f.text()[0],'第一句中文');assert.equal(f.text()[1],'First sentence');assert.equal(f.text()[2],'');
 finish();await flush();assert.equal(f.text()[0],'第一句中文');assert.equal(f.text()[2],'');
});

test('DOM语义等待及音频进度不会成为字幕第三行',async()=>{
 const f=fixture(async()=>({ok:true,items:[]}),{semantic:true,segmentTranslate:()=>new Promise(()=>{})});await f.tick();f.tracks([]);f.segment.textContent='Incomplete sentence';await f.tick();assert.equal(f.text()[2],'');
 f.advance(1300);await f.tick();assert.equal(f.text()[2],'');assert.equal(f.text()[0],'');assert.notEqual(f.native.style.getPropertyValue('visibility'),'hidden');
 const page={videoId:'abcdefghijk',pageGeneration:f.requests.findLast(m=>m.type==='PAGE_STATE').generation,generation:'audio'};
 f.message({type:'AUDIO_STATE',...page,running:true,message:'正在等待并整理完整语句…'});
 f.message({type:'AUDIO_PROGRESS',...page,message:'正在识别语音…'});assert.equal(f.text()[2],'');
});

test('YouTube字幕轨语义请求等待时无提示且保留原生CC',async()=>{
 let finish;const f=fixture(async()=>({ok:true,items:[]}),{semantic:true,segmentTranslate:m=>new Promise(r=>finish=()=>r({ok:true,segments:m.items.map(c=>({sourceIds:[c.id],text:'完成后的中文字幕'}))}))});
 await f.tick();f.nativeCaptions({events:[{tStartMs:0,dDurationMs:4000,segs:[{utf8:'Complete sentence.'}]}]});await flush();
 assert.equal(typeof finish,'function');assert.equal(f.text()[0],'');assert.equal(f.text()[2],'');assert.notEqual(f.native.style.getPropertyValue('visibility'),'hidden');
 finish();await flush();assert.equal(f.text()[0],'完成后的中文字幕');assert.equal(f.text()[1],'Complete sentence');assert.equal(f.text()[2],'');assert.equal(f.native.style.getPropertyValue('visibility'),'hidden');
});
test('语义429之后跳转保留退避窗口，不立即发起新模型请求',async()=>{
 const f=fixture(async()=>({ok:true,items:[]}),{semantic:true,segmentTranslate:async()=>{throw new Error('429 限流');}});await f.tick();
 f.nativeCaptions({events:[{tStartMs:0,dDurationMs:20000,segs:[{utf8:'Complete sentence.'}]}]});await flush();assert.equal(f.requests.filter(m=>m.type==='TRANSLATE_SEGMENTS').length,1);
 f.seek(5);f.advance(59000);await f.tick();assert.equal(f.requests.filter(m=>m.type==='TRANSLATE_SEGMENTS').length,1);
 f.advance(1001);await f.tick();assert.equal(f.requests.filter(m=>m.type==='TRANSLATE_SEGMENTS').length,2);
});
test('实时语义失败后渲染和后续采音结果不会继续请求翻译',async()=>{
 const f=fixture(async()=>({ok:true,items:[]}),{semantic:true,segmentTranslate:async()=>{throw new Error('429 限流');}});await f.tick();f.tracks([]);
 f.segment.textContent='First sentence.';await f.tick();f.advance(1300);await f.tick();await flush();
 assert.equal(f.requests.filter(m=>m.type==='TRANSLATE_SEGMENTS').length,1);
 const generation=f.requests.findLast(m=>m.type==='PAGE_STATE').generation;
 f.message({type:'AUDIO_STATE',running:true,generation:'audio',pageGeneration:generation,videoId:'abcdefghijk'});
 for(let i=0;i<3;i++){f.message({type:'AUDIO_RESULT',generation:'audio',pageGeneration:generation,videoId:'abcdefghijk',text:'Another sentence.',start:2+i,end:3+i});f.advance(20000);await f.tick();}
 assert.equal(f.requests.filter(m=>m.type==='TRANSLATE_SEGMENTS').length,1);
});

test('完整语句模式跨原生碎片保持稳定，到最后片段结束才切换，并可切回逐片显示',async()=>{
 const f=fixture(async m=>({ok:true,items:m.items.map(c=>({id:c.id,text:'逐片字幕'}))}),{semantic:true,segmentTranslate:async m=>({ok:true,segments:[{sourceIds:m.items.slice(0,3).map(c=>c.id),text:'因为我们需要完整的句子。'},{sourceIds:m.items.slice(3).map(c=>c.id),text:'然后继续。'}]})});await f.tick();
 f.nativeCaptions({events:['Because we','need complete','sentences.','Then continue.'].map((text,i)=>({tStartMs:i*2000,dDurationMs:3000,segs:[{utf8:text}]}))});await flush();
 for(const time of [1,3,5.99]){f.video.currentTime=time;await f.tick();assert.equal(f.text()[0],'因为我们需要完整的句子');assert.equal(f.overlay().dataset.groupEnd,'6');}
 f.video.currentTime=6;await f.tick();assert.equal(f.text()[0],'然后继续');assert.equal(f.text()[2],'');
 f.message({type:'SETTINGS',settings:{enabled:true,bilingual:true,semanticSubtitles:false}});f.advance(1000);await f.tick();assert.equal(f.overlay().dataset.semantic,'false');assert.equal(f.text()[0],'逐片字幕');
});

test('完整语句服务失败时保留原生字幕，跳转后迟到结果不显示',async()=>{
 const failed=fixture(async()=>({ok:true,items:[]}),{semantic:true,segmentTranslate:async()=>{throw new Error('语义服务暂不可用');}});await failed.tick();failed.nativeCaptions({events:[{tStartMs:0,dDurationMs:4000,segs:[{utf8:'A complete sentence.'}]}]});await flush();assert.equal(failed.text()[2],'');assert.equal(failed.native.style.getPropertyValue('visibility'),'');
 let finish;const f=fixture(async()=>({ok:true,items:[]}),{semantic:true,segmentTranslate:m=>new Promise(r=>finish=()=>r({ok:true,segments:[{sourceIds:m.items.map(c=>c.id),text:'过期句子'}]}))});await f.tick();f.nativeCaptions({events:[{tStartMs:0,dDurationMs:4000,segs:[{utf8:'A complete sentence.'}]}]});await flush();f.seek(10);finish();await flush();assert.equal(f.text()[0],'');
});

test('字幕等待与间隙保留原生 CC，成功翻译后替换，停用立即隐藏全部字幕',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  f.native.style.setProperty('visibility','visible','important');
  await f.tick();f.tracks([track]);await flush();
  assert.equal(f.native.style.getPropertyValue('visibility'),'visible');
  assert.equal(f.text()[1],'');
  finish({ok:true,items:[{id:'cue',text:'中文字幕'}]});await flush();
  assert.equal(f.text()[0],'中文字幕');assert.equal(f.native.style.getPropertyValue('visibility'),'hidden');
  f.seek(5);await f.tick();assert.equal(f.native.style.getPropertyValue('visibility'),'visible');
  f.seek(1);await f.tick();assert.equal(f.native.style.getPropertyValue('visibility'),'hidden');
  f.message({type:'SETTINGS',settings:{enabled:false,bilingual:true}});
  assert.equal(f.native.style.getPropertyValue('visibility'),'hidden');assert.equal(f.text()[0],'');assert.equal(f.text()[1],'');
  assert.equal(f.overlay().style.display,'none');
  f.message({type:'SETTINGS',settings:{enabled:true,bilingual:true}});
  assert.equal(f.text()[0],'中文字幕');assert.equal(f.native.style.getPropertyValue('visibility'),'hidden');
});

test('翻译失败保留原字幕并暂停请求，字幕区不显示状态提示',async()=>{
  const f=fixture(async()=>{throw new Error('翻译连接失败');});await f.tick();f.tracks([track]);await flush();
  assert.equal(f.native.style.getPropertyValue('visibility'),'');assert.equal(f.text()[0],'');assert.equal(f.text()[2],'');
  f.advance(180000);await f.tick();assert.equal(f.requests.filter(x=>x.type==='TRANSLATE').length,1);
  f.message({type:'SETTINGS',settings:{enabled:false,bilingual:true}});f.message({type:'SETTINGS',settings:{enabled:true,bilingual:true}});await f.tick();
  assert.equal(f.requests.filter(x=>x.type==='TRANSLATE').length,2);
  const dom=fixture(async()=>{throw new Error('本机服务未启动');});await dom.tick();dom.tracks([]);await dom.tick();await dom.timers();
  assert.equal(dom.text()[2],'');dom.tracks([]);await dom.tick();assert.equal(dom.text()[2],'');
});

test('DOM 迟到译文与原句对应且无状态提示，保留当前 CC，再次出现使用缓存',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));await f.tick();f.tracks([]);await f.tick();await f.timers();
  f.segment.textContent='A different sentence';await f.tick();
  finish({ok:true,items:[{id:'dom',text:'旧句的中文'}]});await flush();
  assert.equal(f.text()[0],'旧句的中文');assert.equal(f.text()[1],'English subtitle');assert.equal(f.text()[2],'');assert.equal(f.native.style.getPropertyValue('visibility'),'');
  assert.equal(f.overlay().attributes.has('data-delayed'),true);
  f.segment.textContent='English subtitle';await f.tick();await f.timers();
  assert.equal(f.text()[0],'旧句的中文');assert.equal(f.requests.filter(x=>x.type==='TRANSLATE').length,1);
  assert.equal(f.overlay().attributes.has('data-delayed'),false);
});

test('DOM 原文排除 CC 设置提示，只翻译真实字幕',async()=>{
  const f=fixture(async message=>({ok:true,items:message.items.map(i=>({...i,text:'译文'}))}));
  await f.tick();f.tracks([]);await f.tick();await f.timers();
  assert.equal(f.requests.find(x=>x.type==='TRANSLATE').items[0].text,'English subtitle');
});

test('空字幕20秒后仅请求一次文字稿恢复，旧代次和缺尾文字稿拒绝，原生字幕可覆盖粗时序',async()=>{
  const f=fixture(async m=>({ok:true,items:m.items.map(i=>({...i,text:'文字稿译文'}))}));
  await f.tick();f.tracks([]);f.advance(19999);await f.tick();assert.equal(f.posted.filter(p=>p.source==='ytz-transcript-request-v1').length,0);
  f.advance(1);await f.tick();await f.tick();assert.equal(f.posted.filter(p=>p.source==='ytz-transcript-request-v1').length,1);
  f.transcript({generation:-1});await flush();assert.equal(f.overlay().dataset.cueCount,'0');
  f.video.duration=100;f.transcript();await flush();assert.equal(f.overlay().dataset.cueCount,'0');
  f.video.duration=40;f.transcript();await flush();assert.equal(f.overlay().dataset.captionSource,'transcript');assert.equal(f.text()[0],'文字稿译文');assert.equal(f.text()[2],'');assert.equal(f.overlay().dataset.timePrecision,'seconds');
  f.nativeCaptions({events:[{tStartMs:0,dDurationMs:3000,segs:[{utf8:'Precise native caption'}]}]});await flush();assert.equal(f.overlay().dataset.captionSource,'native');assert.equal(f.overlay().dataset.timePrecision,'milliseconds');
});

test('播放器发生媒体错误时不展示错误时间的字幕，也不继续消耗翻译调用',async()=>{
  const f=fixture(async m=>({ok:true,items:m.items.map(i=>({...i,text:'译文'}))}));await f.tick();f.tracks([track]);await flush();assert.equal(f.text()[0],'译文');
  const count=f.requests.filter(r=>r.type==='TRANSLATE').length;f.video.error={code:2};f.video.readyState=0;f.video.currentTime=0;await f.tick();assert.equal(f.text()[0],'');assert.equal(f.text()[2],'');assert.equal(f.requests.filter(r=>r.type==='TRANSLATE').length,count);assert.equal(f.native.style.getPropertyValue('visibility'),'');
  f.video.error=null;await f.tick();assert.equal(f.text()[0],'');assert.equal(f.text()[2],'');assert.equal(f.requests.filter(r=>r.type==='TRANSLATE').length,count);
  f.video.error=null;f.video.readyState=4;f.video.currentTime=1;await f.tick();assert.equal(f.text()[0],'译文');
});

test('原生字幕到达后切换预取，旧 DOM 结果不能覆盖字幕轨，同一响应不重复翻译',async()=>{
  let finishDom;
  const f=fixture(message=>message.items[0].id==='dom' ? new Promise(resolve=>{finishDom=resolve;}) : Promise.resolve({ok:true,items:message.items.map(i=>({...i,text:'字幕轨译文'}))}));
  await f.tick();f.tracks([]);await f.tick();await f.timers();
  const data={events:[{tStartMs:0,dDurationMs:3000,segs:[{utf8:'Native caption'}]},{tStartMs:3000,dDurationMs:3000,segs:[{utf8:'Upcoming caption'}]}]};
  f.nativeCaptions(data);await flush();
  assert.equal(f.text()[0],'字幕轨译文');assert.equal(f.text()[2],'');
  finishDom({ok:true,items:[{id:'dom',text:'过期译文'}]});await flush();
  assert.equal(f.text()[0],'字幕轨译文');
  f.nativeCaptions(data);await flush();
  f.nativeCaptions(data,'abcdefghijk',{...track,baseUrl:track.baseUrl+'&pot=renewed',native:true});await flush();
  assert.equal(f.requests.filter(x=>x.type==='TRANSLATE').length,2);
});

test('原生字幕消息拒绝其他视频、外部 URL 及无效内容',async()=>{
  const f=fixture(async()=>({ok:true,items:[]}));await f.tick();
  const data={events:[{tStartMs:0,segs:[{utf8:'Caption'}]}]};
  f.nativeCaptions(data,'otherabcdef');
  f.nativeCaptions(data,'abcdefghijk',{baseUrl:'https://evil.example/api/timedtext?v=abcdefghijk',native:true});
  f.nativeCaptions({events:[]});await flush();
  assert.equal(f.requests.filter(x=>x.type==='TRANSLATE').length,0);
});

test('跳转后拒绝旧音频结果、错误与丢片进度',async()=>{
  const f=fixture(async()=>({ok:true,items:[]}));await f.tick();
  const page={videoId:'abcdefghijk',pageGeneration:1,generation:2};
  f.message({type:'AUDIO_STATE',...page,running:true,message:'音频开始'});
  f.message({type:'AUDIO_PROGRESS',...page,message:'忙时跳过 2 片'});assert.equal(f.text()[2],'');
  f.seek(5);const before=f.text()[2];
  f.message({type:'AUDIO_RESULT',...page,text:'Old audio',translation:'过期字幕'});
  f.message({type:'AUDIO_ERROR',...page,message:'过期错误'});
  f.message({type:'AUDIO_PROGRESS',...page,message:'过期进度'});
  f.message({type:'AUDIO_STATE',...page,running:false,message:'过期停止'});
  assert.equal(f.text()[0],'');assert.equal(f.text()[2],before);
});


test('启用无需等待字幕轨失败就开启原生CC；停用和再次启用可重复切换',async()=>{
 const f=fixture(async()=>({ok:true,items:[]}),{ccButton:true,getSettings:async()=>({ok:true,enabled:false})});await f.tick();assert.equal(f.ccClicks,0);
 f.message({type:'SETTINGS',settings:{enabled:true}});assert.equal(f.ccOn,true);assert.equal(f.ccClicks,1);
 f.message({type:'SETTINGS',settings:{enabled:false}});assert.equal(f.ccOn,false);assert.equal(f.ccClicks,2);assert.equal(f.native.style.getPropertyValue('visibility'),'hidden');
 f.message({type:'SETTINGS',settings:{enabled:true}});assert.equal(f.ccOn,true);assert.equal(f.ccClicks,3);assert.equal(f.native.style.getPropertyValue('visibility'),'');
});

test('视频页刚加载尚未执行首次轮询时，启用消息也立即开启CC',async()=>{
 const f=fixture(async()=>({ok:true,items:[]}),{ccButton:true,getSettings:async()=>({ok:true,enabled:false})});
 f.message({type:'SETTINGS',settings:{enabled:true}});assert.equal(f.ccOn,true);assert.equal(f.ccClicks,1);
 await flush();assert.notEqual(f.overlay().style.display,'none');
});

test('晚到的初始化设置不能覆盖刚刚启用或停用的字幕',async()=>{
 for(const enabled of [true,false]){
  let finish;const f=fixture(async()=>({ok:true,items:[]}),{getSettings:()=>new Promise(r=>finish=r)});
  await f.tick();f.message({type:'SETTINGS',settings:{enabled}});finish({ok:true,enabled:!enabled});await flush();
  assert.equal(f.overlay().style.display,enabled?'':'none');
 }
});

test('字幕译文仍在处理时停用立即清空，迟到响应不能恢复字幕',async()=>{
 let finish;const f=fixture(()=>new Promise(r=>finish=r));await f.tick();f.tracks([track]);await flush();
 f.message({type:'SETTINGS',settings:{enabled:false}});assert.equal(f.overlay().style.display,'none');assert.equal(f.native.style.getPropertyValue('visibility'),'hidden');
 finish({ok:true,items:[{id:'cue',text:'迟到的中文'}]});await flush();await f.tick();assert.equal(f.text()[0],'');assert.equal(f.overlay().style.display,'none');
});


test('YouTube两种字幕模式收到低延迟识别结果均立即送译并显示，不等句号',async()=>{
 for(const semantic of [true,false]){
  const f=fixture(async m=>({ok:true,items:m.items.map(c=>({id:c.id,text:'立即送译的中文'}))}),{semantic,segmentTranslate:async m=>({ok:true,segments:m.items.map(c=>({sourceIds:[c.id],text:'立即送译的中文'}))})});await f.tick();f.tracks([]);f.video.currentTime=2;
  const page={videoId:'abcdefghijk',pageGeneration:f.requests.findLast(m=>m.type==='PAGE_STATE').generation,generation:'fast-audio'};
  f.message({type:'AUDIO_STATE',...page,running:true,lowLatency:true});const before=f.requests.filter(m=>m.type.startsWith('TRANSLATE')).length;
  f.message({type:'AUDIO_RESULT',...page,text:'An unfinished phrase',start:0,end:2,deferred:true,lowLatency:true});await flush();await f.tick();
  assert.equal(f.requests.filter(m=>m.type.startsWith('TRANSLATE')).length,before+1);assert.equal(f.text()[0],'立即送译的中文');assert.equal(f.overlay().attributes.has('data-delayed'),true);
  f.message({type:'SETTINGS',settings:{enabled:false,semanticSubtitles:semantic}});assert.equal(f.text()[0],'');
 }
});
