import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { AppError, TRANSLATION_SCHEMA, translationSchema, parseTranslation, translationPrompt, codexTranslationPrompt, segmentSchema, parseSegments, segmentPrompt } from './core.mjs';

export async function findCodex() {
  const candidates = [process.env.YTZH_CODEX_BIN];
  if (process.platform === 'win32') {
    const root = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex');
    candidates.push(path.join(root, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
    candidates.push(path.join(root, 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'));
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  for (const file of candidates.filter(Boolean)) { try { await fs.access(file); return file; } catch {} }
  return null;
}

function redactDiagnostics(value) {
  return String(value).replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[REDACTED AUTH]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:["']?(?:api[_-]?key|access_token|refresh_token|token|password|secret)["']?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s\"<>]+/g, raw => {try {const url = new URL(raw); url.username=''; url.password=''; url.search=''; url.hash=''; return url.href;} catch {return '[URL]';}});
}

export function runProcess(command, args, { cwd, input = '', timeout = 90000, env = process.env, maxOutput = 2 * 1024 * 1024,
  stopWhen, spawnImpl = spawn, platform = process.platform, cleanupTimeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {child = spawnImpl(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });}
    catch {reject(new AppError('无法启动本机模型程序，请检查安装。',503,'CODEX_UNAVAILABLE'));return;}
    let stdout = '', stderr = '', stopReason = null, failure = null, settled = false, timer, cleanupTimer;
    const finish = (error, result) => {
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(cleanupTimer);
      if(error)reject(error);else resolve(result);
    };
    const fallbackKill = () => {try {child.kill('SIGKILL');} catch {}};
    const terminate = (reason, error) => {
      if(settled || stopReason)return;
      stopReason=reason;failure=error;clearTimeout(timer);
      // A result is never returned until close confirms this owned process exited.
      cleanupTimer=setTimeout(()=>finish(new AppError('无法确认本机模型进程已退出，请检查进程；未自动重试。',503,'PROCESS_CLEANUP_FAILED')),cleanupTimeout);
      if (platform === 'win32' && child.pid) {
        try {
          const killer = spawnImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
          killer.on('error',fallbackKill);killer.on('close',code=>{if(code!==0&&!settled)fallbackKill();});
        } catch {fallbackKill();}
      } else fallbackKill();
    };
    timer = setTimeout(()=>{
      const network=/proxy|reconnect|stream disconnected|error sending request|failed to connect|connection|dns|socket/i.test(stdout+stderr);
      terminate('timeout',new AppError(network ? '模型连接或流式响应超时，请检查本机代理与网络；未自动重试。' : '模型请求未在限定时间内完成；未自动重试，请检查网络或缩小批次。',504,'MODEL_TIMEOUT'));
    },timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      if(settled || stopReason)return;
      stdout += data;
      if (Buffer.byteLength(stdout) > maxOutput) {terminate('output',new AppError('本机模型输出超出限制；未自动重试。',502,'MODEL_OUTPUT_LIMIT'));return;}
      if(stopWhen) {
        try {if(stopWhen({stdout,stderr}))terminate('completed');}
        catch(error) {terminate('validation',error instanceof AppError ? error : new AppError('模型输出校验失败。',502,'INVALID_MODEL_OUTPUT'));}
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000); });
    child.stdin.on('error', () => {});
    child.once('error', () => {
      const error=new AppError('无法启动或清理本机模型程序，请检查安装。',503,'CODEX_UNAVAILABLE');
      if(!child.pid)finish(error);else if(!stopReason)terminate('process',error);
    });
    child.once('close', code => finish(failure,{stdout,stderr:redactDiagnostics(stderr),code,stoppedAfterCompletion:stopReason==='completed'}));
    child.stdin.end(input);
  });
}

function codexFailure(text) {
  if (/rate.limit|usage.limit|quota|额度|用量/i.test(text)) return new AppError('ChatGPT／Codex 用量不足或限流。可以等待恢复或在设置中改用 API。',429,'CODEX_LIMIT');
  if (/priority|service.tier|fast.*(not|unavailable|unsupported)/i.test(text)) return new AppError('账号或模型没有接受 Fast 调用。请在本机设置中选择标准速度后重试。',503,'FAST_UNAVAILABLE');
  return new AppError('Codex 翻译调用失败，请检查 CLI 登录、代理与模型可用性；不会自动切换模型。',502,'CODEX_FAILED');
}
function codexCompletion(items, semantic = false) {
  let offset=0,buffer='',final='',completed=false,usage=null,result=null;
  const parseFinal=()=>{
    let value;
    try {value=JSON.parse(final.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}
    catch {throw new AppError('Codex 没有返回有效字幕 JSON。',502,'INVALID_MODEL_OUTPUT');}
    if (semantic) return parseSegments(value, items);
    const map=value?.translations;
    if(!value || Array.isArray(value) || Object.keys(value).some(key=>key!=='translations') || !map || typeof map!=='object' || Array.isArray(map) || Object.keys(map).length!==items.length || items.some(item=>!Object.hasOwn(map,item.id))) throw new AppError('Codex 返回字段或字幕 id 不符合 JSON Schema。',502,'INVALID_MODEL_OUTPUT');
    if(items.some(item=>typeof map[item.id]!=='string'))throw new AppError('Codex 返回的译文不是字符串。',502,'INVALID_MODEL_OUTPUT');
    if(items.some(item=>!map[item.id].trim()))throw new AppError('Codex 返回了空译文，未显示不完整的字幕。',502,'INVALID_MODEL_OUTPUT');
    return parseTranslation({items:items.map(item=>({id:item.id,text:map[item.id]}))},items);
  };
  const consume=line=>{
    let event;try {event=JSON.parse(line);}catch{return;}
    if(event.type==='item.completed'&&event.item?.type==='agent_message')final=typeof event.item.text==='string'?event.item.text:'';
    if(event.type==='turn.failed')throw codexFailure(JSON.stringify(event.error||{}));
    if(event.type==='turn.completed') {
      completed=true;
      usage=event.usage && typeof event.usage==='object' ? Object.fromEntries(['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens'].filter(key=>Number.isFinite(event.usage[key])&&event.usage[key]>=0).map(key=>[key,event.usage[key]])) : null;
      if(!final.trim())throw new AppError('Codex 已结束但没有返回最终字幕文本。',502,'CODEX_INCOMPLETE');
      result=parseFinal();
    }
  };
  return {
    update(stdout,end=false) {
      if(result)return true;
      buffer+=stdout.slice(offset);offset=stdout.length;
      let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).replace(/\r$/,'');buffer=buffer.slice(index+1);consume(line);if(result)return true;}
      if(end&&buffer.trim()){consume(buffer);buffer='';}
      return !!result;
    },
    finish(stdout) {this.update(stdout,true);if(!completed||!result)throw new AppError('Codex 没有完成字幕翻译。',502,'CODEX_INCOMPLETE');return {items:result,usage};}
  };
}

export async function codexLoginStatus(bin, cwd) {
  if (!bin) return { available: false, loggedIn: false, authMode: 'unavailable' };
  try {
    const result = await runProcess(bin, ['login', 'status'], { cwd, timeout: 10000 });
    const text = result.stdout + result.stderr;
    return { available: true, loggedIn: result.code === 0, authMode: /ChatGPT/i.test(text) ? 'ChatGPT' : /API key/i.test(text) ? 'API key' : 'unknown' };
  } catch { return { available: true, loggedIn: false, authMode: 'unknown' }; }
}

function providerFailure(status) {
  if (status === 401 || status === 403) return new AppError('API 密钥或模型访问权限无效，请在本机设置中检查。', status, 'API_AUTH');
  if (status === 429) return new AppError('API 返回限流或额度不足，请检查账户额度后重试。', 429, 'API_LIMIT');
  if (status === 404) return new AppError('API 模型或端点不存在，请检查地址与协议。', 502, 'API_NOT_FOUND');
  return new AppError(`API 返回 HTTP ${status}，请检查模型、协议和服务可用性。`, 502, 'API_ERROR');
}

async function apiFetch(url, options, fetchImpl) {
  let response;
  try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(45000) }); }
  catch { throw new AppError('API 网络连接失败或超时，请检查本机网络、地址与代理。', 502, 'API_NETWORK'); }
  if (!response.ok) throw providerFailure(response.status);
  try { return await response.json(); } catch { throw new AppError('API 返回了非 JSON 数据。', 502, 'API_INVALID_OUTPUT'); }
}

