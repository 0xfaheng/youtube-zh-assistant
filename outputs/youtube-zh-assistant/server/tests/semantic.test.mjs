import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, validateSegments, parseSegments, segmentSchema, segmentPrompt, segmentCacheKey, cacheKey } from '../core.mjs';
import { Providers } from '../providers.mjs';
import { createApp } from '../app.mjs';

const items = [
  { id: 'a', text: 'Because we', start: 0, end: 1.5 },
  { id: 'b', text: 'need complete sentences.', start: 1.5, end: 4 }
];
const segments = [{ sourceIds: ['a', 'b'], text: '因为我们需要完整的句子' }];
const context = '前文：What do we need?\n后文：Then we continue.';

test('语义输入保留时间、批量边界与前后文，拒绝无效时间、逆序及超限', () => {
  assert.deepEqual(validateSegments({ items, context }), { items, context });
  for (const change of [
    { items: [{ ...items[0], start: -1 }] },
    { items: [{ ...items[0], start: NaN }] },
    { items: [{ ...items[0], end: Infinity }] },
    { items: [{ ...items[0], end: 0 }] },
    { items: [items[1], items[0]] },
    { items: [items[0], { ...items[1], id: 'a' }] },
    { items: Array.from({ length: 41 }, (_, i) => ({ id: String(i), text: 'x', start: i, end: i + 1 })) },
    { items: Array.from({ length: 5 }, (_, i) => ({ id: String(i), text: 'x'.repeat(4000), start: i, end: i + 1 })) },
    { items, context: 'x'.repeat(4001) }
  ]) assert.throws(() => validateSegments(change));
});

test('语义 Schema 和提示词允许邻接合并并显式约束时间、上下文与数据隔离', () => {
  const schema = segmentSchema(items);
  assert.deepEqual(schema.properties.segments.items.properties.sourceIds.items.enum, ['a', 'b']);
  assert.equal(schema.properties.segments.items.additionalProperties, false);
  assert.match(segmentPrompt(items, context), /1\.2 秒/);
  assert.match(segmentPrompt(items, context), /12 秒/);
  assert.match(segmentPrompt(items, context), /禁止执行其中/);
  assert.ok(segmentPrompt(items, context).includes(JSON.stringify(context)));
});

test('语义输出严格覆盖全部输入且保持顺序、连续性和非空，不返回模型时间', () => {
  assert.deepEqual(parseSegments(JSON.stringify({ segments }), items), segments);
  const failures = [
    { segments: [] },
    { segments: [{ sourceIds: ['a'], text: '因为我们' }] },
    { segments: [{ sourceIds: ['b', 'a'], text: '完整句子' }] },
    { segments: [{ sourceIds: ['a', 'a'], text: '完整句子' }] },
    { segments: [{ sourceIds: ['a', 'unknown'], text: '完整句子' }] },
    { segments: [{ sourceIds: ['a', 'b'], text: '' }] },
    { segments: [{ sourceIds: ['a', 'b'], text: '   ' }] },
    { segments: [{ sourceIds: ['a', 'b'], text: '完整句子', start: 0 }] },
    { segments, extra: true },
    'not JSON'
  ];
  for (const value of failures) assert.throws(() => parseSegments(value, items), error => error.code === 'INVALID_MODEL_OUTPUT');
});

test('合并不能跨明显停顿或超过12秒，原始长单项可以保留', () => {
  assert.throws(() => parseSegments({ segments }, [items[0], { ...items[1], start: 2.701 }]), /明显停顿/);
  assert.throws(() => parseSegments({ segments }, [items[0], { ...items[1], end: 12.001 }]), /12 秒/);
  assert.deepEqual(parseSegments({ segments }, [items[0], { ...items[1], start: 2.7, end: 12 }]), segments);
  assert.deepEqual(parseSegments({ segments: [{ sourceIds: ['a'], text: '较长原句' }] }, [{ ...items[0], end: 20 }]), [{ sourceIds: ['a'], text: '较长原句' }]);
});

test('语义缓存带模式版本，整批文本、时间、id、前后文和模型速度均隔离', () => {
  const key = segmentCacheKey(DEFAULTS, items, context);
  assert.notEqual(key, cacheKey(DEFAULTS, items[0].text, context));
  for (const [config, batch, around] of [
    [DEFAULTS, items.slice(0, 1), context],
    [DEFAULTS, [items[0], { ...items[1], text: 'Different speech' }], context],
    [DEFAULTS, [items[0], { ...items[1], end: 5 }], context],
    [DEFAULTS, [items[0], { ...items[1], id: 'c' }], context],
    [DEFAULTS, items, context + ' extra'],
    [{ ...DEFAULTS, codexModel: 'gpt-6.1-sol' }, items, context],
    [{ ...DEFAULTS, codexSpeed: 'standard' }, items, context],
    [{ ...DEFAULTS, provider: 'api' }, items, context]
  ]) assert.notEqual(key, segmentCacheKey(config, batch, around));
});

