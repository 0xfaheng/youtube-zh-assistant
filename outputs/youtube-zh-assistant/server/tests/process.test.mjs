import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runProcess } from '../providers.mjs';

function fixture({chunks=[],stderr='',naturalExit=null,closeDelay=0,ignoreKill=false,windows=false}={}) {
  const calls=[];let child,closed=false,kills=0;
  const close=code=>{if(closed)return;closed=true;child.stdout.end();child.stderr.end();child.emit('close',code,null);};
  const spawnImpl=(command,args,options)=>{
    calls.push({command,args,options});
    if(command==='taskkill.exe') {const killer=new EventEmitter();queueMicrotask(()=>{kills++;if(!ignoreKill)setTimeout(()=>close(1),closeDelay);killer.emit('close',0);});return killer;}
    child=new EventEmitter();child.pid=4242;child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
    child.kill=()=>{kills++;if(!ignoreKill)setTimeout(()=>close(1),closeDelay);return true;};
    queueMicrotask(()=>{if(stderr)child.stderr.write(stderr);for(const chunk of chunks)child.stdout.write(chunk);if(naturalExit!==null)setTimeout(()=>close(naturalExit),5);});
    return child;
  };
  return {spawnImpl,platform:windows?'win32':'linux',calls,get closed(){return closed;},get kills(){return kills;}};
}
test('完成predicate触发清理，等待close确认，不等待自然退出拖延',async()=>{
  const f=fixture({chunks:['started\n','done\n'],closeDelay:30});const start=Date.now();
  const result=await runProcess('owned-cli',[],{...f,timeout:1000,cleanupTimeout:500,stopWhen:({stdout})=>stdout.endsWith('done\n')});
  assert.equal(result.stoppedAfterCompletion,true);assert.equal(f.kills,1);assert.equal(f.closed,true);assert.ok(Date.now()-start>=20);assert.ok(Date.now()-start<500);
});
test('Windows只终止自己spawn的PID树，完整完成后被清理的退出码不冒充自然exit0',async()=>{
  const f=fixture({chunks:['done\n'],windows:true});const result=await runProcess('owned-cli',[],{...f,stopWhen:()=>true,timeout:1000});
  assert.equal(result.code,1);assert.equal(result.stoppedAfterCompletion,true);assert.equal(f.calls.length,2);assert.equal(f.calls[1].command,'taskkill.exe');assert.deepEqual(f.calls[1].args,['/PID','4242','/T','/F']);assert.equal(f.closed,true);
});
test('未完成请求超时清理；网络错误提示不含stderr密钥',async()=>{
  const secret='private-value';const f=fixture({chunks:['thread.started\n'],stderr:`stream disconnected Bearer ${secret} token=${secret}`});
  await assert.rejects(runProcess('owned-cli',[],{...f,timeout:15,stopWhen:()=>false}),error=>{assert.equal(error.code,'MODEL_TIMEOUT');assert.match(error.message,/代理与网络/);assert.equal(error.message.includes(secret),false);return true;});assert.equal(f.kills,1);assert.equal(f.closed,true);
});
test('校验失败和输出过大均清理，无法确认清理时绝不返回成功',async()=>{
  const invalid=fixture({chunks:['x']});await assert.rejects(runProcess('owned-cli',[],{...invalid,stopWhen:()=>{throw new Error('password=not-for-user');}}),error=>error.code==='INVALID_MODEL_OUTPUT'&&!error.message.includes('not-for-user'));assert.equal(invalid.closed,true);
  const excess=fixture({chunks:['x'.repeat(100)]});await assert.rejects(runProcess('owned-cli',[],{...excess,maxOutput:10}),{code:'MODEL_OUTPUT_LIMIT'});assert.equal(excess.closed,true);
  const stuck=fixture({chunks:['done\n'],ignoreKill:true});await assert.rejects(runProcess('owned-cli',[],{...stuck,stopWhen:()=>true,cleanupTimeout:15}),{code:'PROCESS_CLEANUP_FAILED'});assert.equal(stuck.kills,1);
});
test('UTF8跨chunk字节分割正确解码，stderr返回值脱敏',async()=>{
  const bytes=Buffer.from('你好🌏');const f=fixture({chunks:[bytes.subarray(0,2),bytes.subarray(2,5),bytes.subarray(5)],stderr:'Authorization: Bearer private-bearer\npassword=private-password\nhttps://user:private-pass@example.test/?token=private-query\nsk-secretkeyvalue',naturalExit:0});
  const result=await runProcess('owned-cli',[],f);assert.equal(result.stdout,'你好🌏');for(const value of ['private-bearer','private-password','private-pass','private-query','sk-secretkeyvalue'])assert.equal(result.stderr.includes(value),false);assert.equal(f.kills,0);
});
test('真实本机Node子进程完成后清理且PID已退出，无模型/云端调用',async()=>{
  const source="process.stdout.write('pid:'+process.pid+'\\ndone\\n');setInterval(()=>{},1000);";
  const start=Date.now();const result=await runProcess(process.execPath,['-e',source],{timeout:5000,cleanupTimeout:5000,stopWhen:({stdout})=>stdout.endsWith('done\n')});
  assert.equal(result.stoppedAfterCompletion,true);assert.ok(Date.now()-start<5000);const pid=Number(result.stdout.match(/pid:(\d+)/)[1]);assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
});
