const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}){
 let now=100000,interval,receiver,allowed=options.allowed!==false,live=true;const events=new Map(),videoEvents=new Map(),requests=[];
 class Element{
  constructor(tag='DIV'){this.tagName=tag;this.textContent='';this.children=[];this.dataset={};this.isConnected=true;this.attributes=new Set();const values=new Map();this.style={getPropertyValue:k=>values.get(k)?.value||this.style[k]||'',getPropertyPriority:k=>values.get(k)?.priority||'',setProperty:(k,v,priority='')=>{values.set(k,{value:v,priority});this.style[k]=v;},removeProperty:k=>{values.delete(k);delete this.style[k];}};}
  append(...nodes){for(const n of nodes){n.parentElement=this;n.parentNode=this;this.children.push(n);}}
  addEventListener() {}
  removeEventListener() {}
  attachShadow({mode}){const root=new Element('#shadow-root');root.host=this;if(mode==='open')this.shadowRoot=root;this.shadow=root;return root;}
  remove(){this.isConnected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}
  toggleAttribute(k,on){if(on)this.attributes.add(k);else this.attributes.delete(k);}
  removeAttribute(k){this.attributes.delete(k);}
  getBoundingClientRect(){return {left:0,top:0,right:900,bottom:500,width:900,height:500};}
  querySelectorAll(selector){const all=[];const walk=n=>{for(const child of n.children){all.push(child);walk(child);}};walk(this);return all.filter(n=>selector==='*'||selector==='video'&&n.tagName==='VIDEO'||selector.split(',').includes(options.captionSelector||'.vjs-text-track-cue')&&n===segment||selector.includes('media-captions')&&n===native);}
 }
 const body=new Element('BODY'),player=new Element('MEDIA-PLAYER'),native=new Element('MEDIA-CAPTIONS'),segment=new Element('SPAN');segment.textContent='First sentence';native.append(segment);body.append(player);
 const track={kind:'subtitles',language:'en',mode:'showing',cues:[{startTime:0,endTime:8,text:'Hello world'},{startTime:8,endTime:20,text:'Next sentence'}]};
 const video=new Element('VIDEO');Object.assign(video,{currentTime:1,currentSrc:'blob:first',src:'blob:first',duration:20,readyState:4,error:null,paused:false,textTracks:options.noTrack?[]:[track],addEventListener:(n,fn)=>videoEvents.set(n,fn),removeEventListener:n=>videoEvents.delete(n),closest:()=>player});player.append(video,native);
 Object.defineProperty(track,'activeCues',{get:()=>track.cues.filter(c=>c.startTime<=video.currentTime&&c.endTime>video.currentTime)});
 const location={href:'https://videos.example/watch/one',origin:'https://videos.example'};
 const document={title:'Test video',body,fullscreenElement:null,createElement:tag=>new Element(tag.toUpperCase()),querySelectorAll:s=>body.querySelectorAll(s)};
 const sandbox={URL,Map,Set,Date:{now:()=>now},location,document,innerWidth:1000,innerHeight:700,getComputedStyle:e=>({visibility:e.style.getPropertyValue('visibility')||'visible',display:e.style.display||'block'}),setInterval:fn=>{interval=fn;return 1;},clearInterval:()=>{live=false;},chrome:{runtime:{id:'test-extension',onMessage:{addListener:fn=>receiver=fn,removeListener:fn=>{if(receiver===fn)receiver=null;}},sendMessage:async message=>{requests.push(message);if(message.type==='GET_SETTINGS')return options.getSettings?options.getSettings():allowed?{ok:true,enabled:true,bilingual:true,semanticSubtitles:options.semantic===true}: {ok:false,error:'不允许的消息来源'};if(message.type==='TRANSLATE_SEGMENTS')return options.segmentTranslate(message);if(message.type==='TRANSLATE')return options.translate?options.translate(message):{ok:true,items:message.items.map(i=>({id:i.id,text:'中文：'+i.text}))};return {ok:true};}}}};
 sandbox.window=sandbox;sandbox.addEventListener=(n,fn)=>events.set(n,fn);sandbox.removeEventListener=n=>events.delete(n);vm.createContext(sandbox);for(const file of ['core.js','semantic.js','generic.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),sandbox);
 const overlay=()=>body.children.find(e=>e.id==='ytz-assistant-overlay');
 return {sandbox,body,player,native,segment,video,track,requests,overlay,events,videoEvents,async tick(){await flush();now+=1000;if(live)interval();await flush();},async message(m){receiver?.(m,{id:'test-extension'},()=>{});await flush();},deny(){allowed=false;},text:()=>overlay()?.shadow.children.slice(1).map(e=>e.textContent)||[],get live(){return live;},advance(ms){now+=ms;},Element};
}
test('网页长字幕按原时间窗口分页且关闭双语不影响全部中文',async()=>{
 const translation='这一段文字比较长，所以需要按照自然分句分页显示，读完当前内容之后再显示下一部分，全部文字都应该保留。'.repeat(3);
 const f=fixture({semantic:true,segmentTranslate:m=>Promise.resolve({ok:true,segments:m.items.map(c=>({sourceIds:[c.id],text:translation}))})});f.track.cues=[{startTime:0,endTime:12,text:'A complete source sentence about readable subtitles.'}];await f.tick();
 const total=Number(f.overlay().dataset.captionPages),seen=[];assert.ok(total>1);
 for(let i=0;i<total;i++){f.video.currentTime=(i+.1)*12/total;await f.tick();assert.equal(f.overlay().dataset.captionPage,String(i+1));assert.ok(f.text()[0].split('\n').length<=2);seen.push(f.text()[0]);}
 assert.equal(seen.join('').replace(/\s/g,''),translation.replace(/[，。\s]/g,''));
 await f.message({type:'SETTINGS',settings:{enabled:true,bilingual:false,semanticSubtitles:true}});assert.equal(f.text()[1],'');assert.ok(f.text()[0]);
 f.video.currentTime=12;await f.tick();assert.equal(f.text()[0],'');assert.equal(f.text()[2],'');
});

test('网页完整语句等待与完成时只显示字幕，切换逐片模式也无提示',async()=>{
 let finish;const f=fixture({semantic:true,segmentTranslate:m=>new Promise(r=>finish=()=>r({ok:true,segments:m.items.map(c=>({sourceIds:[c.id],text:'中文 '+c.text}))}))});
 await f.tick();assert.equal(f.text()[0],'');assert.equal(f.text()[2],'');assert.equal(f.track.mode,'showing');
 finish();await flush();assert.equal(f.text()[0],'中文 Hello world');assert.equal(f.text()[1],'Hello world');assert.equal(f.text()[2],'');
 await f.message({type:'SETTINGS',settings:{enabled:true,bilingual:false,semanticSubtitles:false}});await f.tick();assert.equal(f.text()[0],'中文 Hello world');assert.equal(f.text()[1],'');assert.equal(f.text()[2],'');
});

test('网页DOM语义等待及音频进度不会显示提示文字',async()=>{
 const f=fixture({semantic:true,noTrack:true,segmentTranslate:()=>new Promise(()=>{})});await f.tick();assert.equal(f.text()[2],'');assert.equal(f.text()[0],'');assert.notEqual(f.native.style.getPropertyValue('visibility'),'hidden');
 const page={videoId:'web:https://videos.example/watch/one',pageGeneration:f.requests.findLast(m=>m.type==='PAGE_STATE').generation,generation:'audio'};
 await f.message({type:'AUDIO_STATE',...page,running:true,message:'正在等待并整理完整语句…'});
 await f.message({type:'AUDIO_PROGRESS',...page,message:'正在识别语音…'});assert.equal(f.text()[2],'');
});

test('网页实时整理失败后，继续渲染及采音不会再次调用翻译',async()=>{
 const f=fixture({semantic:true,noTrack:true,segmentTranslate:async()=>{throw new Error('429 限流');}});f.segment.textContent='First sentence.';await f.tick();await f.tick();await flush();
 assert.equal(f.requests.filter(m=>m.type==='TRANSLATE_SEGMENTS').length,1);
 const generation=f.requests.findLast(m=>m.type==='PAGE_STATE').generation;
 await f.message({type:'AUDIO_STATE',running:true,generation:'audio',pageGeneration:generation,videoId:'web:https://videos.example/watch/one'});
 for(let i=0;i<3;i++){await f.message({type:'AUDIO_RESULT',generation:'audio',pageGeneration:generation,videoId:'web:https://videos.example/watch/one',text:'Another sentence.',start:2+i,end:3+i});f.advance(20000);await f.tick();}
 assert.equal(f.requests.filter(m=>m.type==='TRANSLATE_SEGMENTS').length,1);
});
test('网页字幕中间插入后保留原有完整语句，不重复翻译已有cue',async()=>{
 const f=fixture({semantic:true,segmentTranslate:async m=>({ok:true,segments:m.items.map(c=>({sourceIds:[c.id],text:'译文 '+c.text}))})});f.video.currentTime=10;f.track.cues=[{startTime:10,endTime:15,text:'Ten.'},{startTime:20,endTime:25,text:'Twenty.'}];await f.tick();
 const first=f.text()[0];assert.equal(f.requests.filter(m=>m.type==='TRANSLATE_SEGMENTS').length,1);
 f.track.cues.unshift({startTime:5,endTime:8,text:'Five.'});await f.tick();assert.equal(f.text()[0],first);
 const requests=f.requests.filter(m=>m.type==='TRANSLATE_SEGMENTS');assert.equal(requests.length,2);assert.deepEqual(Array.from(requests[1].items,c=>c.text),['Five.']);
});
test('网页完整语句跨碎片保持稳定，原生轨重建数组不会丢失结果',async()=>{
 const f=fixture({semantic:true,segmentTranslate:async m=>({ok:true,segments:[{sourceIds:m.items.slice(0,3).map(c=>c.id),text:'因为我们需要完整的句子。'},{sourceIds:m.items.slice(3).map(c=>c.id),text:'然后继续。'}]})});f.track.cues=['Because we','need complete','sentences.','Then continue.'].map((text,i)=>({startTime:i*2,endTime:i*2+3,text}));await f.tick();
 for(const time of [1,3,5.99]){f.video.currentTime=time;await f.tick();assert.equal(f.text()[0],'因为我们需要完整的句子');assert.equal(f.overlay().dataset.groupEnd,'6');}f.video.currentTime=6;await f.tick();assert.equal(f.text()[0],'然后继续');assert.equal(f.text()[2],'');assert.equal(f.requests.filter(m=>m.type==='TRANSLATE_SEGMENTS').length,1);
 await f.message({type:'SETTINGS',settings:{enabled:true,bilingual:true,semanticSubtitles:false}});await f.tick();assert.equal(f.overlay().dataset.semantic,'false');assert.equal(f.text()[0],'中文 Then continue');
});

test('网页权限撤销复核会清理已有浮层并还原原生字幕',async()=>{
 const f=fixture();await f.tick();assert.match(f.text()[0],/中文/);assert.equal(f.track.mode,'hidden');
 f.deny();await f.message({type:'RECHECK_SITE'});assert.equal(f.overlay(),undefined);assert.equal(f.track.mode,'showing');assert.equal(f.live,false);
});
test('原生轨同数量更新正文或移除后，不展示已过期的中文',async()=>{
 const f=fixture();await f.tick();assert.equal(f.text()[0],'中文 Hello world');
 f.track.cues[0].text='Updated cue';await f.tick();assert.equal(f.text()[0],'中文 Updated cue');
 f.video.textTracks=[];f.segment.textContent='';await f.tick();assert.equal(f.text()[0],'');assert.equal(f.text()[1],'');
});
test('同一video与blob地址收到新媒体元数据时隔离旧译文',async()=>{
 const f=fixture();await f.tick();f.track.cues[0].text='Another video opening';
 f.videoEvents.get('loadedmetadata')?.();await f.tick();assert.equal(f.text()[0],'中文 Another video opening');
});
test('开放Shadow DOM中的网页视频可以找到并翻译',async()=>{
 const f=fixture(),root=f.player.attachShadow({mode:'open'});f.video.remove();f.video.isConnected=true;root.append(f.video);
 await f.tick();assert.equal(f.text()[0],'中文 Hello world');
});
test('有对应中文才隐藏自绘原字幕，停用隐藏字幕轨与原文，再启用复用中文',async()=>{
 const f=fixture();f.native.style.setProperty('visibility','visible','important');await f.tick();
 assert.equal(f.native.style.getPropertyValue('visibility'),'hidden');
 await f.message({type:'SETTINGS',settings:{enabled:false,bilingual:true}});
 assert.equal(f.track.mode,'hidden');assert.equal(f.native.style.getPropertyValue('visibility'),'hidden');assert.equal(f.overlay().style.display,'none');assert.equal(f.text()[0],'');
 const count=f.requests.filter(m=>m.type==='TRANSLATE').length;
 await f.message({type:'SETTINGS',settings:{enabled:true,bilingual:true}});
 assert.equal(f.text()[0],'中文 Hello world');assert.equal(f.requests.filter(m=>m.type==='TRANSLATE').length,count);
});
test('网页DOM字幕消失时清空旧中文，迟到译文无提示并保留当前CC',async()=>{
 const direct=fixture({noTrack:true});await direct.tick();assert.equal(direct.text()[0],'中文 First sentence');
 direct.segment.textContent='';await direct.tick();assert.equal(direct.text()[0],'');assert.equal(direct.text()[1],'');
 let finish;const f=fixture({noTrack:true,translate:()=>new Promise(r=>finish=r)});await f.tick();f.segment.textContent='A newer sentence';await f.tick();
 finish({ok:true,items:[{id:'dom',text:'旧句的中文'}]});await flush();assert.equal(f.text()[0],'旧句的中文');assert.equal(f.text()[1],'First sentence');assert.equal(f.text()[2],'');assert.equal(f.overlay().attributes.has('data-delayed'),true);assert.notEqual(f.native.style.getPropertyValue('visibility'),'hidden');
});
test('字幕正常推进和翻译失败均无状态文字，失败保持暂停',async()=>{
 const f=fixture();await f.tick();assert.equal(f.text()[2],'');f.video.currentTime=9;await f.tick();assert.equal(f.text()[2],'');
 const failed=fixture({translate:async()=>({ok:false,error:'模型错误'})});await failed.tick();assert.equal(failed.text()[2],'');failed.video.currentTime=9;await failed.tick();assert.equal(failed.text()[2],'');assert.equal(failed.requests.filter(m=>m.type==='TRANSLATE').length,1);assert.equal(failed.track.mode,'showing');
});
test('网页新增无语言渲染轨不会抢走已选英语轨或重复调用模型',async()=>{
 const f=fixture();await f.tick();f.video.textTracks.push({kind:'captions',language:'',mode:'showing',cues:[{startTime:0,endTime:20,text:'Renderer-only caption'}]});
 await f.tick();assert.equal(f.text()[1],'Hello world');assert.equal(f.requests.filter(x=>x.type==='TRANSLATE').length,1);
});
test('用户改变原生CC开关后，停用隐藏字幕，撤销授权恢复用户原生选择',async()=>{
 const f=fixture();await f.tick();f.track.mode='disabled';await f.tick();await f.message({type:'SETTINGS',settings:{enabled:false,bilingual:true}});assert.equal(f.track.mode,'hidden');
 f.deny();await f.message({type:'RECHECK_SITE'});assert.equal(f.track.mode,'disabled');
});

test('Dailymotion仅DOM软字幕可翻译，字幕关闭时清空旧中文',async()=>{
 const f=fixture({noTrack:true,captionSelector:'.subtitles_placeholder'});f.segment.textContent='Israel political crisis deepens.';
 await f.tick();assert.equal(f.text()[0],'中文 Israel political crisis deepens');
 f.segment.textContent='';await f.tick();assert.equal(f.text()[0],'');assert.equal(f.text()[1],'');
});

test('初次授权校验拒绝时直接卸载脚本，不在未允许路径留下浮层或翻译任务',async()=>{
 const f=fixture({allowed:false});await flush();await f.tick();assert.equal(f.live,false);assert.equal(f.overlay(),undefined);assert.equal(f.requests.some(m=>m.type==='TRANSLATE'),false);
});


test('通用网页晚到初始化不能覆盖最新字幕开关，停用期间新增字幕也不可见',async()=>{
 let finish;const f=fixture({getSettings:()=>new Promise(r=>finish=r)});
 await f.message({type:'SETTINGS',settings:{enabled:false}});finish({ok:true,enabled:true});await f.tick();
 assert.equal(f.overlay(),undefined);assert.equal(f.native.style.getPropertyValue('visibility'),'hidden');assert.equal(f.track.mode,'hidden');
 await f.message({type:'SETTINGS',settings:{enabled:true,semanticSubtitles:false}});assert.ok(f.text()[0]);
 await f.message({type:'SETTINGS',settings:{enabled:false}});const added={kind:'captions',mode:'showing'};f.video.textTracks.push(added);await f.tick();assert.equal(added.mode,'hidden');
});


test('通用网页两种模式的低延迟音频立即送译，停用后迟到结果不恢复字幕',async()=>{
 for(const semantic of [true,false]){
  let finish;const f=fixture({semantic,translate:m=>new Promise(r=>finish=()=>r({ok:true,items:m.items.map(c=>({id:c.id,text:'中文结果'}))})),segmentTranslate:m=>new Promise(r=>finish=()=>r({ok:true,segments:m.items.map(c=>({sourceIds:[c.id],text:'中文结果'}))}))});await f.tick();finish();await flush();
  const page={videoId:f.requests.findLast(m=>m.type==='PAGE_STATE').videoId,pageGeneration:f.requests.findLast(m=>m.type==='PAGE_STATE').generation,generation:'fast-audio'};
  await f.message({type:'AUDIO_STATE',...page,running:true,lowLatency:true});const before=f.requests.filter(m=>m.type.startsWith('TRANSLATE')).length;
  await f.message({type:'AUDIO_RESULT',...page,text:'Unfinished audio',start:0,end:2,deferred:true,lowLatency:true});assert.equal(f.requests.filter(m=>m.type.startsWith('TRANSLATE')).length,before+1);
  await f.message({type:'SETTINGS',settings:{enabled:false,semanticSubtitles:semantic}});finish();await flush();assert.equal(f.text()[0],'');assert.equal(f.overlay().style.display,'none');
 }
});
