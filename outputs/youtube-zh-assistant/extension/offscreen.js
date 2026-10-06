'use strict';
let stream = null, context = null, source = null, collector = null, muted = null, generation = null, busyGeneration = null, droppedChunks = 0, processedChunks = 0, operation = Promise.resolve();
function ended(capturedGeneration, reason) {chrome.runtime.sendMessage({type:'AUDIO_ENDED',generation:capturedGeneration,reason}).catch(()=>{});}
async function cleanup() {
  const previous = {collector,source,muted,stream,context};
  generation = busyGeneration = null;
  droppedChunks = processedChunks = 0;
  stream = context = source = collector = muted = null;
  if (previous.collector) {previous.collector.port.onmessage = null; previous.collector.disconnect();}
  previous.source?.disconnect(); previous.muted?.disconnect(); previous.stream?.getTracks().forEach(track => track.stop());
  if (previous.context && previous.context.state !== 'closed') await previous.context.close();
}
function progress(capturedGeneration) {chrome.runtime.sendMessage({type:'AUDIO_PROGRESS',generation:capturedGeneration,droppedChunks,processedChunks}).catch(()=>{});}
function wavBase64(samples, rate) {
  const targetRate = 16000, ratio = rate / targetRate, length = Math.floor(samples.length / ratio);
  const bytes = new Uint8Array(44 + length * 2), view = new DataView(bytes.buffer);
  const word = (offset,text) => {for(let i=0;i<text.length;i++) bytes[offset+i]=text.charCodeAt(i);};
  word(0,'RIFF'); view.setUint32(4,bytes.length-8,true); word(8,'WAVE'); word(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,targetRate,true); view.setUint32(28,targetRate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true); word(36,'data'); view.setUint32(40,length*2,true);
  for(let i=0;i<length;i++) {
    const from = Math.floor(i*ratio), to = Math.max(from+1,Math.floor((i+1)*ratio)); let value=0;
    for(let j=from;j<to && j<samples.length;j++) value+=samples[j]; value/=to-from;
    value=Math.max(-1,Math.min(1,value)); view.setInt16(44+i*2,value<0?value*32768:value*32767,true);
  }
  let text=''; for(let i=0;i<bytes.length;i+=8192) text+=String.fromCharCode(...bytes.subarray(i,i+8192)); return btoa(text);
}
async function start(message) {
  await cleanup(); generation = message.generation; droppedChunks = processedChunks = 0; const capturedGeneration = generation;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:message.streamId}},video:false});
    context = new AudioContext(); await context.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'));
    source = context.createMediaStreamSource(stream); source.connect(context.destination);
    collector = new AudioWorkletNode(context,'pcm-collector'); muted = context.createGain(); muted.gain.value = 0;
    source.connect(collector); collector.connect(muted); muted.connect(context.destination); await context.resume();
    for(const track of stream.getTracks()) track.addEventListener('ended', () => {if(generation===capturedGeneration) {chrome.runtime.sendMessage({type:'AUDIO_ENDED',generation:capturedGeneration}).catch(()=>{}); cleanup();}});
    collector.port.onmessage = async event => {
      if(generation!==capturedGeneration) return;
      if(busyGeneration) {droppedChunks++; progress(capturedGeneration); return;} // No backlog: at most one independent WAV request.
      busyGeneration=capturedGeneration;
      try {
        const response = await chrome.runtime.sendMessage({type:'AUDIO_CHUNK',generation:capturedGeneration,mime:'audio/wav',audioBase64:wavBase64(event.data.samples,event.data.rate),durationSeconds:event.data.samples.length/event.data.rate,capturedAt:Date.now()});
        if(generation!==capturedGeneration) return;
        if(!response?.ok) {ended(capturedGeneration,(response?.error || '音频识别请求未确认')+'；音频识别已停止，请手动重新开启'); await cleanup();}
        else if(response.discarded) {if(response.reason==='busy') droppedChunks++; progress(capturedGeneration);}
        else {processedChunks++; progress(capturedGeneration);}
      } catch {if(generation===capturedGeneration) {ended(capturedGeneration,'后台连接中断，音频识别已停止'); await cleanup();}}
      finally {if(busyGeneration===capturedGeneration) busyGeneration=null;}
    };
    return {ok:true};
  } catch(error) {await cleanup(); return {ok:false,error:error.message};}
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if(sender.id!==chrome.runtime.id || sender.tab || (sender.url && sender.url!==chrome.runtime.getURL('background.js')) || message?.target!=='offscreen') return;
  if(message.type==='START') {operation=operation.catch(()=>{}).then(()=>start(message)); operation.then(respond,error=>respond({ok:false,error:error.message})); return true;}
  if(message.type==='STOP') {operation=operation.catch(()=>{}).then(()=>cleanup()); operation.then(()=>respond({ok:true}),error=>respond({ok:false,error:error.message})); return true;}
});
