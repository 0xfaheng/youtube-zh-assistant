import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { AppError, MemoryCache, SerialQueue, UsageLimits, validateTranslation, cacheKey, decodeAudio, validateSegments, parseSegments, segmentCacheKey } from './core.mjs';
import { LocalASRError } from './local-asr.mjs';

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError('请求必须使用 application/json。', 415);
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 6 * 1024 * 1024) throw new AppError('请求过大。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('请求 JSON 无效。'); }
}

function authorized(req, token) {
  const value = (req.headers.authorization || '').replace(/^Bearer /, '');
  const a = Buffer.from(value), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ storage, providers, getLogin, localAsr = null, webDir, allowedPort = 17865 }) {
  const cache = new MemoryCache(), semanticCache = new MemoryCache(1000), queue = new SerialQueue(),audioQueue=new SerialQueue(2), limits = new UsageLimits(), inflight = new Map();
  let translations = 0, cacheHits = 0, lastError = null, lastAudio = null;

  const status = async () => {
    const login = await getLogin();
    const local = localAsr ? await localAsr.inspect() : { available: false, ready: false, state: 'unavailable', model: 'Qwen3-ASR-1.7B' };
    return {
      ok: true, version: '0.4.7', config: storage.config,
      configured: storage.config.provider === 'api' ? Boolean(storage.key) : Boolean(login.loggedIn),
      provider: storage.config.provider, audioProvider: storage.config.audioProvider,
      audioConfigured: storage.config.audioProvider === 'local' ? local.available : Boolean(storage.key),
      localAsr: local, lastAudio,
      hasApiKey: Boolean(storage.key), keySource: storage.keySource, codex: login,
      network: {httpProxyConfigured:!!process.env.HTTP_PROXY,httpsProxyConfigured:!!process.env.HTTPS_PROXY,fetchUsesEnvironmentProxy:process.env.NODE_USE_ENV_PROXY==='1'},
      counts: { translations, cacheHits, cachedLines: cache.data.size, pending: queue.waiting+audioQueue.waiting, ...limits.summary() },
      lastActual: providers.lastActual, lastError
    };
  };

  const queuedTranslation = async (fingerprint, work, client={closed:false}) => {
    let job=inflight.get(fingerprint);
    if(!job){
      job={clients:new Set()};
      job.promise=queue.run(()=>{
        if(![...job.clients].some(c=>!c.closed))throw new AppError('旧字幕请求已取消，未调用模型。',499,'TRANSLATION_CANCELLED');
        return work();
      });
      inflight.set(fingerprint,job);
      job.promise.finally(()=>{if(inflight.get(fingerprint)===job)inflight.delete(fingerprint);}).catch(()=>{});
    }
    job.clients.add(client);
    try{return await job.promise;}finally{job.clients.delete(client);}
  };

  const translate = async (input, client) => {
    const { items, context } = validateTranslation(input), config = { ...storage.config }, key = storage.key;
    const result = new Map(), missing = [];
    for (const item of items) {
      const text = cache.get(cacheKey(config, item.text, context));
      if (text !== undefined) { result.set(item.id, text); cacheHits++; } else missing.push(item);
    }
    if (missing.length) {
      const fingerprint = JSON.stringify([config, key ? 'key-present' : 'no-key', missing, context]);
      const job = queuedTranslation(fingerprint, async () => {
          // Re-check after waiting; a preceding batch may have populated overlapping captions.
          const hit = new Map(), needed = [];
          for (const item of missing) {
            const cached = cache.get(cacheKey(config, item.text, context));
            if (cached === undefined) needed.push(item); else hit.set(item.id, cached);
          }
          if (needed.length) {
            limits.reserve(config);
            const translated = config.provider === 'codex' ? await providers.codex(needed, context, config) : await providers.api(needed, context, config, key);
            translated.forEach((item, index) => { hit.set(item.id, item.text); cache.set(cacheKey(config, needed[index].text, context), item.text); });
            translations += translated.length;
          }
          return missing.map(item => ({ id: item.id, text: hit.get(item.id) }));
        },client);
      for (const item of await job) result.set(item.id, item.text);
    }
    return { items: items.map(item => ({ id: item.id, text: result.get(item.id) })), cached: items.length - missing.length, provider: config.provider };
  };

  const translateSegments = async (input, client) => {
    const { items, context } = validateSegments(input), config = { ...storage.config }, key = storage.key;
    // Semantic groups depend on the complete batch, its timing, and both sides of context.
    const fingerprint = segmentCacheKey(config, items, context);
    const cached = semanticCache.get(fingerprint);
    if (cached !== undefined) {
      cacheHits += items.length;
      return { segments: structuredClone(cached), cached: items.length, provider: config.provider };
    }
    const job = queuedTranslation(fingerprint, async () => {
        const hit = semanticCache.get(fingerprint);
        if (hit !== undefined) return hit;
        limits.reserve(config);
        const output = config.provider === 'codex'
          ? await providers.codexSegments(items, context, config)
          : await providers.apiSegments(items, context, config, key);
        const segments = parseSegments({ segments: output }, items);
        semanticCache.set(fingerprint, segments);
        translations += items.length;
        return segments;
      },client);
    return { segments: structuredClone(await job), cached: 0, provider: config.provider };
  };

  const server = http.createServer(async (req, res) => {
    const ownOrigin = `http://127.0.0.1:${allowedPort}`;
    const origin = req.headers.origin;
    const originAllowed = !origin || origin === ownOrigin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    let progressTimer = null;
    const client={closed:res.destroyed};
    const stopProgress = () => {if(progressTimer)clearInterval(progressTimer);progressTimer=null;};
    res.once('close',()=>{client.closed=true;stopProgress();});
    // JSON whitespace lets MV3 receive headers promptly and read progress without
    // creating another paid request. Ordinary clients retain HTTP error statuses.
    const startProgress = () => {
      if(req.headers['x-ytz-progress']!=='1')return;
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.write('\n');
      progressTimer=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write('\n');},10000);
    };
    const json = (value, code = 200) => {stopProgress();if (!res.writableEnded&&!res.destroyed) {if(!res.headersSent)res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });else if(code!==200)value={...value,status:code};res.end(JSON.stringify(value));} };
    try {
      if (req.headers.host !== `127.0.0.1:${allowedPort}` || !originAllowed) throw new AppError('仅允许本机界面和已配对扩展访问。', 403, 'ORIGIN_DENIED');
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-YTZ-Progress');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, ownOrigin);
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
        res.end(await fs.readFile(path.join(webDir, name))); return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        const current = await status(); json({ ok: true, configured: current.configured, provider: current.provider, audioProvider: current.audioProvider, audioConfigured: current.audioConfigured, localAsr: current.localAsr }); return;
      }
      if (!authorized(req, storage.token)) throw new AppError('本机配对码无效，请双击 start.cmd，在同一浏览器的设置页一键配对插件。', 401, 'PAIRING_REQUIRED');
      if (req.method === 'GET' && url.pathname === '/pairing') { json({ok:true,version:'0.4.7',service:'youtube-zh-assistant'}); return; }
      if (req.method === 'GET' && url.pathname === '/status') { json(await status()); return; }
      if (req.method === 'POST' && url.pathname === '/settings') { await storage.save(await readJson(req)); json(await status()); return; }
      if (req.method === 'POST' && url.pathname === '/translate') {const input=await readJson(req);validateTranslation(input);startProgress();json(await translate(input,client));return;}
      if (req.method === 'POST' && url.pathname === '/translate-segments') {const input=await readJson(req);validateSegments(input);startProgress();json(await translateSegments(input,client));return;}
      if (req.method === 'POST' && ['/local-asr/warmup', '/local-asr/stop'].includes(url.pathname)) {
        await readJson(req);
        if (!localAsr) throw new AppError('本地语音模型未接入。', 503, 'LOCAL_ASR_UNAVAILABLE');
        await audioQueue.run(() => url.pathname.endsWith('/warmup') ? localAsr.warmup() : localAsr.stop());
        json(await status()); return;
      }
      if (req.method === 'POST' && url.pathname === '/transcribe') {
        const input = await readJson(req);
        if (input.deferTranslation !== undefined && typeof input.deferTranslation !== 'boolean') throw new AppError('deferTranslation 必须为布尔值。');
        const audio = decodeAudio(input), config = { ...storage.config }, key = storage.key;
        const useLocal = config.audioProvider === 'local';
        if (useLocal && !localAsr) throw new AppError('本地语音模型未接入，请检查模型部署或选择语音 API。', 503, 'LOCAL_ASR_UNAVAILABLE');
        if (!useLocal && !key) throw new AppError('请先在本机设置页配置语音 API 密钥。', 503, 'AUDIO_KEY_MISSING');
        startProgress();
        const result = await audioQueue.run(async () => {
          limits.reserve(config, audio.seconds);
          const recognized = useLocal ? await localAsr.transcribe(audio, config.localAsrLanguage) : { text: await providers.transcribe(audio, config, key), model: config.audioModel };
          const text = recognized.text;
          lastAudio = { audioProvider: config.audioProvider, model: recognized.model, language: recognized.language || null, inferenceMs: recognized.inferenceMs ?? null, time: new Date().toISOString() };
          if (!text) return { text: '', translation: '', ...(input.deferTranslation ? { deferred: true } : {}), provider: config.provider, audioProvider: config.audioProvider };
          if (typeof text !== 'string' || text.length > 4000) throw new AppError('语音转录结果过长或无效。', 502, 'ASR_INVALID_OUTPUT');
          if (input.deferTranslation) return { text, translation: '', deferred: true, provider: config.provider, audioProvider: config.audioProvider };
          limits.reserve(config);
          const request = [{ id: 'audio', text }];
          let translated;
          try {
            translated = config.provider === 'codex' ? await providers.codex(request, audio.context, config) : await providers.api(request, audio.context, config, key);
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            throw new AppError(`${useLocal ? '本机' : '云端'}语音识别已完成，但${config.provider === 'codex' ? 'ChatGPT／Codex' : 'API'}翻译失败：${error.message}`, error.status, error.code);
          }
          return { text, translation: translated[0].text, provider: config.provider, audioProvider: config.audioProvider };
        });
        json(result); return;
      }
      if (req.method === 'POST' && url.pathname === '/test') {
        await readJson(req);
        const start = Date.now();
        const result = await translate({ items: [{ id: 'connection-test', text: 'Welcome. This video explains how artificial intelligence works.' }] });
        json({ ...result, elapsedMs: Date.now() - start, lastActual: providers.lastActual }); return;
      }
      if (req.method === 'POST' && url.pathname === '/clear-cache') { await readJson(req); cache.clear(); semanticCache.clear(); json({ ok: true }); return; }
      throw new AppError('接口不存在。', 404, 'NOT_FOUND');
    } catch (error) {
      const knownError = error instanceof AppError || error instanceof LocalASRError;
      const code = knownError ? error.status : 500;
      const message = knownError ? error.message : '本机服务发生错误，请重新启动。';
      lastError = { code: error.code || 'INTERNAL_ERROR', message, time: new Date().toISOString() };
      json({ ok: false, error: message, code: lastError.code }, code);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  // Cold local model loading plus account translation can exceed three minutes.
  // Keep the server socket alive slightly longer than the extension's audio timeout.
  server.timeout = 310000;
  return { server, translate, translateSegments, status, cache, semanticCache, limits };
}
