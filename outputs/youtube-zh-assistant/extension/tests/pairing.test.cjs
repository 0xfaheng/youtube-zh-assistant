const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function harness(origin='http://127.0.0.1:17865',result={ok:true,paired:true,verified:true,version:'0.2.2'}){
  let receive;const sent=[],posted=[];
  const sandbox={location:{origin,pathname:'/'},chrome:{runtime:{sendMessage:async message=>{sent.push(message);return result;}}}};
  sandbox.window=sandbox;sandbox.addEventListener=(type,fn)=>{receive=fn;};sandbox.postMessage=(data,target)=>posted.push({data,target});
  vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../pairing.js'),'utf8'),sandbox);
  const message=async(data,overrides={})=>{sandbox.__receive=receive;sandbox.__data=data;sandbox.__overrides=overrides;if(receive)await vm.runInContext('__receive({source:window,origin:location.origin,data:__data,...__overrides})',sandbox);};
  return {sent,posted,message};
}
const input={source:'ytz-local-pair-request-v1',requestId:'test-request-id-1234',token:'a'.repeat(64)};
test('本机配对桥接传递验证结果，页面结果不含配对码',async()=>{
  const h=harness();await h.message(input);assert.equal(h.sent[0].type,'PAIR_LOCAL');assert.equal(h.sent[0].token,input.token);assert.equal(h.posted[0].data.verified,true);assert.equal(h.posted[0].target,'http://127.0.0.1:17865');assert.equal(JSON.stringify(h.posted).includes(input.token),false);
});
test('拒绝非本机页面、跨窗口或来源以及无效配对字段',async()=>{
  const remote=harness('https://www.youtube.com');await remote.message(input);assert.equal(remote.sent.length,0);
  const h=harness();for(const [data,overrides] of [[input,{source:{}}],[input,{origin:'https://evil.example'}],[{...input,token:'bad'},{}],[{...input,requestId:'a'},{}],[{...input,source:'other'},{}]])await h.message(data,overrides);assert.equal(h.sent.length,0);
});
test('配对失败回传明确错误，不显示已验证',async()=>{
  const h=harness(undefined,{ok:false,error:'配对码不匹配'});await h.message(input);assert.equal(h.posted[0].data.ok,false);assert.match(h.posted[0].data.error,/不匹配/);assert.equal(h.posted[0].data.verified,false);
});
