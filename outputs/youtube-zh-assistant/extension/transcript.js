(() => {
  'use strict';
  // Read the data already rendered by YouTube's own transcript UI. No copied
  // cookies, generated proof tokens, intercepted fetches, or private API replay.
  let recovery = null, cached = null;
  const attempted = new Set();
  const videoNow = () => new URL(location.href).searchParams.get('v') || '';
  const active = task => recovery === task && videoNow() === task.videoId;
  function cancel() { if (recovery?.timer) clearTimeout(recovery.timer); recovery = null; }
  function readPanel(videoId) {
    const watch = document.querySelector('ytd-watch-flexy');
    if (watch?.getAttribute('video-id') !== videoId) return null;
    for (const panel of document.querySelectorAll('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]')) {
      const root = panel.data?.content;
      if (!root) continue;
      const stack = [root], seen = new WeakSet(), segments = [];
      let count = 0, paginated = false;
      while (stack.length && ++count <= 100000) {
        const value = stack.pop();
        if (!value || typeof value !== 'object' || seen.has(value)) continue;
        seen.add(value);
        const modern = value.transcriptSegmentViewModel, legacy = value.transcriptSegmentRenderer;
        if (modern && typeof modern.simpleText === 'string' && typeof modern.timestamp === 'string') {
          const parts = modern.timestamp.split(':').map(Number);
          if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(modern.timestamp) && parts.slice(1).every(n=>n<60)) {
            segments.push({start:parts.reduce((a,n)=>a*60+n,0),text:modern.simpleText.slice(0,4000),precision:'seconds'});
          }
        } else if (legacy && Number.isFinite(Number(legacy.startMs)) && Number.isFinite(Number(legacy.endMs))) {
          const text = legacy.snippet?.simpleText ?? legacy.snippet?.runs?.map(r=>r.text||'').join('');
          if (typeof text === 'string') segments.push({start:Number(legacy.startMs)/1000,end:Number(legacy.endMs)/1000,text:text.slice(0,4000),precision:'milliseconds'});
        }
        if (value.continuationItemRenderer) paginated = true;
        for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
      }
      if (count > 100000 || paginated || segments.length > 25000 || !segments.length) continue;
      segments.sort((a,b)=>a.start-b.start);
      const duration = document.querySelector('video')?.duration;
      if (!Number.isFinite(duration) || duration <= 0 || segments[0].start > 20 || segments.at(-1).start < Math.max(0,duration-30)) continue;
      return {segments,duration,languageCode:'und',precision:segments.some(s=>s.precision==='seconds')?'seconds':'milliseconds'};
    }
    return null;
  }
  function recover(task) {
    if (!active(task)) return;
    const data = readPanel(task.videoId);
    if (data) {
      cached={videoId:task.videoId,data};
      window.postMessage({source:'ytz-transcript-captions-v1',videoId:task.videoId,generation:task.generation,...data},location.origin);
      cancel(); return;
    }
    if (Date.now()-task.started >= 20000) {cancel(); return;}
    if (!task.opened) {
      const section = document.querySelector('ytd-video-description-transcript-section-renderer');
      const button = section?.querySelector('button');
      if (button && !button.disabled) {task.opened=true;button.click();}
      else if (!task.expanded) {
        const expand = document.querySelector('ytd-watch-metadata #expand');
        if (expand) {task.expanded=true;expand.click();}
      }
    }
    task.timer=setTimeout(()=>recover(task),500);
  }
  window.addEventListener('message',event=>{
    if (event.source !== window || event.origin !== location.origin || event.data?.videoId !== videoNow()) return;
    if (event.data?.source === 'ytz-transcript-cancel-v1') {cancel();return;}
    if (event.data?.source !== 'ytz-transcript-request-v1' || !/^[\w-]{11}$/.test(event.data.videoId) || !Number.isSafeInteger(event.data.generation)) return;
    if(cached?.videoId===event.data.videoId) {window.postMessage({source:'ytz-transcript-captions-v1',videoId:cached.videoId,generation:event.data.generation,...cached.data},location.origin);return;}
    if(recovery?.videoId===event.data.videoId) {recovery.generation=event.data.generation;return;}
    if(attempted.has(event.data.videoId)) return;
    cancel();attempted.add(event.data.videoId);
    if (attempted.size>20) attempted.delete(attempted.values().next().value);
    recovery={videoId:event.data.videoId,generation:event.data.generation,started:Date.now(),opened:false,expanded:false,timer:null};
    recover(recovery);
  });
  window.addEventListener('yt-navigate-finish',cancel);
})();
