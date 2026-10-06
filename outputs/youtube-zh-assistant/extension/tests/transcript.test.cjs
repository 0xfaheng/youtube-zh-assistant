const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function fixture(){
  let listener,now=0,id=0;const timers=new Map(),messages=[];
  const panel={data:{content:{sectionListRenderer:{contents:[{transcriptSegmentViewModel:{timestamp:'0:00',simpleText:'Opening'}},{transcriptSegmentViewModel:{timestamp:'0:35',simpleText:'Ending'}}]}}}};
  let panels=[], clicks=0,expands=0;
  const sandbox={URL,WeakSet,Set,Date:{now:()=>now},location:{href:'https://www.youtube.com/watch?v=abcdefghijk',origin:'https://www.youtube.com'},document:{querySelector:s=>s==='ytd-watch-flexy'?{getAttribute:()=> 'abcdefghijk'}:s==='video'?{duration:40}:s==='ytd-video-description-transcript-section-renderer'?{querySelector:()=>({click:()=>clicks++,disabled:false})}:s==='ytd-watch-metadata #expand'?{click:()=>expands++}:null,querySelectorAll:()=>panels},setTimeout:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id),postMessage:data=>messages.push(data),addEventListener:(type,fn)=>{if(type==='message')listener=fn;}};
  sandbox.window=sandbox;vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../transcript.js'),'utf8'),sandbox);
  return {panel,messages,sandbox,show(){panels=[panel];},get clicks(){return clicks;},request(data={},external=false){sandbox.__data={source:'ytz-transcript-request-v1',videoId:'abcdefghijk',generation:1,...data};sandbox.__external=external;sandbox.__listener=listener;vm.runInContext('__listener({source:__external?{}:window,origin:location.origin,data:__data})',sandbox);},advance(ms){now+=ms;for(const [i,t]of[...timers])if(t.at<=now){timers.delete(i);t.fn();}}};
}
test('读取原生完整文字稿数据，移除跟踪字段且不复制API认证',()=>{
  const f=fixture();f.show();f.panel.data.content.trackingParams='not-published';f.request();
  assert.equal(f.clicks,0);assert.equal(f.messages.length,1);assert.equal(f.messages[0].segments.length,2);assert.equal(f.messages[0].languageCode,'und');assert.equal(f.messages[0].precision,'seconds');assert.equal(JSON.stringify(f.messages).includes('not-published'),false);
});
test('页面只打开一次原生文字稿，超时停止；取消及换视频禁止发布旧结果',()=>{
  const f=fixture();f.request();assert.equal(f.clicks,1);f.advance(500);assert.equal(f.clicks,1);f.show();f.advance(500);assert.equal(f.messages.length,1);f.request();assert.equal(f.clicks,1);
  const canceled=fixture();canceled.request();canceled.request({source:'ytz-transcript-cancel-v1'});canceled.show();canceled.advance(1000);assert.equal(canceled.messages.length,0);
  const changed=fixture();changed.request();changed.sandbox.location.href='https://www.youtube.com/watch?v=lmnopqrstuv';changed.show();changed.advance(1000);assert.equal(changed.messages.length,0);
  const expired=fixture();expired.request();expired.advance(20000);expired.show();expired.advance(1000);assert.equal(expired.messages.length,0);
});
test('等待文字稿时跳转更新代次，不重复打开面板，成功数据在同一视频可重播',()=>{
  const f=fixture();f.request();f.request({generation:2});f.show();f.advance(500);assert.equal(f.clicks,1);assert.equal(f.messages[0].generation,2);
  f.request({generation:3});assert.equal(f.messages.at(-1).generation,3);assert.equal(f.messages.length,2);assert.equal(f.clicks,1);
});
test('拒绝外部来源、其他视频、未加载后续分页和缺尾文字稿',()=>{
  const f=fixture();f.show();f.request({},true);f.request({videoId:'lmnopqrstuv'});assert.equal(f.messages.length,0);
  f.panel.data.content.continuationItemRenderer={};f.request();assert.equal(f.messages.length,0);
  const incomplete=fixture();incomplete.show();incomplete.panel.data.content.sectionListRenderer.contents.pop();incomplete.request();assert.equal(incomplete.messages.length,0);
});
