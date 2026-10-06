const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sandbox = {URL}; vm.createContext(sandbox); vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../core.js'),'utf8'),sandbox);
const core = sandbox.YTZCore;
test('显示去除停顿标点，同时保留数字符号、时间与专有名称',()=>{
 assert.equal(core.subtitleText('增长50%，达到3:30。'),'增长50% 达到3:30');
 assert.equal(core.subtitleText('-5°C C# AT&T 24/7 COVID-19 a_b @name 50％'),'-5°C C# AT&T 24/7 COVID-19 a_b @name 50％');
});
test('字幕轨插入或删除前面的cue不会改变已有id，重复和同时间不同正文仍唯一',()=>{
 const a={startTime:10,endTime:12,text:'Ten'},b={startTime:20,endTime:22,text:'Twenty'},parse=cues=>core.parseTextTrack({kind:'subtitles',cues});
 const before=parse([a,b]),after=parse([{startTime:5,endTime:7,text:'Five'},a,b]);
 assert.equal(before[0].id,after[1].id);assert.equal(before[1].id,after[2].id);assert.equal(parse([b])[0].id,before[1].id);
 const same=parse([a,{...a},{...a,text:'Different'}]);assert.equal(new Set(same.map(c=>c.id)).size,3);assert.ok(same.every(c=>c.id.length<=160));
});
test('网页原生字幕只取有效文本轨，丢弃标签及无效时间',()=>{
  const cues=core.parseTextTrack({kind:'subtitles',cues:[{startTime:1,endTime:3,text:'<c.green>Hello</c> world'},{startTime:3,endTime:2,text:'invalid'},{startTime:5,endTime:6,text:'Next'}]});
  assert.equal(cues.length,2);assert.equal(cues[0].text,'Hello world');assert.equal(core.cueAt(cues,1).text,'Hello world');assert.equal(core.parseTextTrack({kind:'metadata',cues:[{startTime:1,endTime:3,text:'private'}]}).length,0);
});

test('Dailymotion与Khan授权包含已确认播放器路径，不扩到其他路径或伪装域名',()=>{
 assert.deepEqual(Array.from(core.sitePatterns('https://www.dailymotion.com/video/x3497ff')),['https://www.dailymotion.com/*','https://geo.dailymotion.com/player/*']);
 const khan=Array.from(core.sitePatterns('https://www.khanacademy.org/video/test'));
 assert.ok(khan.includes('https://www.youtube-nocookie.com/embed/*'));
 assert.equal(core.siteMatches('https://www.youtube-nocookie.com/embed/Uiqro5TUyLA/',khan),true);
 assert.equal(core.siteMatches('https://www.youtube-nocookie.com/watch?v=Uiqro5TUyLA',khan),false);
 assert.equal(core.siteMatches('https://www.youtube-nocookie.com.evil.example/embed/Uiqro5TUyLA/',khan),false);
});

test('WebVTT读取使用浏览器渲染的纯文本，保留实体字符且不把标签发送给翻译',()=>{
 const cues=core.parseTextTrack({kind:'subtitles',cues:[{startTime:0,endTime:5,text:'<c.green>Research &amp; development</c>',getCueAsHTML:()=>({textContent:'Research & development'})},{startTime:5,endTime:10,text:'&lt;example&gt; &amp; test'}]});
 assert.equal(cues[0].text,'Research & development');assert.equal(cues[1].text,'<example> & test');
});
test('位置与字号限制范围，网站权限只生成具体HTTPS来源及已知播放器',()=>{
  const settings=core.appearance({subtitlePosition:'top',subtitleOffset:NaN,fontSize:100,backgroundOpacity:-2});assert.equal(settings.subtitleOffset,14);assert.equal(settings.fontSize,48);assert.equal(settings.backgroundOpacity,0);
  assert.equal(core.appearance({subtitleColor:'#FFAA00'}).subtitleColor,'#ffaa00');assert.equal(core.appearance({subtitleColor:'red;display:none',originalColor:null}).subtitleColor,'#ffffff');assert.equal(core.appearance({originalColor:'#aabbcc'}).originalColor,'#aabbcc');assert.equal(core.appearance().originalColor,'#dedede');
  assert.equal(core.siteOrigin('chrome://extensions'),null);assert.equal(core.siteOrigin('https://secret@example.com/video'),null);assert.equal(core.siteOrigin('http://example.com'),null);
  assert.deepEqual(Array.from(core.sitePatterns('https://vimeo.com/123')),['https://vimeo.com/*','https://player.vimeo.com/*']);assert.equal(core.pageKey('https://example.com/v?one=1#hash'),'web:https://example.com/v?one=1');
});
test('JSON3 拼接 segments、合并相同时点与滚动 append，过滤非字幕事件', () => {
  const cues = core.parseJSON3({events:[{tStartMs:1000,dDurationMs:1000,segs:[{utf8:'Hello '},{utf8:'world'}]},{tStartMs:1000,dDurationMs:1500,segs:[{utf8:'again'}]},{tStartMs:2000,dDurationMs:1000,aAppend:1,segs:[{utf8:'continued'}]},{tStartMs:4000,dDurationMs:2000,segs:[{utf8:'Next'}]},{tStartMs:0,wpWinPosId:1}]});
  assert.equal(cues.length,2); assert.equal(cues[0].text,'Hello world again continued'); assert.equal(cues[0].start,1); assert.equal(cues[0].end,3);
});
test('时间查找使用起点包含、终点不包含，字幕间隙返回空', () => {
  const cues=[{start:1,end:3,id:'a'},{start:4,end:5,id:'b'}];
  assert.equal(core.cueAt(cues,0),null); assert.equal(core.cueAt(cues,1).id,'a'); assert.equal(core.cueAt(cues,3),null); assert.equal(core.cueAt(cues,4.2).id,'b'); assert.equal(core.cueAt(cues,5),null);
});

