import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { LocalASR, toWslPath } from '../local-asr.mjs';

const MODEL = 'Qwen3-ASR-1.7B';
function fakeSpawn(config = {}) {
  const calls = [], requests = [], children = [];
  let lockHeld = false;
  function spawn(command, args, options) {
    calls.push({command,args,options});
    const child = new EventEmitter(); children.push(child);
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killCount = 0; child.closed = false;
    const emit = value => child.stdout.write(JSON.stringify(value)+'\n');
    const close = code => {if (!child.closed) {child.closed=true; lockHeld=false; child.emit('close',code,null);}};
    child.kill = () => {child.killCount++; close(0); return true;};
    child.close = close;
    let buffer='';
    child.stdin = new Writable({
      write(chunk,_encoding,callback) {
        buffer+=chunk.toString();
        let index;
        while((index=buffer.indexOf('\n'))>=0) {
          const line=buffer.slice(0,index); buffer=buffer.slice(index+1);
          const request=JSON.parse(line); requests.push(request);
          queueMicrotask(() => {
            if(child.closed) return;
            if(request.type==='stop') {
              if(config.ignoreStop) return;
              emit({id:request.id,ok:true,result:{stopped:true}}); emit({type:'stopped',reason:'requested'}); close(0); return;
            }
            if(request.type==='warmup') {
              if(config.noise) {child.stdout.write('loading model progress\n'); return;}
              if(config.warmupError) {emit({id:request.id,ok:false,error:{code:'GPU_LOCKED',message:'已有视频 GPU 任务'}}); return;}
              lockHeld=true;
              emit({id:request.id,ok:true,result:{ready:true,available:true,state:'ready',model:MODEL,loadMs:345}});
            }
            if(request.type==='transcribe') {
              if(config.transcribeTimeout) return;
              if(config.transcribeError) {emit({id:request.id,ok:false,error:{code:'LOCAL_ASR_ERROR',message:'识别失败'}}); return;}
              emit({id:request.id,ok:true,result:{text:'Hello 本机',language:'English',inferenceMs:42,loadMs:345,model:MODEL}});
            }
          });
        }
        callback();
      },
      final(callback) {
        if(args.includes('--inspect')) queueMicrotask(()=>{emit(config.inspectValue || {available:true,ready:false,model:MODEL,state:'idle'}); close(0);});
        if(args.includes('-c')) queueMicrotask(()=>{for(const worker of children.slice(0,-1)) worker.close(0); close(0);});
        callback();
      }
    });
    if(!args.includes('--inspect') && !args.includes('-c')) queueMicrotask(()=>emit({type:'hello',protocol:1,pid:1234,model:MODEL}));
    return child;
  }
  return {spawn,calls,requests,children,get lockHeld(){return lockHeld;}};
}
function instance(fake, options = {}) {
  return new LocalASR({spawnImpl:fake.spawn,workerPath:'C:\\test directory\\local-asr-worker.py', env:{YTZH_ASR_DISTRO:'Dayuanzong'},warmupTimeout:1000,transcribeTimeout:1000,stopTimeout:1000,...options});
}
test('Windows 路径安全转换为 WSL argv，不经过 shell', () => {
  assert.equal(toWslPath('D:\\AIModels\\Qwen3-ASR-1.7B'),'/mnt/d/AIModels/Qwen3-ASR-1.7B');
  assert.equal(toWslPath('/models/qwen'),'/models/qwen');
  assert.throws(()=>toWslPath('relative/model'));
});
test('inspect 只检测，不预热、不占 GPU；离线变量同时传入 WSL 与 spawn env', async () => {
  const f=fakeSpawn(), asr=instance(f); const result=await asr.inspect();
  assert.equal(result.available,true); assert.equal(result.ready,false); assert.equal(asr.status().state,'idle');
  assert.equal(f.lockHeld,false); assert.equal(f.requests.length,0);
  const {command,args,options}=f.calls[0]; assert.equal(command,'wsl.exe'); assert.ok(args.includes('--inspect'));
  for(const key of ['HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE','HF_DATASETS_OFFLINE','HF_HUB_DISABLE_TELEMETRY']) {assert.equal(options.env[key],'1'); assert.ok(args.includes(`${key}=1`));}
  assert.equal(options.shell,false); assert.equal(options.windowsHide,true);
  assert.ok(args.includes('/mnt/c/test directory/local-asr-worker.py'));
});
test('inspect 缓存部署检测，并发查询只启动一次 WSL', async () => {
  const f=fakeSpawn(), asr=instance(f); const results=await Promise.all([asr.inspect(),asr.inspect(),asr.inspect()]);
  assert.ok(results.every(value=>value.available && !value.ready)); await asr.inspect(); assert.equal(f.calls.length,1);
});
test('预热复用单个 worker，原样传递内存音频/语言/上下文并返回计时', async () => {
  const f=fakeSpawn(), asr=instance(f);
  await Promise.all([asr.warmup(),asr.warmup()]); assert.equal(f.calls.length,1); assert.equal(f.lockHeld,true);
  const buffer=Buffer.from([0,1,255,7]); const result=await asr.transcribe({buffer,mime:'audio/wav',context:'视频标题'},'English');
  assert.deepEqual(result,{text:'Hello 本机',language:'English',inferenceMs:42,loadMs:345,model:MODEL});
  const request=f.requests.find(r=>r.type==='transcribe'); assert.deepEqual(Buffer.from(request.audioBase64,'base64'),buffer);
  assert.equal(request.mime,'audio/wav'); assert.equal(request.context,'视频标题'); assert.equal(request.language,'English');
  await asr.stop(); assert.equal(f.lockHeld,false); assert.equal(asr.status().ready,false); assert.equal(asr.status().state,'idle');
  assert.equal(f.children[0].killCount,0); assert.equal(f.requests.at(-1).type,'stop');
});
test('无效输入在启动前拒绝', async () => {
  const f=fakeSpawn(), asr=instance(f);
  for(const input of [{buffer:Buffer.alloc(0),mime:'audio/wav'},{buffer:Buffer.from('x'),mime:'audio/mp3'},{buffer:Buffer.alloc(4*1024*1024+1),mime:'audio/wav'}]) await assert.rejects(asr.transcribe(input),{code:'INVALID_AUDIO'});
  assert.equal(f.calls.length,0);
});
test('模型加载错误温和关闭 worker，不冒充 ready', async () => {
  const f=fakeSpawn({warmupError:true}), asr=instance(f);
  await assert.rejects(asr.warmup(),{code:'GPU_LOCKED'});
  assert.equal(asr.status().ready,false); assert.equal(asr.status().state,'error');
  assert.match(asr.status().error,/GPU/); assert.equal(f.requests.at(-1).type,'stop'); assert.equal(f.children[0].killCount,0);
});
test('stdout 中非协议日志触发错误并关闭', async () => {
  const f=fakeSpawn({noise:true}), asr=instance(f);
  await assert.rejects(asr.warmup(),{code:'LOCAL_ASR_PROTOCOL'});
  assert.equal(asr.status().ready,false); assert.equal(f.requests.at(-1).type,'stop');
});
test('识别超时释放常驻 worker 与锁，拒绝并发积压', async () => {
  const f=fakeSpawn({transcribeTimeout:true}), asr=instance(f,{transcribeTimeout:20}); await asr.warmup();
  const first=asr.transcribe({buffer:Buffer.from('wav'),mime:'audio/wav'});
  await assert.rejects(asr.transcribe({buffer:Buffer.from('wav'),mime:'audio/wav'}),{code:'LOCAL_ASR_BUSY'});
  await assert.rejects(first,{code:'LOCAL_ASR_TIMEOUT'}); assert.equal(f.lockHeld,false); assert.equal(asr.status().ready,false);
  assert.equal(f.requests.at(-1).type,'stop');
});
test('stdin 停止超时只向已确认 Linux worker PID 发 SIGTERM，并等待退出', async () => {
  const f=fakeSpawn({ignoreStop:true}), asr=instance(f,{stopTimeout:20,signalTimeout:1000}); await asr.warmup();
  await asr.stop(); const signal=f.calls[1]; assert.ok(signal.args.includes('-c')); assert.ok(signal.args.includes('1234'));
  assert.match(signal.args[signal.args.indexOf('-c')+1],/cmdline.*SIGTERM/);
  assert.equal(f.children[0].killCount,0); assert.equal(f.lockHeld,false); assert.equal(asr.status().state,'idle');
});
test('worker 自行 idle 退出后状态归 idle，可再次预热', async () => {
  const f=fakeSpawn(), asr=instance(f); await asr.warmup(); f.children[0].close(0);
  assert.equal(asr.status().state,'idle'); assert.equal(asr.status().ready,false);
  await asr.warmup(); assert.equal(f.calls.length,2); await asr.stop();
});
