/* All devices, accounts, files and external pages are isolated fixtures. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'src/index.html'),'utf8');
const html=source.replace('  /* ---------- start ---------- */','window.qa41={CdDrive,Loudness,playMode,openAdd,startEdit,closeWin,setLang,readWorks,openDetail,getDraft:()=>formAudio,getPlayer:()=>player,nextIndex,stepTrack,play:async()=>{var cd=cdById("music");cd.audio.forEach(a=>AudioLib.present[a.file]=true);await playAudio(cd);}};\n  /* ---------- start ---------- */');
const disc={driveId:'D:',fingerprint:'a'.repeat(40),tracks:[{number:1,startSector:0,sectors:9000,duration:'2:00'},{number:2,startSector:9000,sectors:9000,duration:'2:00'}]};
const music={id:'music',title:'Playback fixture',works:[{title:'Program',tracks:[1,2,3].map(n=>({title:'Track '+n,duration:'0:10'}))}],audio:[1,2,3].map(n=>({file:'Fixture '+n+'.wav',name:'Fixture '+n+'.wav',track:n,size:160044}))};
let browser,server,base,passed=0,failed=0;
async function test(name,fn){if(process.env.CDC_TEST_FILTER&&!new RegExp(process.env.CDC_TEST_FILTER,'i').test(name))return;try{await fn();passed++;console.log('PASS:',name);}catch(e){failed++;console.error('FAIL:',name,e.stack);}}
function wav(){const bytes=Buffer.alloc(44+160000);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(160000,40);for(let i=0;i<80000;i++)bytes.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/8000)*5000),44+i*2);return bytes;}
async function fixture(options={}){
 const state={doc:{cds:[structuredClone(music)],meta:{albums:[],playlists:[],settings:{lang:'en'}}},calls:[],errors:[],complete:false,cancelled:false,links:[],...options};
 const context=await browser.newContext({reducedMotion:'reduce',viewport:{width:1280,height:900}});
 await context.exposeBinding('__qaNative',async(_,command,args={})=>{
  state.calls.push({command,args});
  switch(command){
   case 'load_data':return structuredClone(state.doc);
   case 'save_data':state.doc=structuredClone(args.data);return null;
   case 'audio_root_dir':return 'C:\\isolated-qa41\\audio';case 'covers_root_dir':return 'C:\\isolated-qa41\\covers';
   case 'audio_present':return args.files.map(()=>true);case 'tidy_covers':return 0;
   case 'list_cd_drives':return ['D:'];case 'read_cd_disc':return structuredClone(disc);
   case 'start_cd_import':if(state.startHold)await state.startHold;return 'rip-isolated';
   case 'cd_import_status':return {state:state.cancelled?'cancelled':state.jobError?'error':state.complete?'done':'copying',code:state.cancelled?'drive_cancelled':state.jobError||'',track:1,tracks:2,progress:state.complete?100:35};
   case 'cancel_cd_import':state.cancelled=true;return null;
   case 'adopt_cd_import':if(state.adoptHold)await state.adoptHold;return [1,2].map(n=>({file:'Imported '+n+'.flac',name:'Imported '+n+'.flac',track:n,size:100}));
   case 'remove_audio':return null;
   case 'open_feedback':if(state.feedbackFail)throw Error('isolated failure');return null;
   default:throw Error('Unexpected isolated command '+command);
  }
 });
 await context.addInitScript(({mode,unsupported})=>{
  window.CDC_DESKTOP=true;window.CDC_BUILD={run:66,commit:'fixture',date:'2026-11-17'};localStorage.setItem('cdc.lang','en');
  if(mode)localStorage.setItem('cdc.playmode',JSON.stringify(mode));
  if(unsupported)window.AudioWorkletNode=undefined;
  window.__TAURI__={core:{invoke:(c,a)=>window.__qaNative(c,a),convertFileSrc:p=>'https://asset.localhost/'+encodeURIComponent(p)},app:{getVersion:async()=> '0.3.1'}};
 },{mode:options.mode,unsupported:options.unsupported});
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.origin===base){
   if(url.pathname==='/audio-leveler.js')return route.continue();
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
   if(url.pathname==='/audio-leveler.js')return options.failModule?route.abort():route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(root,'src/audio-leveler.js'))});
   if(url.pathname.startsWith('/fonts/')){const p=path.resolve(root,'src',url.pathname.slice(1));if(p.startsWith(path.join(root,'src','fonts')+path.sep)&&fs.existsSync(p))return route.fulfill({path:p});}
  }
  if(url.hostname==='asset.localhost')return route.fulfill({contentType:'audio/wav',headers:{'access-control-allow-origin':'*'},body:wav()});
  if(url.hostname==='github.com'){state.links.push(url.href);return route.fulfill({contentType:'text/html',body:'Isolated issue draft'});}
  return route.abort();
 });
 const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>state.errors.push(e.message));await page.goto(base);await page.locator('#card-music').waitFor();
 return {page,state,context,close:async()=>{await context.close();assert.deepEqual(state.errors,[]);}};
}
async function importStart(page){await page.locator('#open-add').click();await page.locator('#title').fill('Keep this draft');await page.locator('#form-audio-set').evaluate(n=>n.open=true);await page.locator('#drive-open').click();await page.locator('#drive-read:not(:disabled)').waitFor();await page.locator('#drive-read').click();await page.locator('#drive-preview').waitFor();await page.locator('#drive-copy').click();await page.waitForFunction(()=>qa41.CdDrive.busy);}
async function play(page){await page.evaluate(()=>qa41.play());await page.locator('#player').waitFor();await page.waitForFunction(()=>!document.getElementById('player-audio').paused);}
async function main(){
 server=require('node:http').createServer((req,res)=>{
  if(req.url==='/audio-leveler.js'){res.setHeader('content-type','application/javascript');res.end(fs.readFileSync(path.join(root,'src/audio-leveler.js')));}
  else {res.statusCode=404;res.end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;

 browser=await pw.chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--autoplay-policy=no-user-gesture-required']});
 await test('minimized import keeps its draft, permits browsing/settings/playback and restores completed audio',async()=>{
  const f=await fixture(),{page,state}=f;try{
   await importStart(page);const id=await page.evaluate(()=>qa41.getDraft().id);await page.locator('#minimize-cd').click();assert(await page.locator('#win-cd').isHidden());assert(await page.locator('#drive-dock').isVisible());assert.equal(await page.locator('#drive-dock-progress').evaluate(n=>n.value),35);assert.equal(await page.locator('body').evaluate(n=>n.style.overflow),'');
   await page.locator('#search').fill('Playback');await page.locator('#open-settings').click();assert(await page.locator('#win-settings').isVisible());assert(await page.locator('#audio-location-choose').isDisabled());await page.locator('#done-settings').click();await play(page);assert.equal(await page.evaluate(()=>qa41.getPlayer().queue.length),3);
   state.complete=true;await page.waitForFunction(()=>!qa41.CdDrive.busy);assert(await page.locator('#win-cd').isHidden());assert.match(await page.locator('#drive-dock-status').textContent(),/Audio copied/);assert(!state.calls.some(c=>c.command==='save_data'));
   await page.locator('#drive-restore').click();assert.equal(await page.locator('#title').inputValue(),'Keep this draft');assert.equal(await page.evaluate(()=>qa41.getDraft().id),id);assert.equal(await page.evaluate(()=>qa41.getDraft().list.length),2);assert(await page.locator('#drive-dock').isHidden());
   await page.locator('#submit').click();await page.locator('#win-cd').waitFor({state:'hidden'});assert(state.doc.cds.some(c=>c.title==='Keep this draft'&&c.audio.length===2));
  }finally{await f.close();}
 });
 await test('a minimized import cannot be replaced by Add/Edit; cancellation and failure retain the draft',async()=>{
  for(const fail of [false,true]){const f=await fixture(),{page,state}=f;try{
   await importStart(page);const id=await page.evaluate(()=>qa41.getDraft().id);await page.locator('#minimize-cd').click();await page.evaluate(()=>qa41.startEdit({id:'different',title:'Wrong draft'}));assert.equal(await page.locator('#title').inputValue(),'Keep this draft');assert.equal(await page.evaluate(()=>qa41.getDraft().id),id);
   await page.locator('#minimize-cd').click();if(fail)state.jobError='drive_changed';else await page.locator('#drive-dock-cancel').click();await page.waitForFunction(()=>!qa41.CdDrive.busy);assert.equal(await page.evaluate(()=>qa41.getDraft().list.length),0);assert(!state.calls.some(c=>c.command==='adopt_cd_import'));await page.locator('#drive-restore').click();assert.equal(await page.locator('#title').inputValue(),'Keep this draft');assert(await page.locator('#drive-copy').isEnabled());
  }finally{await f.close();}}
 });
 await test('minimize during delayed adoption preserves cancellation ownership and unsaved unload warning',async()=>{
  let release;const hold=new Promise(r=>release=r);const f=await fixture({complete:true,adoptHold:hold}),{page,state}=f;try{
   await importStart(page);await page.waitForTimeout(80);await page.locator('#minimize-cd').click();assert(await page.evaluate(()=>{var e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;}));await page.locator('#drive-dock-cancel').click();release();await page.waitForFunction(()=>!qa41.CdDrive.busy);assert(state.calls.some(c=>c.command==='remove_audio'));assert.equal(await page.evaluate(()=>qa41.getDraft().list.length),0);
  }finally{release();await f.close();}
 });
 await test('one mode button cycles sequence/shuffle/one and preserves playing entry and volume',async()=>{
  const f=await fixture(),{page}=f;try{await play(page);assert.equal(await page.locator('#pl-shuffle,#pl-repeat').count(),0);const before=await page.evaluate(()=>qa41.getPlayer().queue);
   for(const mode of ['shuffle','one','sequence']){await page.locator('#pl-mode').click();assert.equal(await page.locator('#pl-mode').getAttribute('data-mode'),mode);assert.deepEqual(await page.evaluate(()=>qa41.getPlayer().queue),before);assert.equal(await page.evaluate(()=>qa41.getPlayer().index),0);}
   await page.locator('#pl-volume').fill('27');assert.equal(await page.evaluate(()=>qa41.playMode.volume),0.27);await page.locator('#pl-mute').click();assert.equal(await page.evaluate(()=>qa41.playMode.muted),true);
  }finally{await f.close();}
 });
 await test('sequential completion wraps, shuffle avoids repeats per round, and repeat-one keeps its entry',async()=>{
  const f=await fixture(),{page}=f;try{await play(page);await page.evaluate(()=>qa41.getPlayer().index=2);await page.locator('#player-audio').evaluate(n=>n.dispatchEvent(new Event('ended')));assert.equal(await page.evaluate(()=>qa41.getPlayer().index),0);
   await page.locator('#pl-mode').click();const visited=[0];for(let i=0;i<2;i++){await page.locator('#pl-next').click();visited.push(await page.evaluate(()=>qa41.getPlayer().index));}assert.equal(new Set(visited).size,3);await page.locator('#pl-next').click();assert.notEqual(await page.evaluate(()=>qa41.getPlayer().index),visited[2]);
   await page.locator('#pl-mode').click();const index=await page.evaluate(()=>qa41.getPlayer().index);await page.locator('#player-audio').evaluate(n=>n.dispatchEvent(new Event('ended')));assert.equal(await page.evaluate(()=>qa41.getPlayer().index),index);
  }finally{await f.close();}
 });
 await test('legacy playback flags migrate into exclusive modes without losing volume, mute or equalization preference',async()=>{
  for(const [old,mode] of [[{shuffle:true,repeat:'off',volume:0.23,muted:true},'shuffle'],[{shuffle:true,repeat:'one',volume:0.4,loudness:false},'one'],[{repeat:'off'},'sequence']]){const f=await fixture({mode:old});try{const value=await f.page.evaluate(()=>qa41.playMode);assert.equal(value.mode,mode);assert.equal(value.volume,old.volume??1);assert.equal(value.muted,!!old.muted);assert.equal(value.loudness,old.loudness!==false);}finally{await f.close();}}
 });
 await test('real AudioWorklet loads across the native-style asset origin; normalization toggle and post-gain volume persist',async()=>{
  const f=await fixture(),{page}=f;try{assert(await page.locator('#loudness-enabled').isChecked());await play(page);await page.waitForFunction(()=>qa41.Loudness.node&&qa41.Loudness.context.state==='running');
   await page.locator('#pl-volume').fill('25');await page.waitForFunction(()=>Math.abs(qa41.Loudness.output.gain.value-0.25)<0.01);assert.equal(await page.locator('#player-audio').evaluate(n=>n.volume),1);
   await page.locator('#open-settings').click();await page.locator('#loudness-enabled').uncheck();await page.waitForFunction(()=>qa41.Loudness.node.parameters.get('enabled').value<0.01);await page.reload();assert(!await page.locator('#loudness-enabled').isChecked());assert.equal(await page.evaluate(()=>qa41.playMode.volume),0.25);
  }finally{await f.close();}
 });
 await test('unavailable worklet or module failure retains normal playback and working volume controls',async()=>{
  for(const options of [{unsupported:true},{failModule:true}]){const f=await fixture(options),{page}=f;try{await play(page);await page.waitForFunction(()=>document.getElementById('loudness-status').textContent.includes('unavailable'));assert.equal(await page.evaluate(()=>qa41.Loudness.node),null);await page.locator('#pl-volume').fill('30');assert.equal(await page.locator('#player-audio').evaluate(n=>n.volume),0.3);}finally{await f.close();}}
 });
 await test('feedback validates input, opens only a user-initiated issue draft and preserves text on failure/cancel',async()=>{
  const f=await fixture(),{page,state}=f;try{await page.locator('#open-settings').click();await page.locator('#open-feedback').click();assert(await page.locator('#feedback-title').evaluate(n=>n===document.activeElement));await page.locator('#feedback-submit').click();assert.match(await page.locator('#feedback-error').textContent(),/Enter a title/);assert(!state.calls.some(c=>c.command==='open_feedback'));
   await page.locator('#feedback-title').fill('播放器 & #question');await page.locator('#feedback-details').fill('Step 1\nStep 2');state.feedbackFail=true;await page.locator('#feedback-submit').click();await page.waitForFunction(()=>document.getElementById('feedback-error').textContent.includes('Could not'));state.feedbackFail=false;await page.locator('#feedback-submit').click();await page.waitForFunction(()=>!document.getElementById('feedback-submit').disabled);
   const call=state.calls.findLast(c=>c.command==='open_feedback');assert.deepEqual(call.args,{kind:'bug',title:'播放器 & #question',details:'Step 1\nStep 2',build:'66 / fixture'});assert(!JSON.stringify(call.args).includes('Playback fixture'));await page.keyboard.press('Escape');await page.locator('#open-feedback').click();assert.equal(await page.locator('#feedback-details').inputValue(),'Step 1\nStep 2');assert.equal(state.calls.filter(c=>c.command==='open_feedback').length,2);
  }finally{await f.close();}
 });
 await test('new controls and dialogs fit three locales, both themes and narrow/desktop widths',async()=>{
  const f=await fixture(),{page}=f;try{await importStart(page);await page.locator('#minimize-cd').click();for(const lang of ['en','ja','zh'])for(const theme of ['light','dark'])for(const width of [360,1280]){
   await page.setViewportSize({width,height:900});await page.evaluate(({lang,theme})=>{qa41.setLang(lang,false);document.documentElement.dataset.theme=theme;},{lang,theme});assert(await page.locator('#drive-dock').evaluate(n=>n.scrollWidth<=n.clientWidth+1));await page.locator(width<=860?'#compact-settings':'#open-settings').click();await page.locator('#open-feedback').click();assert(await page.locator('#win-feedback .panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1));await page.locator('#feedback-cancel').click();await page.locator('#done-settings').click();
  }}finally{await f.close();}
 });
 await browser.close();server.close();console.log(`${passed}/${passed+failed} improvements 4.1 browser checks passed`);if(failed)process.exitCode=1;
}
main().catch(async e=>{console.error(e);if(browser)await browser.close();if(server)server.close();process.exitCode=1;});
