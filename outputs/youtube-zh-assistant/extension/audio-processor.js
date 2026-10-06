class PCMCollector extends AudioWorkletProcessor {
  constructor() {
    super();this.limit=Math.round(sampleRate*2);this.minimum=Math.round(sampleRate*.8);this.pause=Math.round(sampleRate*.3);
    this.buffer=new Float32Array(this.limit);this.offset=0;this.energy=0;this.quiet=0;
  }
  emit() {
    if(this.offset&&Math.sqrt(this.energy/this.offset)>.003){const samples=this.buffer.slice(0,this.offset);this.port.postMessage({samples,rate:sampleRate},[samples.buffer]);}
    this.offset=0;this.energy=0;this.quiet=0;
  }
  process(inputs) {
    const channels = inputs[0]; if (!channels?.length) return true;
    const count = channels[0].length;
    let frameEnergy=0;
    for(let i=0;i<count;i++){let value=0;for(const channel of channels)value+=channel[i]||0;value/=channels.length;frameEnergy+=value*value;}
    const silent=Math.sqrt(frameEnergy/count)<=.003;
    if(silent&&!this.offset)return true;
    for (let i = 0; i < count; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i] || 0; sample /= channels.length;
      this.buffer[this.offset++] = sample; this.energy += sample * sample;
      this.quiet=silent?this.quiet+1:0;
      if (this.offset === this.buffer.length) {
        this.emit();
      }
    }
    if(this.offset>=this.minimum&&this.quiet>=this.pause)this.emit();
    return true;
  }
}
registerProcessor('pcm-collector', PCMCollector);
