(() => {
  'use strict';
  const core=globalThis.YTZCore;
  const terminal=text=>/[.!?。！？]["'”’）)]*\s*$/.test(text);
  function sentenceParts(text){
    const parts=[];let start=0;
    for(const m of text.matchAll(/[.!?。！？]+["'”’）)]*/g)){
      const stop=m.index+m[0].length,mark=m[0][0],next=text[stop]||'';
      if(/[.!?]/.test(mark)&&next&&!/\s/.test(next))continue;
      if(mark==='.'){
        const prefix=text.slice(0,m.index),word=prefix.match(/([A-Za-z]+)$/)?.[1]||'';
        if(word.length===1||/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)$/i.test(word))continue;
        if(m[0].startsWith('..')&&next&& !/^\s+[A-Z]/.test(text.slice(stop)))continue;
      }
      parts.push(text.slice(start,stop));start=stop;
    }
    if(text.slice(start).trim())parts.push(text.slice(start));return parts.length?parts:[text];
  }
  function units(cues) {
    const result=[];
    for(let i=0;i<cues.length;i++){
      const c=cues[i],next=cues[i+1];
      const end=next&&next.start>c.start?Math.min(c.end,next.start):c.end;
      if(end<=c.start)continue;
      // Sentence punctuation remains available here; stripping is display only.
      const parts=sentenceParts(core.cleanText(c.text));
      const total=parts.reduce((n,p)=>n+p.length,0);let at=c.start;
      parts.forEach((p,j)=>{const stop=j===parts.length-1?end:at+(end-c.start)*p.length/total;result.push({id:parts.length===1?c.id:c.id+':part'+j,text:core.cleanText(p),start:at,end:stop});at=stop;});
    }
    return result;
  }
  function groups(items,response) {
    if(!Array.isArray(response)||!response.length)throw new Error('完整语句结果为空');
    let at=0;const result=[];
    for(const s of response){
      if(!Array.isArray(s?.sourceIds)||!s.sourceIds.length||typeof s.text!=='string'||!core.cleanText(s.text))throw new Error('完整语句返回格式无效');
      const source=items.slice(at,at+s.sourceIds.length);
      if(source.length!==s.sourceIds.length||source.some((c,i)=>c.id!==s.sourceIds[i]))throw new Error('完整语句漏项、重复或顺序错误');
      if(source.length>1&&(source.at(-1).end-source[0].start>12.001||source.some((c,i)=>i&&c.start-source[i-1].end>1.201)))throw new Error('完整语句跨越过长时间或停顿');
      const original=source.reduce((text,c)=>text+(text&&!( /\p{Script=Han}$/u.test(text)&&/^\p{Script=Han}/u.test(c.text))?' ':'')+c.text,'');
      result.push({id:'semantic:'+source[0].id,start:source[0].start,end:Math.max(...source.map(c=>c.end)),text:original,translation:core.cleanText(s.text),sourceIds:[...s.sourceIds],signatures:source.map(signature)});at+=source.length;
    }
    if(at!==items.length)throw new Error('完整语句漏译了字幕');
    for(let i=0;i<result.length-1;i++)result[i].end=Math.min(result[i].end,result[i+1].start);
    return result;
  }
  const signature=c=>JSON.stringify([c.id,c.start,c.end,c.text]);
  function track({send,state,changed,error,title}) {
    let raw=null,source=[],completed=[],covered=new Set(),busy=false,revision=0,lastAt=0;
    function set(cues){
      if(cues===raw)return;raw=cues;const next=units(cues);
      // Track APIs may recreate the array when the active cue changes.
      if(next.length===source.length&&next.every((c,i)=>signature(c)===signature(source[i])))return;
      source=next;revision++;busy=false;
      const map=new Map(source.map(c=>[c.id,signature(c)]));
      completed=completed.filter(c=>c.sourceIds.every((id,i)=>map.get(id)===c.signatures[i]));covered=new Set(completed.flatMap(c=>c.sourceIds));
    }
    function cancel(clear=false){revision++;busy=false;if(clear){raw=null;source=[];completed=[];covered.clear();}}
    function at(time){return core.cueAt(completed,time);}
    async function prefetch(time){
      if(busy||Date.now()-lastAt<500||!source.length)return;
      const candidates=source.filter(c=>!covered.has(c.id)&&c.end>time-12&&c.start<=time+90);
      if(!candidates.length)return;
      const first=source.indexOf(candidates[0]);let items=[],length=0;
      for(let i=first;i<source.length&&items.length<core.maxBatch;i++){
        const c=source[i];if(covered.has(c.id)||c.start>time+90||length+c.text.length>16000)break;
        items.push(c);length+=c.text.length;
      }
      // Prefer a natural batch boundary; a hard batch cap is never treated as a sentence end.
      if(items.length===core.maxBatch){const stop=items.findLastIndex((c,i)=>terminal(c.text)||(items[i+1]&&items[i+1].start-c.end>1.2));if(stop>=0)items=items.slice(0,stop+1);}
      if(!items.length)return;
      const context=JSON.stringify({title:title(),before:source.slice(Math.max(0,first-3),first).map(c=>c.text),after:source.slice(first+items.length,first+items.length+3).map(c=>c.text)}).slice(0,4000);
      const token=revision,s={videoId:state.videoId,generation:state.generation};busy=true;lastAt=Date.now();changed('正在整理完整语句…');
      try{
        const r=await send({type:'TRANSLATE_SEGMENTS',...s,items,context});
        if(token!==revision||!core.isCurrent(s,state))return;
        const ready=groups(items,r.segments);completed.push(...ready);completed.sort((a,b)=>a.start-b.start);
        for(let i=0;i<completed.length-1;i++)completed[i].end=Math.min(completed[i].end,completed[i+1].start);
        ready.forEach(c=>c.sourceIds.forEach(id=>covered.add(id)));changed('');
      }catch(e){if(token===revision&&core.isCurrent(s,state))error(e);}
      finally{if(token===revision){busy=false;changed();}}
    }
    return {set,cancel,at,prefetch,get count(){return completed.length;},get pending(){return busy;}};
  }
  function joinRolling(previous,current){
    if(current.startsWith(previous))return current;
    if(previous.startsWith(current))return previous;
    const a=previous.split(/\s+/),b=current.split(/\s+/);let common=0;
    for(let n=2;n<=Math.min(a.length,b.length);n++)if(a.slice(-n).join(' ')===b.slice(0,n).join(' '))common=n;
    return previous+' '+b.slice(common).join(' ');
  }
  function live({send,state,changed,error,title}){
    let records=[],last='',flushedTail='',changedAt=0,firstAt=0,revision=0,busy=false,serial=0,queue=[],display=null,history=[],blocked=false,fastAudio=false,skipped=0;
    function cancel(){revision++;records=[];last='';flushedTail='';busy=false;queue=[];display=null;history=[];blocked=false;fastAudio=false;skipped=0;}
    function add(text,time,end=null){
      if(blocked)return;
      text=core.cleanText(text);if(!text||(end===null&&text===last))return;
      const rawText=text;
      if(end===null&&flushedTail){
        if(flushedTail===text||flushedTail.endsWith(' '+text)||flushedTail.startsWith(text+' ')){last=rawText;return;}
        if(text.startsWith(flushedTail))text=text.slice(flushedTail.length).trim();
        else {const joined=joinRolling(flushedTail,text);if(joined!==flushedTail+' '+text)text=joined.slice(flushedTail.length).trim();}
        if(!text){last=rawText;return;}
      }
      const now=Date.now();if(!records.length)firstAt=now;
      const previous=records.at(-1);
      if(end!==null&&Number.isFinite(end)&&end>time){
        const tokens=[...text.matchAll(/\p{Script=Han}|[^\s\p{Script=Han}]+/gu)],count=Math.max(1,Math.min(tokens.length,Math.ceil((end-time)/3.5)));
        for(let j=0;j<count;j++){const first=Math.floor(j*tokens.length/count),next=Math.floor((j+1)*tokens.length/count);records.push({id:'live:'+serial++,text:text.slice(tokens[first].index,tokens[next]?.index??text.length).trim(),start:time+(end-time)*j/count,end:time+(end-time)*(j+1)/count});}
        last=text;changedAt=now;return;
      }
      if(previous&&previous.text.startsWith(text)&&end===null){last=rawText;return;}
      if(previous&&text.startsWith(previous.text)&&end===null){previous.text=text;previous.rawText=rawText;previous.end=Math.max(previous.end,time+.1);}
      else if(previous&&end===null&&joinRolling(previous.text,text)!==previous.text+' '+text){previous.text=joinRolling(previous.text,text);previous.rawText=rawText;previous.end=Math.max(previous.end,time+.1);}
      else{
        if(previous)previous.end=Math.max(previous.start+.05,end===null?time:Math.min(previous.end,time));
        records.push({id:'live:'+serial++,text,start:Math.max(0,time),end:end??time+.1,...(end===null?{rawText}:{})});
      }
      last=rawText;changedAt=now;
    }
    async function flush(){
      if(blocked||busy||!records.length)return;
      const batch=records.splice(0,core.maxBatch),items=batch.map(({rawText,...item})=>item),token=revision,s={videoId:state.videoId,generation:state.generation};busy=true;
      if(batch.at(-1).rawText)flushedTail=batch.at(-1).rawText;
      const context=JSON.stringify({title:title(),before:history.slice(-2),after:records.slice(0,2).map(c=>c.text)}).slice(0,4000);
      changed('正在等待并整理完整语句…');
      try{
        const r=await send({type:'TRANSLATE_SEGMENTS',...s,items,context});if(token!==revision||!core.isCurrent(s,state))return;
        const ready=groups(items,r.segments);
        history.push(...items.map(c=>c.text));history=history.slice(-3);
        for(const c of ready)queue.push({...c,duration:(fastAudio?Math.min(6,Math.max(2,core.subtitleText(c.translation).length/10)):Math.min(12,Math.max(c.end-c.start,2,core.subtitleText(c.translation).length/7)))*1000});
        if(fastAudio)while(queue.length>1&&queue.reduce((n,c)=>n+c.duration,0)>8000){queue.shift();skipped++;}
        changed('完整语句 · 延迟显示');
      }catch(e){if(token===revision&&core.isCurrent(s,state)){blocked=true;records=[];queue=[];display=null;error(e);}}
      finally{if(token===revision){busy=false;changed();}}
    }
    function tick(text,time,{audio=false,lowLatency=false}={}){
      fastAudio=audio&&lowLatency;
      const now=Date.now();
      if(fastAudio){
        const cutoff=(records.at(-1)?.end??time)-8;
        while(records.length>1&&records[0].end<=cutoff){records.shift();skipped++;}
        while(queue.length&&time-queue[0].end>20){queue.shift();skipped++;}
        if(display&&time-display.end>20){display=null;skipped++;}
      }
      if(display&&display.until<=now)display=null;
      if(!display&&queue.length){const next=queue.shift();display={...next,until:now+next.duration};}
      if(!blocked&&records.length&&!busy){
        const tail=records.at(-1),quiet=now-changedAt>=1200,aged=now-firstAt>=6000;
        // ASR arrives in slow chunks: an unfinished tail may wait for the next chunk.
        if(fastAudio||(terminal(tail.text)&&now-changedAt>=500)||(!audio&&quiet)||aged&&(!audio||now-changedAt>=9000||now-firstAt>=14000)||records.length>=core.maxBatch)flush();
      }
      return display;
    }
    return {add,cancel,tick,get busy(){return busy;},get waiting(){return records.length>0||busy;},get skipped(){return skipped;}};
  }
  function wordTokens(text){
    const result=[],split=value=>typeof Intl!=='undefined'&&Intl.Segmenter?[...new Intl.Segmenter('zh',{granularity:'word'}).segment(value)].map(s=>s.segment):value.match(/\s+|[^\s]/gu)||[];
    let at=0;
    // Keep numerical expressions, contractions and common technical names
    // together even when Intl.Segmenter treats their symbols as boundaries.
    for(const m of text.matchAll(/[+-]?\d+(?:[.:]\d+)*(?:%|°[A-Za-z]+)?|[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*(?:\+\+|#)?/gu)){
      result.push(...split(text.slice(at,m.index)),m[0]);at=m.index+m[0].length;
    }
    result.push(...split(text.slice(at)));return result;
  }
  function wrapClause(text,width,measure){
    const words=wordTokens(text);
    // Very long identifiers/URLs must also fit a narrow player. Ordinary
    // words remain intact; only an individually oversized token is split.
    const tokens=words.flatMap(word=>measure(word.trim())<=width?[word]:typeof Intl!=='undefined'&&Intl.Segmenter?[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(word)].map(s=>s.segment):Array.from(word));
    // Choose the whole set of breaks together instead of filling each row to
    // its edge. Penalize dangling modifiers and very short remainder rows.
    const costs=Array(tokens.length+1).fill(Infinity),stops=Array(tokens.length);costs[tokens.length]=0;
    for(let i=tokens.length-1;i>=0;i--){
      let row='';
      for(let j=i;j<tokens.length;j++){
        row+=tokens[j];const value=row.trim(),size=measure(value);
        if(size>width&&j>i)break;
        if(!value)continue;
        const remaining=tokens.slice(j+1,j+5).join('').trimStart();
        let penalty=100+15*(1-Math.min(1,size/width))**2;
        if(size<width*.2)penalty+=100;
        if(j+1<tokens.length){
          if(/[的地得把被与和及或在向对将很更最]$/u.test(value)||/\b(?:a|an|the|of|to|with|for|and|or|is|are)$/i.test(value))penalty+=1000;
          if(/^(?:但是|不过|然而|然后|因此|所以|而且|并且|接下来|最后|因为|请)/u.test(remaining))penalty-=35;
        }
        const cost=penalty+costs[j+1];if(cost<costs[i]){costs[i]=cost;stops[i]=j+1;}
      }
    }
    const rows=[];for(let i=0;i<tokens.length;){const next=stops[i]??i+1;const row=tokens.slice(i,next).join('').trim();if(row)rows.push(row);i=next;}
    return rows;
  }
  function lines(text,width,measure){
    const value=core.cleanText(text),display=core.subtitleText(value);if(!display||measure(display)<=width)return display;
    const rows=[];let pending='';
    const push=()=>{if(pending)rows.push(pending);pending='';};
    // Keep sentence/clause punctuation until actual row boundaries are chosen.
    // Chinese spaces also delimit clauses in captions whose punctuation was
    // already removed upstream; English spaces still delimit ordinary words.
    for(const sentence of sentenceParts(value))for(const clause of sentence.split(/(?<=[，,;；])\s*|(?<=[：:])(?!\d)\s*|(?<=\p{Script=Han})\s+(?=\p{Script=Han})/u)){
      const part=core.subtitleText(clause);if(!part)continue;
      if(measure(part)>width){push();rows.push(...wrapClause(part,width,measure));continue;}
      const joined=pending?pending+' '+part:part;
      if(pending&&measure(joined)>width)push();
      pending=pending?pending+' '+part:part;
    }
    push();return rows.join('\n');
  }
  const canvases=new WeakMap();
  function pages(text,width,measure,maxRows=2){
    const wrapped=lines(text,width,measure);if(!wrapped)return [];
    const rows=wrapped.split('\n'),result=[];
    for(let i=0;i<rows.length;i+=maxRows)result.push(rows.slice(i,i+maxRows).join('\n'));
    return result;
  }
  function metrics(node,width){
    if(!node.ownerDocument?.createElement)return {limit:node.className==='original'?50:26,measure:s=>Array.from(s).reduce((n,c)=>n+(/[^\u0000-\u007f]/u.test(c)?1:.5),0),font:'fixture'};
    let canvas=canvases.get(node.ownerDocument);if(!canvas){canvas=node.ownerDocument.createElement('canvas');canvases.set(node.ownerDocument,canvas);}const context=canvas.getContext('2d'),style=getComputedStyle(node);
    const size=Number.parseFloat(style.fontSize)||20,limit=Math.max(size*2,Math.min(width-20,size*(node.className==='original'?50:26)));
    const font=style.font||`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    // Each measuring closure restores its own font: both language rows share
    // one canvas but may have different font sizes.
    return {limit,font,measure:s=>{context.font=font;return context.measureText(s).width;}};
  }
  function captionProgress(caption,time,now=Date.now()){
    if(!caption)return null;
    if(Number.isFinite(caption.until)){const duration=caption.duration||14000;return Math.max(0,Math.min(1,(now-caption.until+duration)/duration));}
    if(Number.isFinite(caption.start)&&Number.isFinite(caption.end)&&caption.end>caption.start&&Number.isFinite(time))return Math.max(0,Math.min(1,(time-caption.start)/(caption.end-caption.start)));
    return null;
  }
  function selectPair(chinese,original,progress){
    const count=Math.max(1,chinese.length,original.length),index=Math.max(0,Math.min(count-1,Math.floor((Number.isFinite(progress)?progress:0)*count)));
    const pick=list=>list.length?list[Math.min(list.length-1,Math.floor(index*list.length/count))]:'';
    return {chinese:pick(chinese),original:pick(original),page:index+1,pages:count};
  }
  const presentations=new WeakMap();
  function writePair(zh,original,chinese,source,width,progress=null,key=''){
    const a=metrics(zh,width),b=metrics(original,width),signature=JSON.stringify([chinese,source,a.limit,b.limit,a.font,b.font,key]);
    let plan=presentations.get(zh);
    if(plan?.signature!==signature){plan={signature,chinese:pages(chinese,a.limit,a.measure),original:pages(source,b.limit,b.measure),startedAt:Date.now()};presentations.set(zh,plan);}
    const count=Math.max(1,plan.chinese.length,plan.original.length);
    const shown=selectPair(plan.chinese,plan.original,progress??(Date.now()-plan.startedAt)/(count*3000));
    for(const [node,text,metric] of [[zh,shown.chinese,a],[original,shown.original,b]]){node.style.maxWidth=metric.limit+'px';node.style.overflowWrap='normal';node.style.whiteSpace='pre';node.textContent=text;}
    return shown;
  }
  function write(node,text,width){
    if(!node.ownerDocument?.createElement){core.writeCaption(node,core.subtitleText(text));return;}
    let canvas=canvases.get(node.ownerDocument);if(!canvas){canvas=node.ownerDocument.createElement('canvas');canvases.set(node.ownerDocument,canvas);}const context=canvas.getContext('2d');
    const style=getComputedStyle(node);context.font=style.font;
    const limit=Math.max(Number.parseFloat(style.fontSize)*2,Math.min(width-20,Number.parseFloat(style.fontSize)*(node.className==='original'?50:26)));
    node.style.maxWidth=limit+'px';node.style.overflowWrap='normal';node.style.whiteSpace='pre';node.textContent=lines(text,limit,s=>context.measureText(s).width);
  }
  globalThis.YTZSemantic=Object.freeze({units,groups,track,live,lines,write,pages,selectPair,captionProgress,writePair,joinRolling});
})();
