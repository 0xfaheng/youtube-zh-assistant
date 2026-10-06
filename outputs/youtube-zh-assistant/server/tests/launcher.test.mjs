import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runProcess} from '../providers.mjs';

test('启动器验证服务版本与配对归属，错误服务不会打开浏览器', {skip:process.platform!=='win32'},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ytzh-launcher-'));
 t.after(()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));return fs.rm(directory,{recursive:true,force:true});});
 await fs.copyFile(path.resolve(import.meta.dirname,'../../start.ps1'),path.join(directory,'start.ps1'));
 await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({version:'test-version'}));
 const runtime=path.join(directory,'work/youtube-zh-assistant');await fs.mkdir(runtime,{recursive:true});await fs.writeFile(path.join(runtime,'pairing-token.txt'),'a'.repeat(64));
 const invoke=async mode=>{
  const reply=mode==='auth'?'throw "mock 401"':`return @{ok=$true;service='${mode==='service'?'other-service':'youtube-zh-assistant'}';version='${mode==='version'?'old-version':'test-version'}'}`;
  const code=`[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); function Start-Process {throw 'unexpected launch'}; function Invoke-RestMethod {param($Uri,$Headers,$TimeoutSec);if($Uri.EndsWith('/health')){return @{ok=$true}};${reply}}; & '${path.join(directory,'start.ps1').replaceAll("'","''")}' -NoBrowser`;
  return runProcess('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',code],{timeout:15000,cwd:directory});
 };
 for(const mode of ['version','auth','service']){
  const result=await invoke(mode);assert.notEqual(result.code,0);assert.match(result.stderr,/stop\.ps1/);assert.doesNotMatch(result.stdout,/已启动/);assert.doesNotMatch(result.stderr,/unexpected launch/);
 }
 const matched=await invoke('matched');assert.equal(matched.code,0);assert.match(matched.stdout,/已启动/);assert.equal(matched.stderr,'');
});
