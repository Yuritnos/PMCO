/* Deterministic sample fixtures exercise the actual streaming worklet, not a model. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
let Processor;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/audio-leveler.js'),'utf8'),{sampleRate:48000,AudioWorkletProcessor:class{constructor(){this.port={};}},registerProcessor:(name,p)=>{assert.equal(name,'pmco-leveler');Processor=p;}});
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS:',name);}
function run(processor,{amplitude=0.2,seconds=22,phase=false,mix=1,spike=false}={}){
 let squares=0,frames=0,peak=0;const count=128,input=[new Float32Array(count),new Float32Array(count)],output=[new Float32Array(count),new Float32Array(count)];
 for(let block=0;block<Math.ceil(seconds*48000/count);block++){
  for(let i=0;i<count;i++){const v=amplitude*Math.sin((block*count+i)*2*Math.PI*440/48000);input[0][i]=v;input[1][i]=phase?-v:v;}if(spike&&block===0)input[0][0]=1;
  assert.equal(processor.process([input],[output],{enabled:new Float32Array([mix])}),true);
  for(let i=0;i<count;i++){assert(Number.isFinite(output[0][i]));peak=Math.max(peak,Math.abs(output[0][i]));if(block*count>=(seconds-3)*48000){squares+=output[0][i]**2;frames++;}assert(Math.abs(output[1][i]-(phase?-output[0][i]:output[0][i]))<1e-6||spike);}
 }
 return {rms:Math.sqrt(squares/frames),peak};
}
test('quiet and loud tracks converge to comparable levels without scanning or changing sources',()=>{
 const quiet=run(new Processor(),{amplitude:0.08}),loud=run(new Processor(),{amplitude:0.6});assert(Math.abs(20*Math.log10(quiet.rms/loud.rms))<0.5);assert(Math.abs(loud.rms-0.126)<0.005);
});
test('opposite-phase stereo measures channel energy independently and preserves stereo balance',()=>{
 const normal=run(new Processor(),{amplitude:0.1}),opposite=run(new Processor(),{amplitude:0.1,phase:true});assert(Math.abs(normal.rms-opposite.rms)<1e-6);
});
test('linked limiter protects a loud transient after quiet-track gain has increased',()=>{
 const p=new Processor();run(p,{amplitude:0.08});for(const mix of [1,0.5,0.01]){const value=run(p,{amplitude:0.5,seconds:0.02,spike:true,mix});assert(value.peak<=0.950001);}
});
test('disabled equalization passes source samples unchanged at every level',()=>{
 const p=new Processor();run(p,{amplitude:0.08});const value=run(p,{amplitude:0.6,mix:0});assert(Math.abs(value.rms-0.6/Math.sqrt(2))<0.0001);assert(value.peak<=0.600001);
});
test('silence never drives gain upward; reset starts a new track with unity gain',()=>{
 const p=new Processor();run(p,{amplitude:0.08});const power=p.power;run(p,{amplitude:0,seconds:6});assert.equal(p.power,power);assert(p.gain<=4);p.port.onmessage({data:{reset:true}});assert.equal(p.gain,1);assert.equal(p.power,0);assert.equal(p.frames,0);
});
test('empty inputs stay active, large render blocks and multichannel inputs remain bounded',()=>{
 const p=new Processor();assert(p.process([[]],[[new Float32Array(128)]],{enabled:[1]}));const input=Array.from({length:6},()=>Float32Array.from({length:512},()=>0.2)),output=Array.from({length:6},()=>new Float32Array(512));assert(p.process([input],[output],{enabled:[1]}));assert(output.every(c=>c.every(Number.isFinite)));assert(output.every(c=>c[0]===output[0][0]));
});
console.log(`${passed}/${passed} loudness sample checks passed`);