test('原生文字稿保留全部正文与时间，缺失视频首尾或无效数据不冒充完整字幕',()=>{
  const cues=core.parseTranscript([{start:0,text:'First'},{start:10,text:'Middle'},{start:35,text:'Last'}],40);
  assert.equal(cues.length,3);assert.equal(cues[0].end,10);assert.equal(cues[2].end,40);assert.equal(core.cueAt(cues,36).text,'Last');
  assert.equal(core.parseTranscript([{start:30,text:'Partial'}],100).length,0);
  assert.equal(core.parseTranscript([{start:0,text:'Partial'}],100).length,0);
  assert.equal(core.parseTranscript([{start:0,text:''}],10).length,0);
  assert.equal(core.parseTranscript([{start:0,end:2,text:'Exact'},{start:9,end:10,text:'Last'}],10)[0].end,2);
});
test('跳转、换视频后旧响应失效', () => {
  const before={videoId:'abc',generation:1}; assert.equal(core.isCurrent(before,{videoId:'abc',generation:2}),false); assert.equal(core.isCurrent(before,{videoId:'def',generation:1}),false); assert.equal(core.isCurrent(before,{...before}),true);
});
test('预取仅后90秒，排除已译及在途，每批最多20和16000字符', () => {
  const cues=Array.from({length:100},(_,i)=>({id:String(i),start:i,end:i+1,text:'x'.repeat(500)}));
  const items=core.lookAhead(cues,10,new Set(['10']),new Set(['11'])); assert.equal(items.length,20); assert.equal(items[0].id,'12'); assert.ok(items.every(i=>Number(i.id)<=100));
  assert.equal(core.lookAhead(cues.map(c=>({...c,text:'x'})),0,new Set(),new Set()).length,20);
  assert.equal(core.lookAhead(cues.map(c=>({...c,text:'x'.repeat(4000)})),0,new Set(),new Set()).length,4);
});
test('字幕通过 textContent 输出，不解析 HTML', () => {
  const node={textContent:'', set innerHTML(_) {throw new Error('禁止 innerHTML');}};
  core.writeCaption(node,'<img src=x onerror=alert(1)>'); assert.equal(node.textContent,'<img src=x onerror=alert(1)>');
  assert.equal(core.subtitleText('“你好，世界！”……（继续）\n下一句；再见。'),'你好 世界 继续 下一句 再见');
  assert.equal(core.subtitleText("Hello, world! It's 3.14, isn't it?"),"Hello world It's 3.14 isn't it");
  assert.equal(core.subtitleText('，。！？……'),'');assert.equal(core.subtitleText('  第一段   第二段  '),'第一段 第二段');
});
test('字幕轨只允许对应视频的 HTTPS YouTube timedtext', () => {
  const video='dQw4w9WgXcQ';
  assert.ok(core.validateTrack({baseUrl:`https://www.youtube.com/api/timedtext?v=${video}&lang=en`},video));
  for(const url of ['https://evil.example/api/timedtext?v='+video,'http://www.youtube.com/api/timedtext?v='+video,'https://www.youtube.com/watch?v='+video,'https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa','https://user@www.youtube.com/api/timedtext?v='+video]) assert.equal(core.validateTrack({baseUrl:url},video),null);
});
test('原生字幕保留播放器实际选择的 tlang 及 proof/client 参数',()=>{
  const track=core.validateTrack({baseUrl:'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&tlang=zh-Hans&pot=proof&c=WEB',native:true},'dQw4w9WgXcQ');
  const url=new URL(track.baseUrl);assert.equal(url.searchParams.get('tlang'),'zh-Hans');assert.equal(url.searchParams.get('pot'),'proof');assert.equal(url.searchParams.get('c'),'WEB');
});
