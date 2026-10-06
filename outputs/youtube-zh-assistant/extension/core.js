(() => {
  'use strict';
  const maxBatch = 20;
  const appearanceDefaults = Object.freeze({subtitlePosition:'bottom',subtitleOffset:14,fontSize:20,backgroundOpacity:78,subtitleX:50,subtitleY:75,subtitleColor:'#ffffff',originalColor:'#dedede'});
  function appearance(value = {}) {
    const number = (key,min,max) => typeof value[key]==='number' && Number.isFinite(value[key]) ? Math.round(Math.min(max,Math.max(min,value[key]))) : appearanceDefaults[key];
    const color=key=>typeof value[key]==='string'&&/^#[0-9a-f]{6}$/i.test(value[key])?value[key].toLowerCase():appearanceDefaults[key];
    return {subtitlePosition:['top','custom'].includes(value.subtitlePosition)?value.subtitlePosition:'bottom',subtitleOffset:number('subtitleOffset',0,70),fontSize:number('fontSize',14,48),backgroundOpacity:number('backgroundOpacity',0,100),subtitleX:number('subtitleX',0,100),subtitleY:number('subtitleY',0,100),subtitleColor:color('subtitleColor'),originalColor:color('originalColor')};
  }
  const overlayCSS = ':host{position:absolute;left:5%;right:5%;bottom:var(--ytz-offset,14%);z-index:2147483647;pointer-events:none;text-align:center;font:var(--ytz-font,20px)/1.45 Arial,"Microsoft YaHei",sans-serif;color:white}:host([data-position="top"]){top:var(--ytz-offset,14%);bottom:auto}:host([data-delayed][data-position="bottom"]){bottom:min(70%,calc(var(--ytz-offset,14%) + 18%))}p{margin:3px auto;width:fit-content;max-width:100%;background:rgba(0,0,0,var(--ytz-opacity,.78));padding:4px 10px;border-radius:7px;white-space:pre-wrap;overflow-wrap:anywhere}p:empty{display:none}.original{font-size:var(--ytz-original,16px);color:#dedede}.status{font-size:12px;color:#f4dba4}';
  function applyAppearance(host,value) {
    const settings=appearance(value);host.dataset.position=settings.subtitlePosition;
    if(settings.subtitlePosition!=='custom')for(const key of ['left','right','top','bottom','width','max-width','transform'])host.style.removeProperty(key);
    for(const [key,val] of Object.entries({'--ytz-offset':settings.subtitleOffset+'%','--ytz-font':settings.fontSize+'px','--ytz-original':Math.max(12,Math.round(settings.fontSize*.8))+'px','--ytz-opacity':String(settings.backgroundOpacity/100),'--ytz-color':settings.subtitleColor,'--ytz-original-color':settings.originalColor}))host.style.setProperty(key,val);
  }
  // Only the visible caption lines intercept input; the surrounding video remains clickable.
  const dragCSS = 'p{pointer-events:auto;cursor:grab;touch-action:none;user-select:none;color:var(--ytz-color,#ffffff)}p.original{color:var(--ytz-original-color,#dedede)}p.status{color:#f4dba4}:host([data-dragging]) p{cursor:grabbing}:host([data-position="custom"]){bottom:auto;right:auto}';
  function installSubtitleDrag(host,state,getBounds,save,interactionRoot=host) {
    let active=null;
    const update=()=>{
      if(state.subtitlePosition!=='custom')return;
      const b=getBounds();if(!b||b.width<=0||b.height<=0)return;
      host.dataset.position='custom';
      host.style.width='max-content';host.style.maxWidth=b.width*.9+'px';host.style.right='auto';host.style.bottom='auto';host.style.transform='translate(-50%,-50%)';
      const r=host.getBoundingClientRect(),hx=Math.min(r.width/2,b.width/2),hy=Math.min(r.height/2,b.height/2);
      const x=Math.min(b.width-hx,Math.max(hx,b.width*state.subtitleX/100)),y=Math.min(b.height-hy,Math.max(hy,b.height*state.subtitleY/100));
      host.style.left=(b.left+x)+'px';host.style.top=(b.top+y)+'px';
    };
    const stop=e=>{e.preventDefault();e.stopPropagation();};
    const down=e=>{
      if(active||e.button!==0||e.isPrimary===false||!e.composedPath().some(n=>n.tagName==='P'))return;
      const b=getBounds();if(!b||b.width<=0||b.height<=0)return;
      const r=host.getBoundingClientRect();
      active={id:e.pointerId,x:e.clientX,y:e.clientY,cx:r.left+r.width/2,cy:r.top+r.height/2,moved:false,previous:appearance(state)};
      host.setPointerCapture(e.pointerId);stop(e);
    };
    const move=e=>{
      if(!active||e.pointerId!==active.id)return;stop(e);
      const dx=e.clientX-active.x,dy=e.clientY-active.y;if(!active.moved&&Math.hypot(dx,dy)<4)return;
      const b=getBounds();if(!b||b.width<=0||b.height<=0)return;
      active.moved=true;host.dataset.dragging='';state.subtitlePosition='custom';
      const view=host.parentElement?.getBoundingClientRect();
      // Bounds are local for an absolute overlay and viewport based for a fixed one.
      const ox=host.style.position==='fixed'?0:(view?.left||0),oy=host.style.position==='fixed'?0:(view?.top||0);
      state.subtitleX=Math.min(100,Math.max(0,(active.cx+dx-ox-b.left)/b.width*100));
      state.subtitleY=Math.min(100,Math.max(0,(active.cy+dy-oy-b.top)/b.height*100));update();
    };
    const finish=e=>{
      if(!active||e.pointerId!==active.id)return;stop(e);
      const done=active;active=null;delete host.dataset.dragging;
      if(host.hasPointerCapture(done.id))host.releasePointerCapture(done.id);
      if(e.type!=='pointerup'){Object.assign(state,done.previous);applyAppearance(host,state);update();return;}
      if(done.moved)save({subtitlePosition:'custom',subtitleX:state.subtitleX,subtitleY:state.subtitleY});
    };
    const listeners={pointerdown:down,pointermove:move,pointerup:finish,pointercancel:finish,lostpointercapture:finish,click:stop,dblclick:stop};
    const target=name=>name==='pointerdown'?interactionRoot:host;
    for(const [name,fn]of Object.entries(listeners))target(name).addEventListener(name,fn);
    host.title='按住字幕拖动，松开后自动保存位置';
    return {update,cleanup(){for(const [name,fn]of Object.entries(listeners))target(name).removeEventListener(name,fn);}};
  }
  function siteOrigin(value) {
    try {const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password && !['localhost','127.0.0.1','[::1]'].includes(url.hostname) ? url.origin : null;}catch{return null;}
  }
  function pageKey(value) {try {const url=new URL(value);return 'web:'+url.origin+url.pathname+url.search;}catch{return '';}}
  function sitePatterns(value) {
    const origin=siteOrigin(value);if(!origin)return [];
    const patterns=[origin+'/*'],host=new URL(origin).hostname;
    if(host==='vimeo.com'||host==='www.vimeo.com')patterns.push('https://player.vimeo.com/*');
    if(host==='www.ted.com'||host==='ted.com')patterns.push('https://embed.ted.com/*');
    if(host==='www.dailymotion.com'||host==='dailymotion.com')patterns.push('https://geo.dailymotion.com/player/*');
    if(host==='www.khanacademy.org'||host==='khanacademy.org')patterns.push('https://www.youtube-nocookie.com/embed/*');
    return [...new Set(patterns)];
  }
  function siteMatches(value,patterns){
    const origin=siteOrigin(value);if(!origin)return false;
    const address=origin+new URL(value).pathname;
    return patterns.some(pattern=>pattern.endsWith('*')&&address.startsWith(pattern.slice(0,-1)));
  }
  function parseTextTrack(track) {
    if(!track || !['subtitles','captions'].includes(track.kind) || !track.cues)return [];
    const text=cue=>{try{const rendered=cue.getCueAsHTML?.().textContent;if(typeof rendered==='string')return rendered;}catch{}const entities={amp:'&',lt:'<',gt:'>',nbsp:' ',lrm:'\u200e',rlm:'\u200f'};return String(cue.text||'').replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g,(_,name)=>entities[name]);};
    const occurrences=new Map();
    return Array.from(track.cues).slice(0,25000).filter(c=>Number.isFinite(c.startTime)&&c.startTime>=0&&Number.isFinite(c.endTime)&&c.endTime>c.startTime).map(c=>{
      const value=cleanText(text(c));let a=2166136261,b=5381;
      for(let i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b,33)^value.charCodeAt(i);}
      const key=`web:${c.startTime}:${c.endTime}:${(a>>>0).toString(36)}:${(b>>>0).toString(36)}`;
      const count=occurrences.get(key)||0;occurrences.set(key,count+1);
      return {id:key+':'+count,start:c.startTime,end:c.endTime,text:value};
    }).filter(c=>c.text).sort((a,b)=>a.start-b.start);
  }
  function cleanText(value) {
    return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  }
  function parseJSON3(data) {
    if (!Array.isArray(data?.events)) throw new Error('字幕不是 JSON3 格式');
    const cues = [];
    for (const e of data.events.slice(0, 50000)) {
      if (!Array.isArray(e.segs) || !Number.isFinite(e.tStartMs) || e.tStartMs < 0) continue;
      const text = cleanText(e.segs.map(s => typeof s.utf8 === 'string' ? s.utf8 : '').join(''));
      if (!text) continue;
      const start = e.tStartMs / 1000;
      const end = start + Math.min(60, Math.max(0.05, (Number(e.dDurationMs) || 3000) / 1000));
      const prev = cues[cues.length - 1];
      if (prev && (prev.start === start || (e.aAppend === 1 && start <= prev.end))) {
        prev.text = cleanText(prev.text + ' ' + text); prev.end = Math.max(prev.end, end);
      } else cues.push({start, end, text});
    }
    cues.sort((a, b) => a.start - b.start);
    return cues.map((cue, i) => ({...cue, id: String(i)}));
  }
  function cueAt(cues, time) {
    if (!Number.isFinite(time)) return null;
    let low = 0, high = cues.length - 1, found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].start <= time) { found = mid; low = mid + 1; } else high = mid - 1;
    }
    return found >= 0 && time < cues[found].end ? cues[found] : null;
  }
  function parseTranscript(segments, duration) {
    if (!Array.isArray(segments) || !segments.length || segments.length > 25000 || !Number.isFinite(duration) || duration<=0) return [];
    const sorted = segments.filter(s=>Number.isFinite(s?.start) && s.start>=0 && s.start<duration && typeof s.text==='string' && cleanText(s.text)).map(s=>({...s,text:cleanText(s.text)})).sort((a,b)=>a.start-b.start);
    if (sorted.length!==segments.length || sorted[0].start>20 || sorted.at(-1).start<Math.max(0,duration-30)) return [];
    return sorted.map((s,i)=>({id:`transcript:${i}`,start:s.start,end:Math.min(duration,s.start+60,Number.isFinite(s.end)&&s.end>s.start?s.end:sorted[i+1]?.start??duration),text:s.text})).filter(s=>s.end>s.start);
  }
  function lookAhead(cues, time, translated, pending, seconds = 90) {
    const result = []; let length = 0;
    for (const cue of cues) {
      if (cue.end <= time || cue.start > time + seconds || translated.has(cue.id) || pending.has(cue.id)) continue;
      if (result.length >= maxBatch || length + cue.text.length > 16000) break;
      result.push({id: cue.id, text: cue.text}); length += cue.text.length;
    }
    return result;
  }
  function isCurrent(snapshot, state) {
    return snapshot.videoId === state.videoId && snapshot.generation === state.generation;
  }
  function validateTrack(raw, videoId) {
    if (!raw || typeof raw.baseUrl !== 'string' || raw.baseUrl.length > 8000 || !/^[\w-]{11}$/.test(videoId)) return null;
    try {
      const url = new URL(raw.baseUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'www.youtube.com' || url.port || url.username || url.password || url.pathname !== '/api/timedtext' || url.searchParams.get('v') !== videoId) return null;
      url.searchParams.set('fmt', 'json3'); if (!raw.native) url.searchParams.delete('tlang');
      return {baseUrl: url.href, languageCode: String(raw.languageCode || '').slice(0, 30), kind: raw.kind === 'asr' ? 'asr' : '', name: cleanText(raw.name).slice(0, 100)};
    } catch { return null; }
  }
  function writeCaption(node, text) { node.textContent = cleanText(text); }
  function subtitleText(text) {
    const value=cleanText(text);
    return value.replace(/[.,;:!?，。、；：！？…—–「」『』“”‘’（）()[\]【】《》〈〉｛｝{}«»‹›"']+/gu,(mark,at)=>{
      // Keep decimal points and contractions: they are part of the word/number.
      const before=value[at-1]||'',after=value[at+mark.length]||'';
      if(mark==='.'&&/\d/.test(before)&&/\d/.test(after))return mark;
      if((mark===':'||mark==='：')&&/\d/.test(before)&&/\d/.test(after))return mark;
      if((mark==="'"||mark==='’')&&/[a-z]/i.test(before)&&/[a-z]/i.test(after))return mark;
      return ' ';
    }).replace(/\s+/g,' ').trim();
  }
  function captionStatus() {
    // The video overlay is reserved for subtitles. Keep processing state in
    // the controllers, but never render it as a third subtitle line.
    return '';
  }
  function captionSegments(document) {
    return [...document.querySelectorAll('.ytp-caption-segment')].filter(node => {
      // YouTube's transient CC language/settings hint also uses caption-segment.
      const window = node.closest('.caption-window');
      return window && !window.classList.contains('ytp-caption-window-top') && !node.closest('.ytp-caption-window-top, .ytp-caption-settings, .ytp-settings-menu');
    });
  }
  globalThis.YTZCore = Object.freeze({maxBatch, appearanceDefaults,appearance,overlayCSS:overlayCSS+dragCSS,applyAppearance,installSubtitleDrag,siteOrigin,sitePatterns,siteMatches,pageKey,parseTextTrack,cleanText, parseJSON3, parseTranscript, cueAt, lookAhead, isCurrent, validateTrack, writeCaption, subtitleText, captionStatus, captionSegments});
})();