export class Providers {
  constructor({ runtimeDir, codexBin, fetchImpl = fetch, runProcessImpl = runProcess }) { this.runtimeDir = runtimeDir; this.codexBin = codexBin; this.fetch = fetchImpl; this.runProcess = runProcessImpl; this.lastActual = null; }
  async codex(items, context, config, semantic = false) {
    const startedAt = Date.now();
    if (!this.codexBin) throw new AppError('未找到 Codex CLI。请安装官方 CLI 或改用 API。', 503, 'CODEX_UNAVAILABLE');
    const cwd = path.join(this.runtimeDir, 'codex-jobs'); await fs.mkdir(cwd, { recursive: true });
    const schema = path.join(cwd, `translation-${crypto.randomUUID()}.schema.json`);
    await fs.writeFile(schema, JSON.stringify(semantic ? segmentSchema(items) : translationSchema(items)), 'utf8');
    const instructionPath = path.join(import.meta.dirname, semantic ? 'semantic-instructions.md' : 'translation-instructions.md').replaceAll('\\', '/');
    const args = ['exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--json', '--color', 'never',
      '--output-schema', schema, '-m', config.codexModel,
      '-c', 'features.shell_tool=false', '-c', 'features.apps=false', '-c', 'web_search="disabled"',
      '-c', `model_instructions_file="${instructionPath}"`, '-c', 'project_doc_max_bytes=0',
      '-c', 'model_reasoning_effort="high"', '-c', `service_tier="${config.codexSpeed === 'fast' ? 'fast' : 'default'}"`,
      '-c', `features.fast_mode=${config.codexSpeed === 'fast'}`, '-'];
    // The CLI owns and refreshes its own authentication. We never open auth.json or forward an OAuth token.
    const completion=codexCompletion(items, semantic);
    let result;
    try {result = await this.runProcess(this.codexBin, args, { cwd, input: semantic ? segmentPrompt(items, context) : codexTranslationPrompt(items, context), timeout: 120000, stopWhen:({stdout})=>completion.update(stdout) });}
    finally {await fs.rm(schema,{force:true});}
    if(result.code!==0&&!result.stoppedAfterCompletion)throw codexFailure(result.stderr+result.stdout);
    const valid=completion.finish(result.stdout);
    this.lastActual={provider:'codex',mode:semantic?'semantic-segments':'translation',requestedModel:config.codexModel,requestedSpeed:config.codexSpeed,batchSize:items.length,elapsedMs:Date.now()-startedAt,usage:valid.usage,completedAt:new Date().toISOString()};
    return valid.items;
  }
  async codexSegments(items, context, config) { return this.codex(items, context, config, true); }
  async apiSegments(items, context, config, apiKey) { return this.api(items, context, config, apiKey, true); }
  async api(items, context, config, apiKey, semantic = false) {
    if (!apiKey) throw new AppError('尚未配置 API 密钥，请在本机设置页填写。', 503, 'API_KEY_MISSING');
    const prompt = semantic ? segmentPrompt(items, context) : translationPrompt(items, context), responses = config.apiMode === 'responses';
    const body = responses ? {
      model: config.apiModel, store: false,
      input: [{ role: 'user', content: prompt }],
      text: { format: { type: 'json_schema', name: semantic ? 'semantic_subtitles' : 'translated_subtitles', strict: true, schema: semantic ? segmentSchema(items) : TRANSLATION_SCHEMA } }
    } : {
      model: config.apiModel, store: false,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    };
    const data = await apiFetch(`${config.apiBaseUrl}/${responses ? 'responses' : 'chat/completions'}`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, this.fetch);
    let text;
    if (responses) {
      if (data.status && data.status !== 'completed') throw new AppError('API 没有完成翻译。', 502, 'API_INCOMPLETE');
      text = data.output_text || (data.output || []).flatMap(item => item.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('');
    } else text = data.choices?.[0]?.message?.content;
    const result = semantic ? parseSegments(text, items) : parseTranslation(text, items);
    this.lastActual = { provider: 'api', mode: semantic ? 'semantic-segments' : 'translation', requestedModel: config.apiModel, returnedModel: data.model || null, usage: data.usage || null, completedAt: new Date().toISOString() };
    return result;
  }
  async transcribe(audio, config, apiKey) {
    if (!apiKey) throw new AppError('无字幕识别需要语音 API 密钥。ChatGPT CLI 仅用于文字翻译。', 503, 'AUDIO_KEY_MISSING');
    const form = new FormData();
    form.append('file', new Blob([audio.buffer], { type: audio.mime }), audio.mime === 'audio/wav' ? 'chunk.wav' : 'chunk.webm');
    form.append('model', config.audioModel); form.append('response_format', 'json');
    if (audio.context) form.append('prompt', audio.context.slice(-1000));
    const data = await apiFetch(`${config.audioBaseUrl}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form }, this.fetch);
    if (typeof data.text !== 'string' || data.text.length > 8000) throw new AppError('语音 API 返回无效转写。', 502, 'AUDIO_INVALID_OUTPUT');
    return data.text.trim();
  }
}
