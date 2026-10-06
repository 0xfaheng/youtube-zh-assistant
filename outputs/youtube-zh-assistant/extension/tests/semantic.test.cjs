const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(){let now=100000;const sandbox={Intl,Date:{now:()=>now}};vm.createContext(sandbox);for(const file of ['core.js','semantic.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),sandbox);return {api:sandbox.YTZSemantic,sandbox,advance:ms=>now+=ms};}
const cues=[{id:'a',text:'Because we',start:0,end:3},{id:'b',text:'need complete',start:2,end:5},{id:'c',text:'sentences.',start:4,end:7},{id:'d',text:'Then we continue.',start:6,end:9}];
const response=[{sourceIds:['a','b','c'],text:'因为我们需要完整的句子。'},{sourceIds:['d'],text:'然后我们继续。'}];
const plain=x=>JSON.parse(JSON.stringify(x));
test('截图语句保留句界，每行不把模型拆到下一句前面',()=>{
 const {api}=fixture(),text='萨姆奥特曼昨天说，请相信我们很快就会推出能力强得多的模型。下一代模型会让所有人都清醒地认识到现实。';
 const pages=api.pages(text,26,s=>s.length),rows=pages.flatMap(p=>p.split('\n'));
 assert.deepEqual(plain(rows),['萨姆奥特曼昨天说','请相信我们很快就会推出能力强得多的模型','下一代模型会让所有人都清醒地认识到现实']);
 assert.ok(pages.every(p=>p.split('\n').length<=2));
});

test('无标点但有空格的语句仍保留分句，禁止的字悬挂在行尾',()=>{
 const {api}=fixture(),text='萨姆奥特曼昨天说 请相信我们很快就会推出能力强得多的模型 下一代模型会让所有人都清醒地认识到现实';
 const rows=api.pages(text,26,s=>s.length).flatMap(p=>p.split('\n'));
 assert.deepEqual(plain(rows),['萨姆奥特曼昨天说','请相信我们很快就会推出能力强得多的模型','下一代模型会让所有人都清醒地认识到现实']);
 const narrow=api.pages('我们很快就会推出能力强得多的模型',14,s=>s.length).flatMap(p=>p.split('\n'));
 assert.ok(narrow.every(row=>!/[的地得]$/.test(row)));assert.ok(narrow.every(row=>row.length<=14));assert.equal(narrow.join(''),'我们很快就会推出能力强得多的模型');
});

test('完整分句放不下时提前换行，句末短词不与下一句混在一行',()=>{
 const {api}=fixture();
 assert.equal(api.lines('先说明测试方法，然后检查全部字幕内容。最后结束。',12,s=>s.length),'先说明测试方法\n然后检查全部字幕内容\n最后结束');
 const rows=api.pages('Because we need complete sentences. Then we continue.',24,s=>s.length).flatMap(p=>p.split('\n'));
 assert.ok(rows.some(row=>row.endsWith('sentences')));assert.ok(rows.includes('Then we continue'));assert.ok(!rows.some(row=>row.includes('sentences Then')));
});
test('纯标点译文与服务端校验一致，显示为空而不暂停整批字幕',()=>{
 const {api}=fixture();const result=api.groups([{id:'a',text:'...',start:0,end:1}],[{sourceIds:['a'],text:'……'}]);assert.equal(result.length,1);assert.equal(api.lines(result[0].translation,100,s=>s.length),'');
});

test('长中文按自然分句分页，每页最多两行且全文不丢失',()=>{
 const {api}=fixture(),text='先说明这次测试采用的具体方法，再解释为什么需要保留全部信息，最后检查长句在播放器里是否清晰可读。接下来继续介绍第二个重要问题。';
 const pages=api.pages(text,18,s=>Array.from(s).length);
 assert.ok(pages.length>1);assert.match(pages[0].replace(/\n/g,''),/(具体方法|全部信息)$/);
 for(const page of pages){assert.ok(page.split('\n').length<=2);assert.ok(page.split('\n').every(row=>Array.from(row).length<=18));}
 assert.equal(pages.join('').replace(/\s/g,''),text.replace(/[，。\s]/g,''));
});

test('英文分页保留普通单词，超长单词与Unicode字素也不会横向溢出',()=>{
 const {api}=fixture(),text='Ordinary complete words should remain readable across several subtitle pages without deleting any information.';
 const pages=api.pages(text,24,s=>Array.from(s).length);assert.ok(pages.length>1);
 assert.ok(pages.every(p=>p.split('\n').length<=2&&p.split('\n').every(row=>row.length<=24)));
 const tokens=pages.join(' ').split(/\s+/);assert.deepEqual(tokens,text.replace(/\.$/,'').split(' '));
 const long='Antidisestablishmentarianism'.repeat(3),split=api.pages(long,10,s=>Array.from(s).length);assert.equal(split.join('').replace(/\s/g,''),long);assert.ok(split.every(p=>p.split('\n').every(row=>row.length<=10)));
 const unicode=('👨‍👩‍👧‍👦e\u0301').repeat(5),measure=s=>[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(s)].length;
 const unicodePages=api.pages(unicode,2,measure);assert.equal(unicodePages.join('').replace(/\s/g,''),unicode);assert.ok(unicodePages.every(p=>p.split('\n').every(row=>measure(row)<=2)));
});

test('分页保留数字和专名符号，不显示省略号或丢弃尾部',()=>{
 const {api}=fixture(),text="The value is 50%, -5°C and 3.14 at 3:30. C# and C++ aren't lost in a long subtitle.";
 const joined=api.pages(text,20,s=>s.length).join(' ').replace(/\s+/g,' ');
 for(const token of ['50%','-5°C','3.14','3:30','C#','C++',"aren't",'subtitle'])assert.ok(joined.includes(token));
 assert.ok(api.pages('时间3：30，温度-5°C，继续验证全部字幕内容。',12,s=>s.length).join(' ').includes('3：30'));
 assert.deepEqual(plain(api.pages('，。！？',10,s=>s.length)),[]);
});

test('中英文共用分页时钟，较短一侧保持可见，进度边界安全',()=>{
 const {api}=fixture(),zh=['中文第一段','中文第二段','中文第三段'],en=['First source','Second source'];
 assert.deepEqual(plain(api.selectPair(zh,en,0)),{chinese:zh[0],original:en[0],page:1,pages:3});
 assert.equal(api.selectPair(zh,en,.5).page,2);assert.equal(api.selectPair(zh,en,.5).original,en[0]);
 assert.equal(api.selectPair(zh,en,1).chinese,zh[2]);assert.equal(api.selectPair(zh,en,1).original,en[1]);
 assert.equal(api.selectPair(zh,[],.5).original,'');assert.equal(api.selectPair(zh,en,-10).page,1);
});

test('轨道分页跟随视频时间，实时分页跟随显示窗口，不改变原时间范围',()=>{
 const {api}=fixture(),cue={start:10,end:22};assert.equal(api.captionProgress(cue,10),0);assert.equal(api.captionProgress(cue,16),.5);assert.equal(api.captionProgress(cue,22),1);assert.equal(api.captionProgress(cue,5),0);
 assert.equal(api.captionProgress({until:20000,duration:8000},999,16000),.5);
 assert.equal(api.captionProgress({until:20000},999,13000),.5);assert.equal(api.captionProgress(null,1),null);
 assert.deepEqual(cue,{start:10,end:22});
});

test('显示布局缓存会随字体重算，两种语言共用Canvas时保留各自字宽',()=>{
 const {api,sandbox,advance}=fixture(),context={font:'',measureText(text){const size=Number(this.font.match(/(\d+)px/)[1]);return {width:Array.from(text).reduce((n,c)=>n+(c.charCodeAt(0)<128?.5:1),0)*size};}};
 const doc={createElement:()=>({getContext:()=>context})},zh={ownerDocument:doc,style:{},className:'',size:20},en={ownerDocument:doc,style:{},className:'original',size:16};
 sandbox.getComputedStyle=node=>({font:node.size+'px Arial',fontSize:node.size+'px'});
 const text='所有字幕文字都应该保留并且根据播放器的宽度分页显示。'.repeat(5),source='Every subtitle word must stay readable across the entire sentence. '.repeat(3);
 const first=api.writePair(zh,en,text,source,300,0,'video');assert.ok(first.pages>1);assert.ok(zh.textContent.split('\n').every(row=>row.length*20<=300));
 assert.equal(zh.style.whiteSpace,'pre');assert.equal(en.style.whiteSpace,'pre');assert.ok(Number.parseFloat(zh.style.maxWidth)<=280);
 const pages=first.pages;zh.size=40;const large=api.writePair(zh,en,text,source,300,0,'video');assert.ok(large.pages>pages);assert.ok(zh.textContent.split('\n').every(row=>row.length*40<=300));
 api.writePair(zh,en,text,source,300,null,'dom');advance(3500);assert.equal(api.writePair(zh,en,text,source,300,null,'dom').page,2);
 assert.equal(api.writePair(zh,en,text,source,300,null,'new-video').page,1);
});
test('实时整理失败后拒绝在途新片段和后续音频，明确取消后才能重试',async()=>{
 const {api,advance}=fixture();let reject,calls=0,errors=0;
 const live=api.live({send:()=>{calls++;return new Promise((resolve,fail)=>reject=fail);},state:{videoId:'one',generation:1},changed:()=>{},error:()=>errors++,title:()=>''});
 live.add('First sentence.',0);advance(600);live.tick('',1);
 live.add('Second sentence.',2);reject(new Error('429'));await flush();
 for(let i=0;i<4;i++){live.add('More audio '+i,3+i,4+i);advance(15000);live.tick('',10,{audio:true});await flush();}
 assert.equal(calls,1);assert.equal(errors,1);assert.equal(live.waiting,false);
 live.cancel();live.add('Retry.',0);advance(600);live.tick('',1);assert.equal(calls,2);reject(new Error('停止测试'));await flush();
});
test('实时字幕整理后只送译滚动窗口的新词，取消后可重新翻译同一句',async()=>{
 const {api,advance}=fixture(),requests=[];
 const live=api.live({send:async m=>{requests.push(plain(m));return {segments:m.items.map(c=>({sourceIds:[c.id],text:'译文'}))};},state:{videoId:'one',generation:1},changed:()=>{},error:e=>{throw e;},title:()=>''});
 live.add('a b c d',0);advance(6000);live.tick('',6);await flush();
 live.add('c d e f',7);advance(6000);live.tick('',13);await flush();
 assert.equal(requests.length,2);assert.equal(requests[1].items[0].text,'e f');
 live.add('e f',14);advance(6000);live.tick('',20);await flush();assert.equal(requests.length,2);
 live.cancel();live.add('a b c d',0);advance(6000);live.tick('',6);await flush();assert.equal(requests.length,3);assert.equal(requests[2].items[0].text,'a b c d');
});
test('滚动轨重叠裁到下一片，合并句覆盖首片到末片时间且下一句不被遮挡',()=>{
 const {api}=fixture(),items=api.units(cues);assert.deepEqual(plain(items.map(c=>c.end)),[2,4,6,9]);
 const groups=api.groups(items,response);assert.equal(groups[0].start,0);assert.equal(groups[0].end,6);assert.equal(groups[1].start,6);assert.equal(groups[0].text,'Because we need complete sentences.');
});
test('中文句末拆分保留文字与总时间，拼接汉字不插入多余空格',()=>{
 const {api}=fixture(),items=api.units([{id:'x',text:'你好吗？很好！',start:0,end:4}]);assert.equal(items.length,2);assert.equal(items.map(c=>c.text).join(''),'你好吗？很好！');assert.equal(items[0].start,0);assert.equal(items.at(-1).end,4);
 const group=api.groups([{id:'a',text:'因为我',start:0,end:1},{id:'b',text:'们需要',start:1,end:2}],[{sourceIds:['a','b'],text:'因为我们需要'}]);assert.equal(group[0].text,'因为我们需要');
});
test('漏项、重复、乱序、跨大停顿、超过12秒合并均拒绝',()=>{
 const {api}=fixture(),items=api.units(cues);
 for(const ids of [['a','b'],['b','a','c','d'],['a','a','c','d']])assert.throws(()=>api.groups(items,[{sourceIds:ids,text:'测试'}]));
 assert.throws(()=>api.groups([{id:'a',start:0,end:1},{id:'b',start:3,end:4}],[{sourceIds:['a','b'],text:'测试'}]));
 assert.throws(()=>api.groups([{id:'a',start:0,end:7},{id:'b',start:7,end:14}],[{sourceIds:['a','b'],text:'测试'}]));
});
test('一个片段的句尾与下一句开头分开，单词可与后续片段合并，缩写与小数不当作句界',()=>{
 const {api}=fixture(),parts=api.units([{id:'a',text:'Get what you want. Your',start:0,end:4},{id:'b',text:'favorite pizza is ready.',start:4,end:7}]);assert.equal(parts.length,3);assert.equal(parts[0].text,'Get what you want.');assert.equal(parts[1].text,'Your');const grouped=api.groups(parts,[{sourceIds:[parts[0].id],text:'拿到想要的东西'},{sourceIds:[parts[1].id,parts[2].id],text:'你最喜欢的披萨准备好了'}]);assert.equal(grouped[1].text,'Your favorite pizza is ready.');assert.equal(grouped[1].end,7);
 for(const text of ['Dr. Smith likes 3.14 pies.','The U.S. has many stores.','Wait... and continue.'])assert.equal(api.units([{id:'x',text,start:0,end:4}]).length,1);
});
test('预读一次后原cue推进保持完整句，重新创建相同轨数组不取消在途请求',async()=>{
 const {api}=fixture();let finish,calls=0;const state={videoId:'one',generation:1};const controller=api.track({send:()=>{calls++;return new Promise(r=>finish=r);},state,changed:()=>{},error:e=>{throw e;},title:()=>''});controller.set(cues);const pending=controller.prefetch(1);controller.set(cues.map(c=>({...c})));finish({segments:response});await pending;
 for(const t of [0,1,3,5.99])assert.equal(controller.at(t).translation,'因为我们需要完整的句子。');assert.equal(controller.at(6).translation,'然后我们继续。');assert.equal(controller.at(9),null);await controller.prefetch(4);assert.equal(calls,1);
});
test('跳转取消迟到响应，已完成组可复用，字幕正文更新会废弃旧组',async()=>{
 const {api,advance}=fixture();let finish;const state={videoId:'one',generation:1};const c=api.track({send:()=>new Promise(r=>finish=r),state,changed:()=>{},error:e=>{throw e;},title:()=>''});c.set(cues);const p=c.prefetch(1);c.cancel();state.generation++;finish({segments:response});await p;assert.equal(c.count,0);
 advance(1000);const p2=c.prefetch(1);finish({segments:response});await p2;c.cancel();assert.equal(c.at(3).end,6);c.set(cues.map(x=>x.id==='b'?{...x,text:'updated'}:x));assert.equal(c.at(3),null);assert.equal(c.at(7).translation,'然后我们继续。');
});
test('预读批次带前后文，最长一批20项且整组覆盖当前请求',async()=>{
 const {api}=fixture();let sent;const c=api.track({send:async m=>{sent=m;return {segments:m.items.map(c=>({sourceIds:[c.id],text:'译文'}))};},state:{videoId:'one',generation:1},changed:()=>{},error:e=>{throw e;},title:()=> '测试视频'});c.set(Array.from({length:45},(_,i)=>({id:String(i),text:i===10?'Natural end.':'word',start:i,end:i+1})));await c.prefetch(20);assert.ok(sent.items.length<=20);assert.equal(sent.items[0].id,'8');const context=JSON.parse(sent.context);assert.equal(context.before.length,3);assert.equal(context.after.length,3);
});
test('实时滚动字幕去重，稳定后整句显示并按阅读长度延长停留',async()=>{
 const {api,advance}=fixture();let sent;const live=api.live({send:async m=>{sent=m;return {segments:[{sourceIds:m.items.map(c=>c.id),text:'这是一个需要完整呈现的中文句子'}]};},state:{videoId:'one',generation:1},changed:()=>{},error:e=>{throw e;},title:()=>''});live.add('We need',0);advance(200);live.add('We need complete sentences.',1);advance(500);live.tick('',1);await flush();const shown=live.tick('',1);assert.equal(sent.items.length,1);assert.equal(sent.items[0].text,'We need complete sentences.');assert.ok(shown.duration>=2000);advance(shown.duration-1);assert.equal(live.tick('',2).translation,shown.translation);advance(1);assert.equal(live.tick('',3),null);
 assert.equal(api.joinRolling('we need complete sentences','complete sentences to read'),'we need complete sentences to read');
});
test('预取在句末结束批次，把尾部孤词留给下一批后文，不单独翻译',async()=>{
 const {api,advance}=fixture(),requests=[];const c=api.track({send:async m=>{requests.push(m);return {segments:m.items.map(c=>({sourceIds:[c.id],text:'完整短语'}))};},state:{videoId:'one',generation:1},title:()=>'',changed:()=>{},error:e=>{throw e;}});c.set(Array.from({length:24},(_,i)=>({id:String(i),text:i===18?'The sentence ends.':i===19?'Your':'continuing phrase',start:i,end:i+1})));await c.prefetch(0);assert.equal(requests[0].items.length,19);assert.equal(JSON.parse(requests[0].context).after[0],'Your');advance(1000);await c.prefetch(1);assert.equal(requests[1].items[0].text,'Your');assert.equal(requests[1].items[1].text,'continuing phrase');
});
test('音频片段拆成较细时间单元以跨片合并，未完句不会无限等待',async()=>{
 const {api,advance}=fixture();let sent;const live=api.live({send:async m=>{sent=m;return {segments:m.items.map(c=>({sourceIds:[c.id],text:'完整短语'}))};},state:{videoId:'one',generation:1},changed:()=>{},error:e=>{throw e;},title:()=>''});live.add('Because we need a complete sentence',0,7);live.tick('',7,{audio:true});assert.equal(sent,undefined);advance(7000);live.add('that continues in the next audio chunk',7,14);live.tick('',14,{audio:true});assert.equal(sent,undefined);advance(7000);live.tick('',14,{audio:true});await flush();assert.equal(sent.items.length,4);assert.equal(sent.items[0].start,0);assert.equal(sent.items.at(-1).end,14);assert.ok(live.tick('',14,{audio:true}));
});

test('低延迟语音识别后立即送译，保留前句上下文，真实重复发言不误去重',async()=>{
 const {api}=fixture();const sent=[];const live=api.live({send:async m=>{sent.push(m);return {segments:m.items.map(c=>({sourceIds:[c.id],text:'低延迟译文'}))};},state:{videoId:'one',generation:1},changed:()=>{},error:e=>{throw e;},title:()=> '视频标题'});
 live.add('An unfinished phrase',0,2);live.tick('',2,{audio:true,lowLatency:true});assert.equal(sent.length,1);await flush();assert.equal(live.tick('',2,{audio:true,lowLatency:true}).translation,'低延迟译文');
 live.add('An unfinished phrase',2,4);live.tick('',4,{audio:true,lowLatency:true});assert.equal(sent.length,2);assert.equal(JSON.parse(sent[1].context).before[0],'An unfinished phrase');assert.notEqual(sent[0].items[0].id,sent[1].items[0].id);
});

test('翻译慢时继续接收后段ASR，待译音频保留最近8秒并限制展示队列',async()=>{
 const {api}=fixture();let finish;const sent=[];const live=api.live({send:m=>{sent.push(m);return new Promise(r=>finish=()=>r({segments:m.items.map(c=>({sourceIds:[c.id],text:'很长的中文字幕需要适当阅读时间'.repeat(5)}))}));},state:{videoId:'one',generation:1},changed:()=>{},error:e=>{throw e;},title:()=>''});
 live.add('First',0,2);live.tick('',2,{audio:true,lowLatency:true});
 for(let i=1;i<=10;i++){live.add('Phrase '+i,i*2,i*2+2);live.tick('',i*2+2,{audio:true,lowLatency:true});}assert.equal(sent.length,1);assert.ok(live.skipped>0);
 finish();await flush();live.tick('',22,{audio:true,lowLatency:true});assert.equal(sent.length,2);assert.equal(sent[1].items[0].start,14);assert.equal(sent[1].items.at(-1).end,22);
 finish();await flush();const current=live.tick('',22,{audio:true,lowLatency:true});assert.ok(current);assert.ok(current.duration<=6000);assert.ok(live.skipped>=7);
 live.cancel();assert.equal(live.skipped,0);assert.equal(live.waiting,false);assert.equal(live.tick('',23,{audio:true,lowLatency:true}),null);
});
test('实时整理取消后拒绝旧视频结果，下一组按顺序留在队列',async()=>{
 const {api,advance}=fixture();let finish;const state={videoId:'one',generation:1};const live=api.live({send:()=>new Promise(r=>finish=r),state,changed:()=>{},error:e=>{throw e;},title:()=>''});live.add('A.',0);advance(500);live.tick('',1);live.cancel();state.generation++;finish({segments:[{sourceIds:['live:0'],text:'旧句'}]});await flush();assert.equal(live.tick('',2),null);
 live.add('B.',2);live.add('C.',3);advance(500);live.tick('',4);finish({segments:[{sourceIds:['live:1'],text:'第一句'},{sourceIds:['live:2'],text:'第二句'}]});await flush();assert.equal(live.tick('',4).translation,'第一句');advance(2000);assert.equal(live.tick('',6).translation,'第二句');
});
test('排版尽量避免最后一行单字且英文单词不拆开，显示标点转空格',()=>{
 const {api}=fixture(),measure=s=>s.length;const rows=api.lines('一二三四五六七八九十甲',5,measure).split('\n');assert.ok(rows.every(r=>r.replace(/\s/g,'').length>1));assert.ok(rows.every(r=>r.length<=5));assert.equal(rows.join('').replace(/\s/g,''),'一二三四五六七八九十甲');assert.equal(api.lines('complete sentences, please.',14,measure),'complete\nsentences\nplease');
});
