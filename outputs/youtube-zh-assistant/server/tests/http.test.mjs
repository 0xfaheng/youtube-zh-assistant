import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.mjs';
import { DEFAULTS, AppError } from '../core.mjs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
async function fixture(options = {}){
  const port=await new Promise(resolve=>{const temp=net.createServer();temp.listen(0,'127.0.0.1',()=>{const p=temp.address().port;temp.close(()=>resolve(p));});});
  const storage={token:'a'.repeat(64),config:{...DEFAULTS,...options.config},key:options.noKey ? '' : 'dummy',keySource:'memory',async save(input){this.config={...this.config,...input};}};
  let calls=0;
  const providers={lastActual:null,async codex(items){calls++;if(options.translationWait)await options.translationWait;if(options.translationFailure)throw options.translationFailure;await new Promise(r=>setTimeout(r,30));return items.map(x=>({id:x.id,text:'你好'}));},async transcribe(){return 'Hello';}};
  const app=createApp({storage,providers,localAsr:options.localAsr,getLogin:async()=>({loggedIn:true,authMode:'ChatGPT'}),allowedPort:port,webDir:path.resolve(import.meta.dirname,'../../web')});
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  return {app,storage,calls:()=>calls,url:`http://127.0.0.1:${port}`,headers:{Authorization:`Bearer ${storage.token}`,'Content-Type':'application/json'}};
}
test('HTTP 拒绝未配对、恶意 Origin 和 Host，状态不回传密钥',async t=>{
  const f=await fixture();t.after(()=>f.app.server.close());
  assert.equal((await fetch(f.url+'/status')).status,401);
  assert.equal((await fetch(f.url+'/status',{headers:{...f.headers,Origin:'https://www.youtube.com'}})).status,403);
  const hostileHost=await new Promise((resolve,reject)=>{const req=http.get(f.url+'/status',{headers:{...f.headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(hostileHost,403);
  const response=await fetch(f.url+'/status',{headers:f.headers});assert.equal(response.status,200);const data=await response.json();assert.equal(data.hasApiKey,true);assert.equal(JSON.stringify(data).includes('dummy'),false);assert.equal(data.token,undefined);
});
test('轻量配对校验必须提供有效码，且不调用模型或加载本地模型',async t=>{
  let inspected=0;const f=await fixture({localAsr:{async inspect(){inspected++;return {};}}});t.after(()=>f.app.server.close());
  assert.equal((await fetch(f.url+'/pairing')).status,401);
  const response=await fetch(f.url+'/pairing',{headers:f.headers});assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.service,'youtube-zh-assistant');assert.equal(data.token,undefined);assert.equal(inspected,0);assert.equal(f.calls(),0);
});

function audioInput(){
  const wav=Buffer.alloc(44+16000*2*7);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  return {mime:'audio/wav',audioBase64:wav.toString('base64'),context:'A video'};
}

test('本地识别无需 API 密钥，并将本地原文交给选定翻译服务',async t=>{
  let recognized=0;
  const localAsr={async inspect(){return {available:true,ready:true,model:'Qwen3-ASR-1.7B',state:'ready'};},async transcribe(audio,language){recognized++;assert.equal(audio.seconds,7);assert.equal(language,'English');return {text:'Hello',language:'English',model:'Qwen3-ASR-1.7B',inferenceMs:800};}};
  const f=await fixture({noKey:true,config:{audioProvider:'local',localAsrLanguage:'English'},localAsr});t.after(()=>f.app.server.close());
  const health=await (await fetch(f.url+'/health')).json();assert.equal(health.audioConfigured,true);assert.equal(health.audioProvider,'local');
  const response=await fetch(f.url+'/transcribe',{method:'POST',headers:f.headers,body:JSON.stringify(audioInput())});assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.text,'Hello');assert.equal(result.translation,'你好');assert.equal(result.audioProvider,'local');assert.equal(recognized,1);assert.equal(f.calls(),1);
  const state=await (await fetch(f.url+'/status',{headers:f.headers})).json();assert.equal(state.lastAudio.inferenceMs,800);assert.equal(state.hasApiKey,false);
});

test('语音 API 缺密钥或本地不可用时明确失败，不静默切换后端',async t=>{
  const f=await fixture({noKey:true,config:{audioProvider:'api'}});t.after(()=>f.app.server.close());
  let response=await fetch(f.url+'/transcribe',{method:'POST',headers:f.headers,body:JSON.stringify(audioInput())});assert.equal(response.status,503);assert.equal((await response.json()).code,'AUDIO_KEY_MISSING');
  f.storage.config.audioProvider='local';response=await fetch(f.url+'/transcribe',{method:'POST',headers:f.headers,body:JSON.stringify(audioInput())});assert.equal(response.status,503);assert.equal((await response.json()).code,'LOCAL_ASR_UNAVAILABLE');assert.equal(f.calls(),0);
});

test('本地识别成功而翻译超时时准确说明失败阶段，不重复调用模型',async t=>{
  let recognized=0;
  const localAsr={async inspect(){return {available:true,ready:true,state:'ready'};},async transcribe(){recognized++;return {text:'Hello',model:'Qwen3-ASR-1.7B',inferenceMs:800};}};
  const f=await fixture({noKey:true,localAsr,translationFailure:new AppError('模型处理超时',504,'MODEL_TIMEOUT')});t.after(()=>f.app.server.close());
  const response=await fetch(f.url+'/transcribe',{method:'POST',headers:f.headers,body:JSON.stringify(audioInput())});assert.equal(response.status,504);
  const result=await response.json();assert.match(result.error,/本机语音识别已完成.*ChatGPT／Codex翻译失败/);assert.equal(result.code,'MODEL_TIMEOUT');assert.equal(recognized,1);assert.equal(f.calls(),1);
  const state=await (await fetch(f.url+'/status',{headers:f.headers})).json();assert.equal(state.lastAudio.inferenceMs,800);
});

test('模型预热与显存释放必须配对，返回实际状态',async t=>{
  let ready=false,warmups=0,stops=0;
  const localAsr={async inspect(){return {available:true,ready,state:ready?'ready':'stopped',model:'Qwen3-ASR-1.7B'};},async warmup(){warmups++;ready=true;},async stop(){stops++;ready=false;}};
  const f=await fixture({localAsr});t.after(()=>f.app.server.close());
  assert.equal((await fetch(f.url+'/local-asr/warmup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);assert.equal(warmups,0);
  const send=route=>fetch(f.url+route,{method:'POST',headers:f.headers,body:'{}'}).then(r=>r.json());
  assert.equal((await send('/local-asr/warmup')).localAsr.ready,true);assert.equal((await send('/local-asr/stop')).localAsr.ready,false);assert.equal(warmups,1);assert.equal(stops,1);
});
test('并发相同字幕去重，后续从缓存读取，不调用模型',async t=>{
  const f=await fixture();t.after(()=>f.app.server.close());const input={items:[{id:'a',text:'Hello'}]};
  const request=()=>fetch(f.url+'/translate',{method:'POST',headers:f.headers,body:JSON.stringify(input)}).then(r=>r.json());
  const results=await Promise.all([request(),request()]);assert.deepEqual(results[0].items,[{id:'a',text:'你好'}]);assert.equal(f.calls(),1);
  const cached=await request();assert.equal(cached.cached,1);assert.equal(f.calls(),1);
});
test('静态页面带 CSP，不暴露运行目录或密钥文件',async t=>{
  const f=await fixture();t.after(()=>f.app.server.close());const page=await fetch(f.url+'/');assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await fetch(f.url+'/../api-key.dpapi',{headers:f.headers})).status,404);
  const bad=await fetch(f.url+'/translate',{method:'POST',headers:f.headers,body:'not json'});assert.equal(bad.status,400);
});

test('MV3进度传输在模型完成前返回首字节，最终JSON及错误语义保持完整',async t=>{
  let release;const translationWait=new Promise(r=>release=r),f=await fixture({translationWait});t.after(()=>f.app.server.close());
  const response=await fetch(f.url+'/translate',{method:'POST',headers:{...f.headers,'X-YTZ-Progress':'1'},body:JSON.stringify({items:[{id:'first',text:'Hello'}]})});
  const reader=response.body.getReader(),first=await reader.read();assert.equal(new TextDecoder().decode(first.value),'\n');assert.equal(first.done,false);
  release();let body='\n';while(true){const chunk=await reader.read();if(chunk.done)break;body+=new TextDecoder().decode(chunk.value);}assert.deepEqual(JSON.parse(body).items,[{id:'first',text:'你好'}]);assert.equal(f.calls(),1);
  const denied=await fetch(f.url+'/translate',{method:'POST',headers:{'Content-Type':'application/json','X-YTZ-Progress':'1'},body:'{}'});assert.equal(denied.status,401);
  const invalid=await fetch(f.url+'/translate',{method:'POST',headers:{...f.headers,'X-YTZ-Progress':'1'},body:'{}'});assert.equal(invalid.status,400);
  const fail=await fixture({translationFailure:new AppError('模型限流',429,'RATE_LIMIT')});t.after(()=>fail.app.server.close());
  const result=await (await fetch(fail.url+'/translate',{method:'POST',headers:{...fail.headers,'X-YTZ-Progress':'1'},body:JSON.stringify({items:[{id:'a',text:'Hello'}]})})).json();assert.equal(result.ok,false);assert.equal(result.status,429);assert.equal(result.code,'RATE_LIMIT');assert.equal(fail.calls(),1);
});
