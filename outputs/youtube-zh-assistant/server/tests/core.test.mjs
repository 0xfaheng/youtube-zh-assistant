import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTranslation, parseTranslation, validateConfig, DEFAULTS, SerialQueue, UsageLimits, MemoryCache, decodeAudio, cacheKey } from '../core.mjs';

test('翻译输入拒绝重复 id、超量与无效上下文', () => {
  assert.deepEqual(validateTranslation({ items: [{id:'a',text:' hi '}] }), {items:[{id:'a',text:'hi'}],context:''});
  for (const items of [[], [{id:'a',text:'x'},{id:'a',text:'y'}], Array.from({length:41},(_,i)=>({id:String(i),text:'x'})), [{id:'x',text:' '}]]) assert.throws(()=>validateTranslation({items}));
  assert.throws(()=>validateTranslation({items:[{id:'x',text:'a'}],context:{}}));
});
test('模型返回必须完整且可按原请求顺序重排', () => {
  const requested=[{id:'a',text:'Hello'},{id:'b',text:'world'}];
  assert.deepEqual(parseTranslation({items:[{id:'b',text:'世界'},{id:'a',text:'你好'}]},requested),[{id:'a',text:'你好'},{id:'b',text:'世界'}]);
  for (const output of [{items:[{id:'a',text:'a'}]},{items:[{id:'a',text:'a'},{id:'a',text:'b'}]},{items:[{id:'a',text:'a'},{id:'z',text:'b'}]},'not JSON']) assert.throws(()=>parseTranslation(output,requested));
});
test('设置拒绝带凭证 URL、外部明文 HTTP 与命令注入模型名', () => {
  assert.equal(validateConfig({apiBaseUrl:'http://127.0.0.1:8000/v1/'}).apiBaseUrl,'http://127.0.0.1:8000/v1');
  for(const input of [{apiBaseUrl:'http://example.com/v1'},{apiBaseUrl:'https://name:pass@example.com/v1'},{apiBaseUrl:'https://example.com/v1?key=x'},{provider:'anything'},{codexModel:'x; rm -rf /'},{maxRequestsPerHour:0}]) assert.throws(()=>validateConfig(input));
});
test('串行队列限制积压，并在失败后继续处理后续任务', async()=>{
  const queue = new SerialQueue(2); let release; const order=[];
  const first=queue.run(async()=>{order.push(1); await new Promise(r=>release=r); throw new Error('expected');});
  const second=queue.run(async()=>{order.push(2); return 2;});
  const failed=assert.rejects(first); await assert.rejects(queue.run(()=>3));
  await new Promise(r=>setImmediate(r)); release(); await failed;
  assert.equal(await second,2); assert.deepEqual(order,[1,2]); assert.equal(queue.waiting,0);
});
test('滚动一小时额度会恢复，语音也受限',()=>{
  let now=10000000; const usage=new UsageLimits(()=>now), config={...DEFAULTS,maxRequestsPerHour:2,maxAudioSecondsPerHour:10};
  usage.reserve(config,7); assert.throws(()=>usage.reserve(config,7)); usage.reserve(config); assert.throws(()=>usage.reserve(config)); now+=3600001; usage.reserve(config,7); assert.equal(usage.summary().requestsLastHour,1);
});
test('缓存按服务、模型和语境隔离，并限制容量',()=>{
  const cache=new MemoryCache(2); cache.set('a','A');cache.set('b','B');cache.get('a');cache.set('c','C');assert.equal(cache.get('b'),undefined);
  assert.notEqual(cacheKey(DEFAULTS,'hi','a'),cacheKey(DEFAULTS,'hi','b'));
  assert.notEqual(cacheKey(DEFAULTS,'hi'),cacheKey({...DEFAULTS,codexModel:'gpt-6.1-sol'},'hi'));
});
function wav(seconds=7){const buf=Buffer.alloc(44+16000*2*seconds);buf.write('RIFF');buf.writeUInt32LE(buf.length-8,4);buf.write('WAVEfmt ',8);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(1,22);buf.writeUInt32LE(16000,24);buf.writeUInt32LE(32000,28);buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);buf.write('data',36);buf.writeUInt32LE(buf.length-44,40);return buf;}
test('WAV 解析验证独立分片、时长和格式',()=>{
  const audio=decodeAudio({mime:'audio/wav',audioBase64:wav().toString('base64')});assert.equal(audio.seconds,7);
  assert.throws(()=>decodeAudio({mime:'audio/wav',audioBase64:wav(21).toString('base64')}));
  const invalid=wav();invalid.writeUInt32LE(1,28);assert.throws(()=>decodeAudio({mime:'audio/wav',audioBase64:invalid.toString('base64')}));
  assert.throws(()=>decodeAudio({mime:'audio/webm',audioBase64:wav().toString('base64')}));
});
