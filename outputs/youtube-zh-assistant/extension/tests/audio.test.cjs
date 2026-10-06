const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const sandbox={chrome:{runtime:{onMessage:{addListener(){}}}}, btoa:text=>Buffer.from(text,'binary').toString('base64')};
vm.createContext(sandbox); vm.runInContext(fs.readFileSync(path.join(__dirname,'../offscreen.js'),'utf8'),sandbox);
test('2 秒独立 WAV 是 16kHz 单声道 PCM16，RIFF/data 长度正确', () => {
  const samples=Float32Array.from({length:48000*2},(_,i)=>Math.sin(i/20)*.5);
  const bytes=Buffer.from(sandbox.wavBase64(samples,48000),'base64');
  assert.equal(bytes.toString('ascii',0,4),'RIFF'); assert.equal(bytes.toString('ascii',8,12),'WAVE');
  assert.equal(bytes.readUInt32LE(4),bytes.length-8); assert.equal(bytes.readUInt16LE(22),1);
  assert.equal(bytes.readUInt32LE(24),16000); assert.equal(bytes.readUInt16LE(34),16);
  assert.equal(bytes.readUInt32LE(40),16000*2*2); assert.equal(bytes.length,44+16000*2*2);
});
test('PCM16 量化限制峰值，短分片仍包含完整有效头', () => {
  const bytes=Buffer.from(sandbox.wavBase64(new Float32Array([-2,2,0]),16000),'base64');
  assert.equal(bytes.readInt16LE(44),-32768); assert.equal(bytes.readInt16LE(46),32767); assert.equal(bytes.readInt16LE(48),0);
});
function audioHarness(config = {}) {
  let listener;
  const messages=[],streams=[],contexts=[],collectors=[],sources=[];
  const node = () => ({connections:[],disconnected:false,connect(target){this.connections.push(target);},disconnect(){this.disconnected=true;}});
  class AudioContext {
    constructor(){this.state='running';this.destination={};this.audioWorklet={addModule:async()=>{if(config.setupError)throw new Error('worklet failed');}};contexts.push(this);}
    createMediaStreamSource(){const source=node();sources.push(source);return source;}
    createGain(){return {...node(),gain:{value:1}};}
    async resume(){this.state='running';}
    async close(){this.state='closed';if(config.closeError)throw new Error('context close failed');}
  }
  class AudioWorkletNode {
    constructor(){Object.assign(this,node());this.port={onmessage:null};collectors.push(this);}
  }
  const runtime={id:'testextension',getURL:name=>'chrome-extension://testextension/'+name,onMessage:{addListener:callback=>{listener=callback;}},sendMessage:async message=>{
    messages.push(message);
    return message.type==='AUDIO_CHUNK' && config.requestImpl ? config.requestImpl(message) : {ok:true};
  }};
  const state={AudioContext,AudioWorkletNode,chrome:{runtime},navigator:{mediaDevices:{getUserMedia:async()=>{
    const track={stopped:false,stop(){this.stopped=true;},addEventListener(type,callback){this[type]=callback;}};
    const stream={getTracks:()=>[track],track};streams.push(stream);return stream;
  }}},btoa:text=>Buffer.from(text,'binary').toString('base64')};
  vm.createContext(state);vm.runInContext(fs.readFileSync(path.join(__dirname,'../offscreen.js'),'utf8'),state);
  const call=(message,sender={id:'testextension',url:'chrome-extension://testextension/background.js'})=>new Promise(resolve=>{if(!listener({...message,target:'offscreen'},sender,resolve))resolve({ignored:true});});
  const chunk=()=>({data:{samples:new Float32Array([.2,.1,-.1,-.2]),rate:16000}});
  return {call,chunk,messages,streams,contexts,collectors,sources,state};
}
test('音频繁忙跳过片段可见，保持回放；STOP释放tracks/context并归零计数',async()=>{
  let resolve;
  const h=audioHarness({requestImpl:()=>new Promise(done=>{resolve=done;})});assert.equal((await h.call({type:'START',generation:'g1',streamId:'stream'})).ok,true);
  assert.ok(h.sources[0].connections.includes(h.contexts[0].destination));
  const receive=h.collectors[0].port.onmessage;const first=receive(h.chunk());await receive(h.chunk());
  const dropped=h.messages.find(m=>m.type==='AUDIO_PROGRESS');assert.equal(dropped.generation,'g1');assert.equal(dropped.droppedChunks,1);assert.equal(dropped.processedChunks,0);
  resolve({ok:true});await first;const completed=h.messages.filter(m=>m.type==='AUDIO_PROGRESS').at(-1);assert.equal(completed.processedChunks,1);assert.equal(completed.droppedChunks,1);
  assert.equal(h.messages.filter(m=>m.type==='AUDIO_CHUNK').length,1);
  const sent=h.messages.find(m=>m.type==='AUDIO_CHUNK');assert.equal(sent.durationSeconds,4/16000);assert.ok(Number.isFinite(sent.capturedAt));
  assert.equal((await h.call({type:'STOP'})).ok,true);assert.equal(h.streams[0].track.stopped,true);assert.equal(h.contexts[0].state,'closed');assert.equal(h.sources[0].disconnected,true);assert.equal(h.collectors[0].disconnected,true);
  assert.equal(vm.runInContext('droppedChunks + processedChunks',h.state),0);
});

