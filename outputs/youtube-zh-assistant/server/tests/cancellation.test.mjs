import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {createApp} from '../app.mjs';
import {DEFAULTS} from '../core.mjs';
const until=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,5));}assert.fail('请求状态未达到预期');};
async function fixture(t){
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const storage={token:'a'.repeat(64),config:{...DEFAULTS},key:''},calls=[];
 let release;const first=new Promise(r=>release=r);
 const run=async items=>{calls.push(items[0].id);if(calls.length===1)await first;};
 const providers={async codex(items){await run(items);return items.map(c=>({id:c.id,text:'译文'}));},async codexSegments(items){await run(items);return items.map(c=>({sourceIds:[c.id],text:'译文'}));}};
 const app=createApp({storage,providers,getLogin:async()=>({loggedIn:true}),allowedPort:port,webDir:''});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(()=>{release();app.server.closeAllConnections();app.server.close();});
 const request=(route,id,signal)=>fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{Authorization:'Bearer '+storage.token,'Content-Type':'application/json','X-YTZ-Progress':'1'},body:JSON.stringify({items:[{id,text:id,start:0,end:1}]}),signal});
 return {app,calls,release,request};
}
for(const route of ['/translate','/translate-segments']){
 test(route+'：客户端离开后跳过未开始的任务，不扣模型额度',async t=>{
  const f=await fixture(t),a=await f.request(route,'a');await until(()=>f.calls.length===1);
  let closed=false;f.app.server.once('request',(req,res)=>res.once('close',()=>closed=true));
  const controller=new AbortController(),b=await f.request(route,'b',controller.signal);
  assert.equal((await f.app.status()).counts.pending,2);controller.abort();await until(()=>closed);
  await assert.rejects(b.json());f.release();await a.json();await until(()=>f.app.limits.summary().requestsLastHour===1&&f.calls.length===1&&f.app.cache.data.size+f.app.semanticCache.data.size>0);
  await until(async()=>(await f.app.status()).counts.pending===0);
  assert.deepEqual(f.calls,['a']);assert.equal((await f.app.status()).counts.pending,0);assert.equal(f.app.limits.summary().requestsLastHour,1);
 });
}
test('共享排队任务有另一个客户端仍等待时，单个断开不会误取消',async t=>{
 const f=await fixture(t),a=await f.request('/translate-segments','a');await until(()=>f.calls.length===1);
 let closed=false;f.app.server.once('request',(req,res)=>res.once('close',()=>closed=true));
 const controller=new AbortController(),b=await f.request('/translate-segments','b',controller.signal),same=await f.request('/translate-segments','b');
 assert.equal((await f.app.status()).counts.pending,2);controller.abort();await until(()=>closed);await assert.rejects(b.json());
 f.release();await a.json();assert.equal((await same.json()).segments[0].text,'译文');assert.deepEqual(f.calls,['a','b']);assert.equal(f.app.limits.summary().requestsLastHour,2);
});
