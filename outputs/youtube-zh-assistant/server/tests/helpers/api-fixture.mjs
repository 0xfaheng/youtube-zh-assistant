// Isolated application + OpenAI-compatible HTTP fixture. Never loads production state.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../app.mjs';
import { Storage } from '../../storage.mjs';
import { Providers } from '../../providers.mjs';

const listen = server => new Promise((resolve,reject) => { server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port)); });
const close = server => new Promise(resolve => {server.closeAllConnections();server.close(resolve);});
export async function apiFixture() {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(),'ytzh-api-test-'));
  const calls = [];
  let errorStatus = 0;
  const upstream = http.createServer(async (req,res) => {
    const chunks=[];for await (const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({url:req.url,authorization:req.headers.authorization,body});
    res.setHeader('Content-Type','application/json');
    if (errorStatus || req.headers.authorization !== 'Bearer dummy-api-fixture-key') {
      res.statusCode=errorStatus || 401;res.end(JSON.stringify({error:{message:'Test upstream rejected a dummy credential'}}));return;
    }
    const responses=req.url==='/custom/v1/responses',chat=req.url==='/custom/v1/chat/completions';
    if (!responses&&!chat) {res.statusCode=404;res.end('{}');return;}
    const prompt=responses ? body.input[0].content : body.messages[0].content;
    const input=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
    const semantic=prompt.includes('sourceIds');
    const output=JSON.stringify(semantic ? {segments:input.items.map(item=>({sourceIds:[item.id],text:'模拟接口译文'}))} : {items:input.items.map(item=>({id:item.id,text:'欢迎，这段视频介绍人工智能的工作原理。'}))});
    res.end(JSON.stringify(responses ? {status:'completed',model:body.model,output_text:output} : {model:body.model,choices:[{message:{content:output}}]}));
  });
  const upstreamPort=await listen(upstream);
  const storage=new Storage(runtime);storage.key='';storage.keySource='none';await storage.init();
  // Reserve a random port using the existing createApp allowedPort contract; do not change production startup.
  const reservation=http.createServer();const port=await listen(reservation);await close(reservation);
  const providers=new Providers({fetchImpl:async (url,options)=>{
    if (new URL(url).origin!==`http://127.0.0.1:${upstreamPort}`) throw new Error('Fixture blocks non-test upstream');
    return fetch(url,options);
  }});
  const app=createApp({storage,providers,getLogin:async()=>({loggedIn:false,authMode:'测试环境'}),allowedPort:port,webDir:path.resolve(import.meta.dirname,'../../../web')});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(port,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${port}`,headers={Authorization:`Bearer ${storage.token}`,'Content-Type':'application/json'};
  return {url,headers,storage,runtime,calls,baseUrl:`http://127.0.0.1:${upstreamPort}/custom/v1`,
    post:async(route,body)=>{const response=await fetch(url+route,{method:'POST',headers,body:JSON.stringify(body)});return {status:response.status,data:await response.json()};},
    fail(status){errorStatus=status;},
    async close(){await close(app.server);await close(upstream);await fs.rm(runtime,{recursive:true,force:true});}
  };
}
