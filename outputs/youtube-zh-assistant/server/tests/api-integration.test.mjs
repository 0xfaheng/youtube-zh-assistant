import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { apiFixture } from './helpers/api-fixture.mjs';

for (const mode of ['chat-completions','responses']) test(`自定义 ${mode} 接口：保存、鉴权、模型、逐条和语义字幕端到端`,async t=>{
  const f=await apiFixture();t.after(()=>f.close());
  const saved=await f.post('/settings',{provider:'api',apiBaseUrl:f.baseUrl+'/',apiMode:mode,apiModel:'vendor/test-model',apiKey:'dummy-api-fixture-key',rememberApiKey:false});
  assert.equal(saved.status,200);assert.equal(saved.data.hasApiKey,true);assert.equal(saved.data.keySource,'memory');
  assert.equal(JSON.stringify(saved.data).includes('dummy-api-fixture-key'),false);
  assert.equal((await fs.readFile(path.join(f.runtime,'config.json'),'utf8')).includes('dummy-api-fixture-key'),false);
  assert.equal(saved.data.config.apiBaseUrl,f.baseUrl);
  const tested=await f.post('/test',{});assert.equal(tested.status,200);assert.equal(tested.data.cached,0);assert.equal(tested.data.lastActual.returnedModel,'vendor/test-model');
  const call=f.calls[0];assert.equal(call.url,mode==='responses'?'/custom/v1/responses':'/custom/v1/chat/completions');assert.equal(call.authorization,'Bearer dummy-api-fixture-key');assert.equal(call.body.model,'vendor/test-model');
  assert.equal(JSON.stringify(call.body).includes('dummy-api-fixture-key'),false);
  assert.equal(mode==='responses'?call.body.text.format.type:call.body.response_format.type,mode==='responses'?'json_schema':'json_object');
  const input={items:[{id:'one',text:'hello'}]};assert.equal((await f.post('/translate',input)).status,200);
  assert.equal((await f.post('/translate',input)).data.cached,1);
  const semantic=await f.post('/translate-segments',{items:[{id:'one',text:'hello',start:0,end:2}]});assert.equal(semantic.status,200);assert.equal(semantic.data.segments[0].text,'模拟接口译文');
  await f.post('/settings',{apiKey:''});assert.equal(f.storage.key,'dummy-api-fixture-key');
  await f.post('/settings',{provider:'codex'});assert.equal(f.storage.config.apiModel,'vendor/test-model');assert.equal(f.storage.key,'dummy-api-fixture-key');
});

test('连接测试每次请求上游：缓存和旧密钥不能掩盖 401、404、429、500 或缺密钥',async t=>{
  const f=await apiFixture();t.after(()=>f.close());
  await f.post('/settings',{provider:'api',apiBaseUrl:f.baseUrl,apiMode:'chat-completions',apiKey:'dummy-api-fixture-key',rememberApiKey:false});
  // Prime the ordinary subtitle cache using the exact connection-test text.
  await f.post('/translate',{items:[{id:'connection-test',text:'Welcome. This video explains how artificial intelligence works.'}]});
  await f.post('/test',{});await f.post('/test',{});assert.equal(f.calls.length,3);
  await f.post('/settings',{apiKey:'dummy-rejected-key',rememberApiKey:false});
  const rejected=await f.post('/test',{});assert.equal(rejected.data.code,'API_AUTH');assert.equal(f.calls.length,4);
  assert.equal(JSON.stringify(rejected).includes('dummy-rejected-key'),false);
  await f.post('/settings',{apiKey:'dummy-api-fixture-key',rememberApiKey:false});
  for (const [status,code] of [[401,'API_AUTH'],[404,'API_NOT_FOUND'],[429,'API_LIMIT'],[500,'API_ERROR']]) {
    f.fail(status);const before=f.calls.length;const result=await f.post('/test',{});assert.equal(result.data.code,code);assert.equal(f.calls.length,before+1);
  }
  await f.post('/settings',{clearApiKey:true});const before=f.calls.length;
  assert.equal((await f.post('/test',{})).data.code,'API_KEY_MISSING');assert.equal(f.calls.length,before);
});
