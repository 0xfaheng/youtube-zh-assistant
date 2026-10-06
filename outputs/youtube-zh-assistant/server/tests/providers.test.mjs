import test from 'node:test';
import assert from 'node:assert/strict';
import { Providers } from '../providers.mjs';
import { DEFAULTS } from '../core.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const items=[{id:'a',text:'Hello'}];
test('Responses 请求使用结构化输出与 store:false，按 id 校验结果',async()=>{
  let called;
  const provider=new Providers({fetchImpl:async(url,options)=>{called={url,options};return Response.json({status:'completed',model:'test-model',output:[{type:'message',content:[{type:'output_text',text:'{"items":[{"id":"a","text":"你好"}]}'}]}]});}});
  assert.deepEqual(await provider.api(items,'',DEFAULTS,'dummy-test-key'),[{id:'a',text:'你好'}]);
  const body=JSON.parse(called.options.body);assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.equal(called.options.redirect,'error');assert.equal(called.url,'https://api.openai.com/v1/responses');assert.equal(provider.lastActual.returnedModel,'test-model');
});
test('兼容 Chat Completions 使用 JSON 输出并且不静默改协议',async()=>{
  let body;
  const provider=new Providers({fetchImpl:async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/chat/completions');body=JSON.parse(options.body);return Response.json({choices:[{message:{content:'{"items":[{"id":"a","text":"你好"}]}'}}]});}});
  await provider.api(items,'',{...DEFAULTS,apiMode:'chat-completions'},'dummy');assert.equal(body.response_format.type,'json_object');
});
test('拒绝未完成、限流和不可用密钥，无自动付费重试',async()=>{
  const provider=new Providers({fetchImpl:async()=>Response.json({},{status:429})});
  await assert.rejects(provider.api(items,'',DEFAULTS,'dummy'),e=>e.code==='API_LIMIT');
  await assert.rejects(provider.api(items,'',DEFAULTS,''),e=>e.code==='API_KEY_MISSING');
  const incomplete=new Providers({fetchImpl:async()=>Response.json({status:'incomplete'})});await assert.rejects(incomplete.api(items,'',DEFAULTS,'dummy'),e=>e.code==='API_INCOMPLETE');
});
test('转写 multipart 使用独立 WAV，密钥只在 Authorization',async()=>{
  let called;
  const provider=new Providers({fetchImpl:async(url,options)=>{called={url,options};return Response.json({text:' Hello '});}});
  assert.equal(await provider.transcribe({buffer:Buffer.from('dummy'),mime:'audio/wav',context:'context'},DEFAULTS,'dummy-key'),'Hello');
  assert.equal(called.options.body.get('file').name,'chunk.wav');assert.equal(called.options.body.get('model'),DEFAULTS.audioModel);assert.equal(called.options.headers['Content-Type'],undefined);assert.equal(called.url,'https://api.openai.com/v1/audio/transcriptions');
});

const agent=text=>({type:'item.completed',item:{type:'agent_message',text}});
const done={type:'turn.completed',usage:{input_tokens:10,output_tokens:5,cached_input_tokens:2}};
const encoded=events=>events.map(event=>JSON.stringify(event)+'\n').join('');
async function fakeCodex(t,stdout,{stderr='',code=0,chunks}={}) {
  const runtimeDir=await fs.mkdtemp(path.join(os.tmpdir(),'ytzh-provider-test-'));
  t.after(async()=>{assert.ok(path.resolve(runtimeDir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(runtimeDir,{recursive:true,force:true});});
  const calls=[];let stopped=false;
  const runProcessImpl=async(command,args,options)=>{
    const schema=JSON.parse(await fs.readFile(args[args.indexOf('--output-schema')+1],'utf8'));
    calls.push({command,args,options,schema});let output='';
    for(const chunk of chunks||[stdout]) {output+=chunk;if(options.stopWhen({stdout:output,stderr})){stopped=true;return {stdout:output,stderr,code:1,stoppedAfterCompletion:true};}}
    return {stdout:output,stderr,code,stoppedAfterCompletion:false};
  };
  return {provider:new Providers({runtimeDir,codexBin:'fake-codex',runProcessImpl}),calls,get stopped(){return stopped;}};
}
test('Codex 完整最终文本与turn.completed经JSONL分块读取、schema/id校验后结束等待',async t=>{
  const stdout=encoded([{type:'thread.started'},{type:'turn.started'},agent('{"translations":{"a":"你好，世界"}}'),done]);
  const fake=await fakeCodex(t,stdout,{chunks:[stdout.slice(0,9),stdout.slice(9,55),stdout.slice(55,-3),stdout.slice(-3)]});
  assert.deepEqual(await fake.provider.codex(items,'',DEFAULTS),[{id:'a',text:'你好，世界'}]);assert.equal(fake.stopped,true);assert.equal(fake.calls.length,1);
  const call=fake.calls[0];assert.equal(call.args[call.args.indexOf('-m')+1],DEFAULTS.codexModel);assert.ok(call.args.includes('model_reasoning_effort="high"'));assert.ok(call.args.includes('service_tier="fast"'));assert.ok(call.args.includes('--output-schema'));assert.equal(call.options.timeout,120000);
  assert.equal(fake.provider.lastActual.usage.output_tokens,5);
  assert.deepEqual(call.schema.properties.translations.required,['a']);assert.equal(call.schema.properties.translations.additionalProperties,false);assert.equal(call.schema.properties.translations.properties.a.minLength,1);assert.equal(call.schema.properties.translations.properties.a.pattern,'\\S');assert.equal(fake.provider.lastActual.batchSize,1);
});
test('Codex 仅启动事件、仅最终文本、仅完成事件均不能伪造成功',async t=>{
  for(const events of [[{type:'thread.started'},{type:'turn.started'}],[agent('{"translations":{"a":"你好"}}')],[done]]) {
    const fake=await fakeCodex(t,encoded(events));await assert.rejects(fake.provider.codex(items,'',DEFAULTS),error=>error.code==='CODEX_INCOMPLETE');assert.equal(fake.provider.lastActual,null);assert.equal(fake.stopped,false);assert.equal(fake.calls.length,1);
  }
});
test('Codex 完成前必须拒绝无效JSON、缺失或错误id、空值及额外schema字段',async t=>{
  for(const text of ['not JSON','{"translations":{"wrong":"你好"}}','{"translations":{"a":{"text":"你好","secret":"x"}}}','{"translations":{"a":"你好"},"extra":true}','{"translations":{"a":"你好","b":"额外"}}','{"translations":{"a":""}}','{"translations":{"a":" "}}','{"translations":{}}']) {
    const fake=await fakeCodex(t,encoded([agent(text),done]));await assert.rejects(fake.provider.codex(items,'',DEFAULTS),error=>error.code==='INVALID_MODEL_OUTPUT');assert.equal(fake.provider.lastActual,null);assert.equal(fake.calls.length,1);
  }
});
test('Codex 失败与限流不重复调用，不暴露stderr凭证',async t=>{
  const secret='very-private-password';
  for(const scenario of [{stdout:encoded([{type:'turn.failed',error:{message:`usage limit token=${secret}`}}]),stderr:'',code:0,expected:'CODEX_LIMIT'},{stdout:'',stderr:`rate limit Authorization: Bearer ${secret}`,code:1,expected:'CODEX_LIMIT'},{stdout:'',stderr:`network failed password=${secret} https://user:${secret}@example.test/?token=${secret}`,code:1,expected:'CODEX_FAILED'}]) {
    const fake=await fakeCodex(t,scenario.stdout,scenario);await assert.rejects(fake.provider.codex(items,'',DEFAULTS),error=>{assert.equal(error.code,scenario.expected);assert.equal(JSON.stringify(error).includes(secret),false);assert.equal(error.message.includes(secret),false);return true;});assert.equal(fake.calls.length,1);assert.equal(fake.provider.lastActual,null);
  }
});
test('Codex 正常退出且最后JSONL无换行仍校验完成；usage仅保留计数字段',async t=>{
  const stdout=encoded([agent('{"translations":{"a":"你好"}}')])+JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:2,token:'must-not-expose'}});
  const fake=await fakeCodex(t,stdout);assert.deepEqual(await fake.provider.codex(items,'',DEFAULTS),[{id:'a',text:'你好'}]);assert.equal(fake.provider.lastActual.usage.token,undefined);
});
test('Codex 字幕映射按请求顺序恢复，重复原文也逐条保留，丢失任意键即失败',async t=>{
  const requested=[{id:'first',text:'Hello'},{id:'second',text:'Hello'}];
  const good=await fakeCodex(t,encoded([agent('{"translations":{"second":"你好","first":"你好"}}'),done]));
  assert.deepEqual(await good.provider.codex(requested,'',DEFAULTS),[{id:'first',text:'你好'},{id:'second',text:'你好'}]);
  assert.deepEqual(good.calls[0].schema.properties.translations.required,['first','second']);
  const bad=await fakeCodex(t,encoded([agent('{"translations":{"first":"你好"}}'),done]));
  await assert.rejects(bad.provider.codex(requested,'',DEFAULTS),e=>e.code==='INVALID_MODEL_OUTPUT');assert.equal(bad.calls.length,1);
});
