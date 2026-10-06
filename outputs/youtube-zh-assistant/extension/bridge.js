(() => {
  'use strict';
  let last = '', attempts = 0;
  const nativeFetch = window.fetch.bind(window);
  let nativeVideo = '', nativeData = null;
  const nativeRequests = new Map();
  function videoNow() { return new URL(location.href).searchParams.get('v'); }
  function nativeTrack(value, videoId) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.hostname !== 'www.youtube.com' || u.pathname !== '/api/timedtext' || u.searchParams.get('v') !== videoId || u.port || u.username || u.password || u.href.length > 8000) return null;
      u.searchParams.set('fmt', 'json3');
      return {baseUrl:u.href, languageCode:u.searchParams.get('tlang') || u.searchParams.get('lang') || '', kind:u.searchParams.get('kind') === 'asr' ? 'asr' : '', native:true};
    } catch { return null; }
  }
  function resetNative(videoId) {
    if (nativeVideo === videoId) return;
    for (const request of nativeRequests.values()) if (request.retryTimer) clearTimeout(request.retryTimer);
    nativeVideo = videoId; nativeData = null; nativeRequests.clear();
  }
  async function readNative(value) {
    const videoId = videoNow();
    if (!/^[\w-]{11}$/.test(videoId || '')) return;
    resetNative(videoId);
    const track = nativeTrack(value, videoId);
    if (!track) return;
    const previous = nativeRequests.get(track.baseUrl);
    if (previous && (previous.success || previous.busy || previous.attempts >= 2 || Date.now()-previous.at < 15000)) return;
    if (!previous && nativeRequests.size >= 20) return;
    if (previous?.retryTimer) clearTimeout(previous.retryTimer);
    const request = {at:Date.now(),attempts:(previous?.attempts || 0)+1,busy:true,success:false};
    nativeRequests.set(track.baseUrl,request);
    try {
      const response = await nativeFetch(track.baseUrl, {credentials:'include', redirect:'error', signal:AbortSignal.timeout(15000)});
      if (!response.ok) return;
      const raw = await response.text();
      if (!raw || raw.length > 10000000 || videoNow() !== videoId || nativeVideo !== videoId) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data.events) || data.events.length > 50000 || !data.events.some(e => Array.isArray(e.segs) && e.segs.some(s => typeof s.utf8 === 'string' && s.utf8.trim()))) return;
      nativeData = {source:'ytz-native-captions-v1', videoId, track, data};
      request.success = true;
      window.postMessage(nativeData, location.origin);
    } catch { /* The regular track/DOM paths remain available. */ }
    finally {
      request.busy = false;
      // A transient empty response may never produce another player resource event.
      // Retry this read once after the cooldown, with no model calls or polling loop.
      if (!request.success && request.attempts < 2 && videoNow() === videoId && nativeRequests.get(track.baseUrl) === request) {
        request.retryTimer = setTimeout(() => {
          if (videoNow() === videoId && nativeRequests.get(track.baseUrl) === request) readNative(track.baseUrl);
        }, Math.max(0,15000-(Date.now()-request.at)));
      }
    }
  }
  function collectNative() {
    resetNative(videoNow());
    for (const entry of performance.getEntriesByType('resource')) {
      if (entry.name.includes('/api/timedtext')) readNative(entry.name);
    }
  }
  // Observe completed player requests without wrapping fetch/XHR or exposing credentials.
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (entry.name.includes('/api/timedtext')) readNative(entry.name);
  });
  observer.observe({type:'resource', buffered:true});
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'ytz-native-captions-request-v1' || event.data.videoId !== videoNow()) return;
    collectNative();
    collect(true);
    if (nativeData) window.postMessage(nativeData, location.origin);
  });
  function collect(force=false) {
    const videoId = new URL(location.href).searchParams.get('v');
    if (!/^[\w-]{11}$/.test(videoId || '')) return;
    let candidates = [window.ytInitialPlayerResponse];
    try { candidates.unshift(document.getElementById('movie_player')?.getPlayerResponse?.()); } catch {}
    try { candidates.push(JSON.parse(window.ytplayer?.config?.args?.player_response || 'null')); } catch {}
    const player = candidates.find(p => p?.videoDetails?.videoId === videoId && Array.isArray(p?.captions?.playerCaptionsTracklistRenderer?.captionTracks));
    const tracks = (player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).slice(0, 40).flatMap(t => {
      try {
        const u = new URL(t.baseUrl);
        if (u.protocol !== 'https:' || u.hostname !== 'www.youtube.com' || u.pathname !== '/api/timedtext' || u.searchParams.get('v') !== videoId || u.port || u.username || u.password) return [];
        return [{baseUrl: u.href.slice(0, 8000), languageCode: String(t.languageCode || '').slice(0, 30), kind: t.kind === 'asr' ? 'asr' : '', name: String(t.name?.simpleText || t.name?.runs?.map(r => r.text).join('') || '').slice(0, 100)}];
      } catch { return []; }
    });
    const payload = {source: 'ytz-caption-tracks-v1', videoId, tracks};
    const key = JSON.stringify(payload);
    if (force || key !== last || attempts++ % 10 === 0) { last = key; window.postMessage(payload, location.origin); }
  }
  setInterval(collect, 1000);
  window.addEventListener('yt-navigate-finish', () => {collect(); collectNative();});
})();
