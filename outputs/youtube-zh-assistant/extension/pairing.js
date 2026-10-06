(() => {
  'use strict';
  const origin = 'http://127.0.0.1:17865';
  if (location.origin !== origin || location.pathname !== '/') return;
  let busy = false;
  window.addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== window || event.origin !== origin || data?.source !== 'ytz-local-pair-request-v1' || typeof data.requestId !== 'string' || !/^[\w-]{16,80}$/.test(data.requestId) || typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)) return;
    if (busy) return;
    busy = true;
    try {
      const result = await chrome.runtime.sendMessage({type:'PAIR_LOCAL',token:data.token});
      window.postMessage({source:'ytz-local-pair-result-v1',requestId:data.requestId,ok:result?.ok===true,paired:result?.paired===true,verified:result?.verified===true,version:result?.version || '',error:result?.ok ? '' : result?.error || '扩展未确认配对'},origin);
    } catch {window.postMessage({source:'ytz-local-pair-result-v1',requestId:data.requestId,ok:false,error:'扩展连接失效，请重新加载扩展并刷新设置页'},origin);}
    finally {busy = false;}
  });
})();