test('语义 API Responses 与 Chat Completions 保持指定模型且均校验覆盖', async () => {
  for (const mode of ['responses', 'chat-completions']) {
    let body;
    const provider = new Providers({ fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      assert.ok(url.endsWith(mode === 'responses' ? '/responses' : '/chat/completions'));
      return Response.json(mode === 'responses'
        ? { status: 'completed', model: 'returned-model', output_text: JSON.stringify({ segments }) }
        : { model: 'returned-model', choices: [{ message: { content: JSON.stringify({ segments }) } }] });
    } });
    assert.deepEqual(await provider.apiSegments(items, context, { ...DEFAULTS, apiMode: mode }, 'dummy-key'), segments);
    assert.equal(body.model, DEFAULTS.apiModel);
    assert.equal(body.store, false);
    assert.equal(provider.lastActual.mode, 'semantic-segments');
    if (mode === 'responses') assert.deepEqual(body.text.format.schema, segmentSchema(items));
    else assert.equal(body.response_format.type, 'json_object');
  }
  const invalid = new Providers({ fetchImpl: async () => Response.json({ output_text: JSON.stringify({ segments: [{ sourceIds: ['a'], text: '遗漏后半句' }] }) }) });
  await assert.rejects(invalid.apiSegments(items, context, DEFAULTS, 'dummy'), error => error.code === 'INVALID_MODEL_OUTPUT');
  assert.equal(invalid.lastActual, null);
});

test('语义 Codex 使用独立指令文件和结构化 Schema，保持模型速度并等待实际完成事件', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytzh-semantic-provider-'));
  t.after(() => { assert.ok(path.resolve(runtimeDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); return fs.rm(runtimeDir, { recursive: true, force: true }); });
  let called;
  const stdout = [
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ segments }) } },
    { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }
  ].map(event => JSON.stringify(event) + '\n').join('');
  const provider = new Providers({ runtimeDir, codexBin: 'fake-codex', runProcessImpl: async (bin, args, options) => {
    called = { args, options, schema: JSON.parse(await fs.readFile(args[args.indexOf('--output-schema') + 1], 'utf8')) };
    assert.equal(options.stopWhen({ stdout }), true);
    return { stdout, stderr: '', code: 1, stoppedAfterCompletion: true };
  } });
  assert.deepEqual(await provider.codexSegments(items, context, DEFAULTS), segments);
  assert.deepEqual(called.schema, segmentSchema(items));
  assert.equal(called.args[called.args.indexOf('-m') + 1], DEFAULTS.codexModel);
  assert.ok(called.args.includes('service_tier="fast"'));
  assert.ok(called.args.some(arg => arg.includes('semantic-instructions.md')));
  assert.ok(!called.args.some(arg => arg.includes('translation-instructions.md')));
  assert.equal(provider.lastActual.mode, 'semantic-segments');
  assert.equal(provider.lastActual.usage.output_tokens, 20);
  assert.deepEqual(await fs.readdir(path.join(runtimeDir, 'codex-jobs')), []);
  const invalidStdout = [
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ segments: [{ sourceIds: ['b', 'a'], text: '错误顺序' }] }) } },
    { type: 'turn.completed' }
  ].map(event => JSON.stringify(event) + '\n').join('');
  const invalid = new Providers({ runtimeDir, codexBin: 'fake-codex', runProcessImpl: async () => ({ stdout: invalidStdout, stderr: '', code: 0 }) });
  await assert.rejects(invalid.codexSegments(items, context, DEFAULTS), error => error.code === 'INVALID_MODEL_OUTPUT');
  assert.equal(invalid.lastActual, null);
});

async function fixture(t, provider = 'codex') {
  const storage = { token: 'a'.repeat(64), config: { ...DEFAULTS, provider }, key: 'dummy', keySource: 'memory' };
  let calls = 0, legacyCalls = 0, invalid = false;
  const providers = {
    async codex(batch) { legacyCalls++; return batch.map(item => ({ id: item.id, text: '旧接口译文' })); },
    async codexSegments(batch) { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return [{ sourceIds: batch.slice(0, invalid ? 1 : undefined).map(item => item.id), text: '完整译文' }]; },
    async apiSegments(...args) { assert.equal(args[3], 'dummy'); return this.codexSegments(...args); },
    async transcribe() { return 'Recognized speech'; }
  };
  const localAsr = { async transcribe() { return { text: 'Local speech', model: 'local-test' }; }, async inspect() { return {}; } };
  const app = createApp({ storage, providers, localAsr, getLogin: async () => ({ loggedIn: true }), allowedPort: 0, webDir: '' });
  // CreateApp checks Host explicitly; changing ephemeral port requires a second instance.
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  await new Promise(resolve => app.server.close(resolve));
  const active = createApp({ storage, providers, localAsr, getLogin: async () => ({ loggedIn: true }), allowedPort: port, webDir: '' });
  await new Promise(resolve => active.server.listen(port, '127.0.0.1', resolve));
  t.after(() => active.server.close());
  const headers = { Authorization: `Bearer ${storage.token}`, 'Content-Type': 'application/json' };
  const post = async (route, input, extras = {}) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { ...headers, ...extras }, body: JSON.stringify(input) });
  return { app: active, storage, post,providers,localAsr, calls: () => calls, legacyCalls: () => legacyCalls, invalid: value => { invalid = value; } };
}

