import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(options={}){
 const html=fs.readFileSync(path.resolve(import.meta.dirname,'../../web/index.html'),'utf8'),nodes=Object.fromEntries([...html.matchAll(/id="([\w-]+)"/g)].map(([,id])=>[id,{id,value:'',textContent:'',style:{},checked:true,disabled:false,listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}}]));
 const validToken='a'.repeat(64),timers=new Map(),posted=[],requests=[],listeners=new Map();let timerId=0;
 const status={config:{provider:'codex',audioProvider:'local'},provider:'codex',configured:true,localAsr:{available:true,state:'idle'},codex:{authMode:'ChatGPT',loggedIn:true},counts:{cachedLines:0,cacheHits:0,pending:0,requestsLastHour:0,audioSecondsLastHour:0}};
 const sandbox={URLSearchParams,crypto:{randomUUID:()=> '12345678-1234-1234-1234-123456789012'},location:{origin:'http://127.0.0.1:17865',hash:'#token='+validToken,pathname:'/'},history:{replaceState(){}},sessionStorage:{getItem(){return '';},setItem(){}},document:{getElementById:id=>nodes[id]},navigator:{clipboard:{writeText:async()=>{}}},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),fetch:async(route,init)=>{requests.push({route,init});return {ok:options.valid!==false,json:async()=>options.valid===false?{error:'本机配对码无效'}:status};}};
 sandbox.window=sandbox;sandbox.addEventListener=(type,fn)=>{const list=listeners.get(type)||[];list.push(fn);listeners.set(type,list);};sandbox.removeEventListener=(type,fn)=>listeners.set(type,(listeners.get(type)||[]).filter(item=>item!==fn));sandbox.postMessage=(data,origin)=>posted.push({data,origin});
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.resolve(import.meta.dirname,'../../web/app.js'),'utf8'),sandbox);
 const deliver=(overrides={})=>{const request=posted.at(-1)?.data;sandbox.__data={source:'ytz-local-pair-result-v1',requestId:request?.requestId,ok:true,paired:true,verified:true,version:'0.2.2',...overrides};sandbox.__listeners=listeners.get('message')||[];vm.runInContext('__listeners.forEach(fn=>fn({source:window,origin:location.origin,data:__data}))',sandbox);};
 return {nodes,posted,requests,deliver,timeout(){[...timers.values()].forEach(fn=>fn());},async ready(){await flush();},click(){return nodes['pair-extension'].listeners.click();}};
}
test('一键配对先验证服务，再等待对应请求的插件确认',async()=>{
 const f=harness();await f.ready();const result=f.click();await flush();assert.equal(f.posted.length,1);assert.equal(f.requests.at(-1).route,'/status');assert.equal(f.nodes['pair-extension'].disabled,true);
 f.deliver({requestId:'wrong-request'});await flush();assert.equal(f.nodes['pair-extension'].disabled,true);
 f.deliver();await result;assert.match(f.nodes['extension-state'].textContent,/0\.2\.2.*配对已验证/);assert.equal(f.nodes['pair-extension'].disabled,false);
});
test('失效配对码不发送给插件，也不报告已配对',async()=>{
 const f=harness({valid:false});await f.ready();await f.click();assert.equal(f.posted.length,0);assert.match(f.nodes.notice.textContent,/配对码无效/);assert.doesNotMatch(f.nodes['extension-state'].textContent,/已验证/);
});
test('旧插件没有配对桥接时明确要求重新加载，不虚报成功',async()=>{
 const f=harness();await f.ready();const result=f.click();await flush();f.timeout();await result;assert.match(f.nodes['extension-state'].textContent,/重新加载译幕插件/);assert.equal(f.nodes['pair-extension'].disabled,false);assert.doesNotMatch(f.nodes['extension-state'].textContent,/配对已验证/);
});

