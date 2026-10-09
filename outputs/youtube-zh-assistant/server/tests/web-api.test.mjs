import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULTS } from '../core.mjs';

const source = fs.readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function harness(options = {}) {
  const nodes = Object.fromEntries([...html.matchAll(/id="([\w-]+)"/g)].map(([, id]) => [id, {
    value:'', checked:true, disabled:false, hidden:false, textContent:'', style:{}, attributes:{}, listeners:{},
    addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute(k,v) { this.attributes[k] = v; },
    scrollIntoView() { this.scrolled = true; }, focus() { this.focused = true; }, reportValidity() { return true; }
  }]));
  const state = {config:{...DEFAULTS}, provider:'codex', configured:true, hasApiKey:true, keySource:'memory', codex:{loggedIn:true,authMode:'ChatGPT'}, counts:{}};
  const requests = [], history = [], session = [];
  const sandbox = {
    URLSearchParams, location:{hash:options.hash || '#token='+'a'.repeat(64),pathname:'/',origin:'http://127.0.0.1:17865'},
    history:{replaceState:(_a,_b,url)=>history.push(url)}, sessionStorage:{getItem:()=>'',setItem:(...args)=>session.push(args)},
    document:{getElementById:id=>nodes[id]},
    fetch:async (route, init) => {
      const body = init.body ? JSON.parse(init.body) : null; requests.push({route,body});
      if (route === '/settings') {
        if (options.failSave) return {ok:false,json:async()=>({error:'API 地址应使用 HTTPS'})};
        if (options.saveWait) await options.saveWait;
        for (const name of Object.keys(DEFAULTS)) if (Object.hasOwn(body,name)) state.config[name]=body[name];
        state.provider=state.config.provider;
        if (body.clearApiKey) {state.hasApiKey=false;state.keySource='none';}
      }
      if (route === '/test') return {ok:!options.failTest,json:async()=>options.failTest ? {error:'API 密钥或模型访问权限无效'} : {provider:state.provider,items:[{text:'欢迎使用'}],elapsedMs:25,lastActual:{requestedModel:state.config.apiModel}}};
      return {ok:true,json:async()=>structuredClone(state)};
    }
  };
  vm.createContext(sandbox);vm.runInContext(source,sandbox);await flush();
  return {nodes,state,requests,history,session,click:id=>nodes[id].listeners.click(),input(id,value){nodes[id].value=value;nodes[id].listeners.input?.();}};
}

test('账号模式仍显示完整 API 板块；直达导航清除地址中的配对码',async()=>{
  const f=await harness({hash:'#token='+'a'.repeat(64)+'&section=api'});
  assert.equal(f.nodes['api-panel'].hidden,false);assert.equal(f.nodes['api-panel'].scrolled,true);assert.equal(f.nodes['api-panel'].focused,true);
  assert.deepEqual(f.history,['/#api-panel']);assert.match(f.nodes['api-state'].textContent,/尚未启用/);assert.match(f.nodes['api-key-state'].textContent,/已配置/);
});

test('保存并测试先保存刚填写的地址协议模型密钥，只启用 API 而不覆盖其他草稿',async()=>{
  const f=await harness();f.input('apiBaseUrl','https://compat.example/custom/v1');f.input('apiMode','chat-completions');f.input('apiModel','vendor/model');f.input('apiKey','dummy-ui-key');f.input('audioModel','unsaved-audio');
  await f.click('test-api');
  assert.deepEqual(f.requests.slice(1).map(x=>x.route),['/settings','/test']);
  assert.deepEqual(f.requests[1].body,{apiBaseUrl:'https://compat.example/custom/v1',apiMode:'chat-completions',apiModel:'vendor/model',provider:'api',apiKey:'dummy-ui-key',rememberApiKey:true});
  assert.equal(f.nodes.apiKey.value,'');assert.equal(f.nodes.provider.value,'api');assert.equal(f.nodes.audioModel.value,'unsaved-audio');assert.equal(f.state.config.audioModel,DEFAULTS.audioModel);
  assert.match(f.nodes['api-feedback'].textContent,/API 连接测试成功/);assert.equal(f.nodes.result.hidden,false);
  f.input('apiKey','invalid-new-key');assert.equal(f.nodes.result.hidden,true);assert.match(f.nodes['api-feedback'].textContent,/重新测试/);
});

test('保存失败不测试、不清空待保存密钥、不报告成功',async()=>{
  const f=await harness({failSave:true});f.input('apiKey','dummy-unsaved');await f.click('test-api');
  assert.equal(f.requests.some(x=>x.route==='/test'),false);assert.equal(f.nodes.apiKey.value,'dummy-unsaved');assert.equal(f.nodes.provider.value,'codex');
  assert.equal(f.nodes['api-feedback'].attributes['data-tone'],'error');assert.equal(f.nodes['test-api'].disabled,false);
});

test('测试失败时保留已保存配置，清除旧成功结果并显示明确错误',async()=>{
  const f=await harness({failTest:true});f.nodes.result.hidden=false;f.nodes.result.textContent='旧成功';await f.click('test-api');
  assert.equal(f.state.provider,'api');assert.equal(f.nodes.result.hidden,true);assert.equal(f.nodes.result.textContent,'');assert.match(f.nodes['api-feedback'].textContent,/权限无效/);
});

test('重复点击不重复付费测试，保存期间锁定输入并在结束后恢复',async()=>{
  let release;const saveWait=new Promise(resolve=>{release=resolve;});const f=await harness({saveWait});
  const pending=f.click('test-api');await flush();assert.equal(f.nodes.apiKey.disabled,true);assert.equal(f.nodes['save-settings'].disabled,true);
  await f.click('test-api');assert.equal(f.requests.filter(x=>x.route==='/settings').length,1);
  release();await pending;assert.equal(f.requests.filter(x=>x.route==='/test').length,1);assert.equal(f.nodes.apiKey.disabled,false);
});

test('当前翻译测试先保存所选账号方式；清除密钥不会覆盖未保存字段',async()=>{
  const f=await harness();f.input('codexModel','requested-account-model');await f.click('test');
  assert.equal(f.requests[1].body.provider,'codex');assert.equal(f.requests[1].body.codexModel,'requested-account-model');assert.match(f.nodes['api-feedback'].textContent,/账号翻译 连接测试成功/);
  f.input('apiModel','unsaved-model');await f.click('clear-key');assert.equal(f.nodes.apiModel.value,'unsaved-model');assert.match(f.nodes['api-key-state'].textContent,/未配置/);
});