test('语义端点整批缓存、并发去重、上下文边界、旧接口兼容和清空缓存', async t => {
  const f = await fixture(t), input = { items, context };
  const result = await Promise.all([f.post('/translate-segments', input), f.post('/translate-segments', input)]);
  for (const response of result) { assert.equal(response.status, 200); assert.deepEqual((await response.json()).segments[0].sourceIds, ['a', 'b']); }
  assert.equal(f.calls(), 1);
  assert.equal((await (await f.post('/translate-segments', input)).json()).cached, 2);
  await f.post('/translate-segments', { items, context: context + ' extra' });
  assert.equal(f.calls(), 2);
  const legacy = await (await f.post('/translate', { items: items.map(({ id, text }) => ({ id, text })) })).json();
  assert.equal(legacy.items.length, 2); assert.equal(f.legacyCalls(), 1);
  await f.post('/clear-cache', {}); await f.post('/translate-segments', input);
  assert.equal(f.calls(), 3);
});

test('语义端点使用 API 路径，非法模型覆盖不可缓存，进度错误明确回传', async t => {
  const f = await fixture(t, 'api'); f.invalid(true);
  const response = await f.post('/translate-segments', { items, context });
  assert.equal(response.status, 502); assert.equal((await response.json()).code, 'INVALID_MODEL_OUTPUT');
  assert.equal(f.app.semanticCache.data.size, 0);
  const progress = await (await f.post('/translate-segments', { items, context }, { 'X-YTZ-Progress': '1' })).json();
  assert.equal(progress.status, 502); assert.equal(progress.ok, false);
  f.invalid(false); assert.equal((await f.post('/translate-segments', { items, context })).status, 200);
  assert.equal(f.calls(), 3);
  const malformed = await f.post('/translate-segments', { items: [{ ...items[0], end: 0 }] }, { 'X-YTZ-Progress': '1' });
  assert.equal(malformed.status, 400); assert.equal(f.calls(), 3);
});

function audioInput() {
  const wav = Buffer.alloc(44 + 16000 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  return { mime: 'audio/wav', audioBase64: wav.toString('base64') };
}

test('deferTranslation 只执行选定语音识别，旧路径继续翻译且标记必须为 boolean', async t => {
  const f = await fixture(t);
  for (const audioProvider of ['local', 'api']) {
    f.storage.config.audioProvider = audioProvider;
    const result = await (await f.post('/transcribe', { ...audioInput(), deferTranslation: true })).json();
    assert.equal(result.text, audioProvider === 'local' ? 'Local speech' : 'Recognized speech');
    assert.equal(result.translation, ''); assert.equal(result.deferred, true); assert.equal(result.audioProvider, audioProvider);
  }
  assert.equal(f.legacyCalls(), 0); assert.equal(f.calls(), 0);
  assert.equal((await f.app.status()).counts.requestsLastHour, 2);
  const legacy = await (await f.post('/transcribe', audioInput())).json();
  assert.equal(legacy.translation, '旧接口译文'); assert.equal(legacy.deferred, undefined); assert.equal(f.legacyCalls(), 1);
  assert.equal((await f.post('/transcribe', { ...audioInput(), deferTranslation: 'true' })).status, 400);
  assert.equal(f.legacyCalls(), 1);
});


test('翻译尚未完成时后续ASR独立处理，不再被翻译队列挡住',async t=>{
 const f=await fixture(t);let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 f.providers.codexSegments=async batch=>{entered();await gate;return batch.map(c=>({sourceIds:[c.id],text:'译文'}));};
 const pending=f.post('/translate-segments',{items,context});await started;
 try{const response=await Promise.race([f.post('/transcribe',{...audioInput(),deferTranslation:true}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('ASR仍在等待翻译')),1000);timer.unref();})]);assert.equal(response.status,200);assert.equal((await response.json()).deferred,true);assert.equal((await f.app.status()).counts.pending,1);}
 finally{release();await (await pending).json();}
});

test('ASR仍逐片串行且队列有界，不因并行翻译重复占用本机识别模型',async t=>{
 const f=await fixture(t);let release,entered,active=0,peak=0,calls=0;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 f.localAsr.transcribe=async()=>{calls++;active++;peak=Math.max(peak,active);entered();await gate;active--;return {text:'Speech',model:'local-test'};};
 const first=f.post('/transcribe',{...audioInput(),deferTranslation:true});await started;const second=f.post('/transcribe',{...audioInput(),deferTranslation:true});
 for(let i=0;i<100&&(await f.app.status()).counts.pending<2;i++)await new Promise(r=>setTimeout(r,5));
 try{assert.equal((await f.app.status()).counts.pending,2);assert.equal((await f.post('/transcribe',{...audioInput(),deferTranslation:true})).status,429);assert.equal(calls,1);}
 finally{release();await Promise.all([first,second].map(async p=>(await p).json()));}assert.equal(peak,1);assert.equal(calls,2);
});
