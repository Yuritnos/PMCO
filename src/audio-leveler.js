/* Streaming playback equalization. No file decoding, rewriting or collection data.
   Measure channel energy independently; slow gain changes retain musical dynamics.
   A linked peak limiter prevents gain boosts from clipping any channel. */
class PMCOLeveler extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{name:'enabled',defaultValue:1,minValue:0,maxValue:1,automationRate:'k-rate'}];
  }
  constructor() {
    super();
    this.reset();
    this.port.onmessage=event=>{if(event.data&&event.data.reset)this.reset();};
  }
  reset() { this.power=0;this.gain=1;this.limiter=1;this.frames=0; }
  process(inputs,outputs,parameters) {
    const input=inputs[0],output=outputs[0];
    if(!input||!input.length||!output.length)return true;
    const count=input[0].length,seconds=count/sampleRate,mix=parameters.enabled[0];
    let energy=0;
    for(const channel of input)for(let i=0;i<count;i++)energy+=channel[i]*channel[i];
    const power=energy/(count*input.length);
    // Freeze the estimate during silence instead of turning up background noise.
    if(power>1e-6) {
      this.power=this.power?this.power+(power-this.power)*(1-Math.exp(-seconds/3)):power;
      this.frames+=count;
    }
    const target=this.power&&this.frames>sampleRate*0.25?Math.max(0.126,Math.min(4,0.126/Math.sqrt(this.power))):1;
    this.gain+=(target-this.gain)*(1-Math.exp(-seconds/(target<this.gain?0.4:3)));
    const gain=1+(this.gain-1)*mix,release=1-Math.exp(-1/(sampleRate*0.15));
    for(let i=0;i<count;i++) {
      let peak=0;for(const channel of input)peak=Math.max(peak,Math.abs(channel[i]*gain));
      const ceiling=peak>0.95?0.95/peak:1;
      this.limiter=ceiling<this.limiter?ceiling:this.limiter+(1-this.limiter)*release;
      const scale=gain*(mix>0?this.limiter:1);
      for(let channel=0;channel<output.length;channel++)output[channel][i]=(input[channel]||input[0])[i]*scale;
    }
    return true;
  }
}
registerProcessor('pmco-leveler',PMCOLeveler);