function collectorHarness(){
 let Collector;const packets=[];
 const s={sampleRate:16000,AudioWorkletProcessor:class{constructor(){this.port={postMessage:p=>packets.push({samples:Float32Array.from(p.samples),rate:p.rate})};}},registerProcessor:(_name,c)=>Collector=c};
 vm.createContext(s);vm.runInContext(fs.readFileSync(path.join(__dirname,'../audio-processor.js'),'utf8'),s);const c=new Collector();
 const feed=(seconds,value)=>{for(let n=0;n<Math.round(seconds*16000);n+=128){const samples=new Float32Array(Math.min(128,Math.round(seconds*16000)-n));for(let i=0;i<samples.length;i++)samples[i]=typeof value==='function'?value(n+i):value;c.process([[samples]]);}};
 return {packets,feed,c};
}
test('持续语音每2秒送出一片，跨边界PCM样本完整且顺序不变',()=>{
 const h=collectorHarness();h.feed(4,i=>Math.sin(i/20)*.5);assert.equal(h.packets.length,2);assert.ok(h.packets.every(p=>p.samples.length===32000));
 const seen=Float32Array.from(h.packets.flatMap(p=>Array.from(p.samples)));for(let i=0;i<seen.length;i++)assert.equal(seen[i],Math.fround(Math.sin(i/20)*.5));
});
test('话语停顿约300ms提前提交，纯静音不产生识别请求',()=>{
 const h=collectorHarness();h.feed(5,0);assert.equal(h.packets.length,0);h.feed(.6,.1);h.feed(.35,0);assert.equal(h.packets.length,1);assert.ok(h.packets[0].samples.length/16000<1);assert.ok(h.packets[0].samples.length/16000>=.8);h.feed(5,0);assert.equal(h.packets.length,1);
});
test('短词仍在最小窗口提交，不足2秒的有效WAV时长按实际样本计算',()=>{
 const h=collectorHarness();h.feed(.2,.2);h.feed(.8,0);assert.equal(h.packets.length,1);const p=h.packets[0],wav=Buffer.from(sandbox.wavBase64(p.samples,p.rate),'base64');assert.equal(wav.readUInt32LE(40),p.samples.length*2);assert.ok(p.samples.length/16000>=.8&&p.samples.length/16000<1.1);
});
test('停止后新代次立即识别；旧响应不会关闭新stream或覆盖busy状态',async()=>{
  const resolvers=new Map();const h=audioHarness({requestImpl:message=>new Promise(done=>resolvers.set(message.generation,done))});
  await h.call({type:'START',generation:'old',streamId:'old-stream'});const oldReceive=h.collectors[0].port.onmessage;const old=oldReceive(h.chunk());
  await h.call({type:'STOP'});await h.call({type:'START',generation:'new',streamId:'new-stream'});
  const current=h.collectors[1].port.onmessage(h.chunk());assert.ok(resolvers.has('new'));
  resolvers.get('old')({ok:false,error:'old failed'});await old;assert.equal(h.streams[1].track.stopped,false);
  resolvers.get('new')({ok:true});await current;const progress=h.messages.filter(m=>m.type==='AUDIO_PROGRESS').at(-1);assert.equal(progress.generation,'new');assert.equal(progress.droppedChunks,0);assert.equal(progress.processedChunks,1);
  await h.call({type:'STOP'});
});
test('识别请求错误停止采音、保留错误说明，不自行再发请求',async()=>{
  const h=audioHarness({requestImpl:async()=>({ok:false,error:'503：语音识别失败；未自动重试'})});
  await h.call({type:'START',generation:'g1',streamId:'stream'});await h.collectors[0].port.onmessage(h.chunk());
  assert.equal(h.streams[0].track.stopped,true);assert.equal(h.contexts[0].state,'closed');
  const ended=h.messages.find(m=>m.type==='AUDIO_ENDED');assert.match(ended.reason,/503.*未自动重试.*手动重新开启/);assert.equal(h.messages.filter(m=>m.type==='AUDIO_CHUNK').length,1);
});
test('后台断开以及worklet初始化失败均释放采音资源',async()=>{
  const h=audioHarness({requestImpl:async()=>{throw new Error('channel closed');}});
  await h.call({type:'START',generation:'g1',streamId:'stream'});await h.collectors[0].port.onmessage(h.chunk());assert.equal(h.streams[0].track.stopped,true);assert.equal(h.contexts[0].state,'closed');
  const failed=audioHarness({setupError:true});const result=await failed.call({type:'START',generation:'g2',streamId:'stream'});assert.equal(result.ok,false);assert.match(result.error,/worklet/);assert.equal(failed.streams[0].track.stopped,true);assert.equal(failed.contexts[0].state,'closed');
});
test('STOP清理失败仍回传错误；不允许页面或popup直接启动offscreen',async()=>{
  const h=audioHarness({closeError:true});
  for(const sender of [{id:'testextension',tab:{id:1},url:'https://www.youtube.com/watch?v=abcdefghijk'},{id:'testextension',url:'chrome-extension://testextension/popup.html'},{id:'otherextension'}]) assert.equal((await h.call({type:'START',generation:'g1',streamId:'stream'},sender)).ignored,true);
  assert.equal(h.streams.length,0);await h.call({type:'START',generation:'g1',streamId:'stream'});const result=await h.call({type:'STOP'});assert.equal(result.ok,false);assert.match(result.error,/close failed/);assert.equal(h.streams[0].track.stopped,true);
});
