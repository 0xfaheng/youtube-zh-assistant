const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flush = () => new Promise(resolve=>setImmediate(resolve));
function fixture(fetchImpl) {
  let observer, receive;
  let now=0;
  let nextTimer=0;const timers=new Map();
  const calls=[],messages=[],entries=[];
  const sandbox={URL,AbortSignal,console,Date:{now:()=>now},location:{href:'https://www.youtube.com/watch?v=abcdefghijk',origin:'https://www.youtube.com'},document:{getElementById:()=>null},performance:{getEntriesByType:()=>entries},PerformanceObserver:class {constructor(callback){observer=callback;}observe(){}},fetch:async(url,options)=>{calls.push({url,options});return fetchImpl(url,options);},setInterval(){},addEventListener:(name,callback)=>{if(name==='message')receive=callback;},postMessage:(data,origin)=>messages.push({data,origin})};
  sandbox.setTimeout=(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,at:now+delay});return id;};sandbox.clearTimeout=id=>timers.delete(id);
  sandbox.window=sandbox;vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../bridge.js'),'utf8'),sandbox);
  return {calls,messages,entries,sandbox,advance(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}},resource(url){observer({getEntries:()=>[{name:url}]});},request(){sandbox.__receive=receive;vm.runInContext('__receive({source:window,origin:location.origin,data:{source:"ytz-native-captions-request-v1",videoId:new URL(location.href).searchParams.get("v")}})',sandbox);}};
}
const native='https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&pot=player-proof&c=WEB';
const response=()=>({ok:true,text:async()=>JSON.stringify({events:[{tStartMs:0,segs:[{utf8:'Hello'}]}]})});
test('播放器实际字幕请求保留 proof/client 参数，用当前浏览器读取且重复资源不再请求',async()=>{
  const f=fixture(response);f.resource(native);await flush();f.resource(native);f.resource(f.calls[0].url);await flush();
  assert.equal(f.calls.length,1);const url=new URL(f.calls[0].url);assert.equal(url.searchParams.get('pot'),'player-proof');assert.equal(url.searchParams.get('c'),'WEB');assert.equal(url.searchParams.get('fmt'),'json3');assert.equal(f.calls[0].options.credentials,'include');
  assert.equal(f.messages.length,1);assert.equal(f.messages[0].data.source,'ytz-native-captions-v1');
  f.request();await flush();assert.equal(f.messages.filter(m=>m.data.source==='ytz-native-captions-v1').length,2);assert.equal(f.messages.filter(m=>m.data.source==='ytz-caption-tracks-v1').length,1);assert.equal(f.calls.length,1);
});
test('只读取当前视频 HTTPS YouTube 字幕，旧视频响应不发布',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  for(const url of ['https://evil.example/api/timedtext?v=abcdefghijk','https://www.youtube.com/api/timedtext?v=lmnopqrstuv','http://www.youtube.com/api/timedtext?v=abcdefghijk'])f.resource(url);
  assert.equal(f.calls.length,0);f.resource(native);
  f.sandbox.location.href='https://www.youtube.com/watch?v=lmnopqrstuv';finish(response());await flush();assert.equal(f.messages.length,0);
});
test('空字幕响应不替换 DOM 兜底，也不导致读取循环',async()=>{
  const f=fixture(()=>({ok:true,text:async()=>''}));f.resource(native);await flush();f.resource(native);await flush();
  assert.equal(f.calls.length,1);assert.equal(f.messages.length,0);
});
test('暂时空响应后允许播放器后续请求恢复，重试有冷却且成功后去重',async()=>{
  let attempt=0;const f=fixture(()=>++attempt===1?{ok:true,text:async()=>''}:response());
  f.resource(native);await flush();f.resource(native);await flush();assert.equal(f.calls.length,1);
  f.advance(16000);f.resource(native);await flush();assert.equal(f.calls.length,2);assert.equal(f.messages.length,1);
  f.advance(16000);f.resource(native);await flush();assert.equal(f.calls.length,2);
});
test('没有新的播放器资源事件时，空字幕15秒后自动恢复且不继续轮询',async()=>{
  let attempt=0;const f=fixture(()=>++attempt===1?{ok:true,text:async()=>''}:response());
  f.resource(native);await flush();f.advance(14999);await flush();assert.equal(f.calls.length,1);
  f.advance(1);await flush();assert.equal(f.calls.length,2);assert.equal(f.messages.length,1);
  f.advance(60000);await flush();assert.equal(f.calls.length,2);
});
test('持续空字幕最多两次读取，换视频后不执行旧字幕的定时恢复',async()=>{
  const empty=()=>({ok:true,text:async()=>''});const f=fixture(empty);
  f.resource(native);await flush();f.advance(15000);await flush();f.advance(60000);await flush();assert.equal(f.calls.length,2);
  const other=fixture(empty);other.resource(native);await flush();other.sandbox.location.href='https://www.youtube.com/watch?v=lmnopqrstuv';other.request();other.advance(60000);await flush();assert.equal(other.calls.length,1);
});
