/* Isolated flat-audio/removal regression tests. No real accounts, drives or collection. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8').replace('  /* ---------- start ---------- */',
  '  window.mediaQA = { startEdit, exportCsv:async function(){var result,old=downloadsApi;downloadsApi={save:async function(req){result=req.data;}};try{await doExport("csv");return result;}finally{downloadsApi=old;}}, Cloud, fillFromLookup, splitAuto, splitMove, splitTime, splitParse, splitEdit, splitAddPoint, splitDeletePoint, splitUndo, splitSeek, splitZoom, formAudioNaming, getBackend:function(){return backend;}, openAudioSplit, getSplit: function(){return splitEditor;}, getDraft: function(){return formAudio;}, setSplit: function(ed){splitEditor=ed;}, setLang, openDetail, discTracks, dgMedia, dgDiscLists, discogsSource, lookupDiscData, populateLookupDrafts, playId: function(id) { playAudio(cdById(id)); }, renderPlaylist, moveCard, resetWorks, readWorks, cdFormDirty, closeWin, queue: function() { return clone(player.queue); }, currentEntry }; Cloud.start=function(){};\n  /* ---------- start ---------- */');
const set = {id:'mixed', title:'Mixed anthology', total:3};
const seed = [
  {id:'old', title:'Legacy CD', extra:{keep:true}, works:[{title:'Old work', tracks:[]}]},
  {id:'m1', title:'Mixed anthology', set:{...set,disc:1}, medium:'cd', notes:'CD notes'},
  {id:'m2', title:'Mixed anthology', set:{...set,disc:2}, medium:'cd'},
  {id:'m3', title:'Mixed anthology', set:{...set,disc:3}, medium:'vinyl', recordSpeed:'33⅓', works:[{title:'Across both sides', tracks:[{title:'First',position:'A1',duration:'1:00'},{title:'Second',position:'B1',duration:'2:00'}]}]},
  {id:'tape', title:'Tape', medium:'cassette', tapeType:'Type II'},
  {id:'sacd', title:'SACD edition', medium:'sacd', sacdHybrid:'Hybrid', audioPrograms:'Stereo / 5.1'},
  {id:'usb', title:'USB edition', medium:'usb', capacity:'16 GB'}
];
const optical = ['dvd','bluray'].map((medium,i)=>({id:'optical-'+i,title:'Optical edition',medium,
  set:{id:'optical',title:'Optical edition',disc:i+1,total:2},
  works:[{title:'Concert',duration:'1:00',tracks:[]}]}));
let browser, passed = 0, failed = 0;
async function test(name, fn) { if(process.env.CDC_TEST_FILTER&&!new RegExp(process.env.CDC_TEST_FILTER,'i').test(name))return; try { await fn(); passed++; console.log('PASS:',name); } catch(e) { failed++; console.error('FAIL:',name,e.stack); } }
async function fixture({native=false, extra=[]}={}) {
  const state = {doc:{cds:structuredClone(seed.concat(extra)),meta:{albums:[{id:'fav',name:'Favorites',cdIds:['m1','m2','m3']}],playlists:[],settings:{lang:'en'}}}, errors:[], commands:[], copied:new Set(), splitCount:0, splitInfo:{id:'fixture-split',name:'fixture.wav',rate:1000,frames:600000}};
  const context = await browser.newContext({viewport:{width:1280,height:900}, reducedMotion:'reduce'});
  if(native) await context.exposeBinding('__mediaInvoke',async(_,command,args={})=>{
    state.commands.push({command,args});
    switch(command){
      case 'load_data':return structuredClone(state.doc);
      case 'save_data':if(state.failSave)throw Error('isolated failure');state.doc=structuredClone(args.data);return null;
      case 'audio_root_dir':return 'C:\\isolated-media\\audio';
      case 'covers_root_dir':return 'C:\\isolated-media\\covers';
      case 'audio_present':return args.files.map(file=>file!=='Missing.flac');
      case 'tidy_covers':return null;
      case 'choose_audio_location': return state.locationResult || null;
      case 'prepare_audio_split': if(state.invalidSplit)throw 'split_invalid';return structuredClone(state.splitInfo);
      case 'start_audio_split': state.segments=structuredClone(args.segments);state.splitCount=args.segments.length;return null;
      case 'audio_split_status': return {state:state.writing?'writing':'done',progress:state.writing?30:100};
      case 'cancel_audio_split': state.writing=false;state.cancelled=true;return null;
      case 'adopt_audio_split': if(state.splitOverride){for(const a of state.splitOverride)state.copied.add(a.file);return structuredClone(state.splitOverride);} if(state.adoptHold)await state.adoptHold; return Array.from({length:state.splitCount},(_,i)=>{const file='old/cut-'+i+'.wav';state.copied.add(file);return {file,name:'cut-'+i+'.wav',size:100};});
      case 'add_audio': {
        if(state.addedOverride){for(const a of state.addedOverride)state.copied.add(a.file);return structuredClone(state.addedOverride);}
        if(state.folderHold)await state.folderHold;
        return ['10 Finale.wav','2 Middle.wav','1 Opening.wav'].map((name,i)=>{const file=args.cdId+'/folder-'+i+'.wav';state.copied.add(file);return {file,name:'Side A/'+name,size:100};});
      }
      case 'remove_audio':args.files.forEach(file=>state.copied.delete(file));return null;
      default:throw Error('Unexpected mocked command: '+command);
    }
  });
  await context.addInitScript(native=>{
    window.CDC_DESKTOP=true;window.PMCO_TRIAL=true;localStorage.setItem('cdc.lang','en');
    if(native)window.__TAURI__={core:{invoke:(command,args)=>window.__mediaInvoke(command,args),convertFileSrc:file=>location.origin+'/fixture-audio/'+encodeURIComponent(file)}};
  },native);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'media.test') {
      if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:html});
      if(url.pathname.startsWith('/fixture-audio/')){const pcm=8000*2*30,wav=Buffer.alloc(44+pcm);wav.write('RIFF');wav.writeUInt32LE(36+pcm,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm,40);return route.fulfill({contentType:'audio/wav',body:wav});}
      if (url.pathname === '/api/data') { if(route.request().method()==='PUT') state.doc=route.request().postDataJSON(); return route.fulfill({json:state.doc}); }
    }
    if(url.hostname.endsWith('.supabase.co')) {
      const table=url.pathname.split('/').pop();
      if(table==='cds') {
        if(route.request().method()==='POST') {for(const row of route.request().postDataJSON()){state.cloudRows=state.cloudRows||[];const i=state.cloudRows.findIndex(r=>r.id===row.id);if(i<0)state.cloudRows.push(row);else state.cloudRows[i]=row;}return route.fulfill({status:204});}
        const rows=state.cloudRows||[];
        return route.fulfill({json:url.searchParams.get('select')==='id,deleted,updated_ms'?rows.map(({id,deleted,updated_ms})=>({id,deleted,updated_ms})):rows});
      }
      if(table==='meta') {if(route.request().method()==='POST'){state.cloudMeta=route.request().postDataJSON();return route.fulfill({status:204});}return route.fulfill({json:state.cloudMeta||[]});}
      return route.fulfill({json:[]});
    }
    return route.abort();
  });
  const page=await context.newPage(); page.setDefaultTimeout(6000); page.on('pageerror',e=>state.errors.push(e.message));
  await page.goto('http://media.test/'); await page.locator('#card-old').waitFor();
  return {page,state,close:async()=>{await context.close();assert.deepEqual(state.errors,[]);}};
}
const view = async(page,m) => { if(await page.locator('#chip-all').getAttribute('aria-expanded')==='false')await page.locator('#chip-all').press('ArrowRight');await page.locator('[id="chip-media:'+m+'"]').click(); };
async function save(page) { await page.locator('#submit').click(); await page.locator('#win-cd').waitFor({state:'hidden'}); }
const tick=()=>new Promise(r=>setTimeout(r,30));
async function until(fn){for(let i=0;i<150&&!await fn();i++)await tick();assert(await fn(),'timed out');}
async function editor(page,durations=['3:00','4:00','5:00'],audio=[]){
  await page.evaluate(({durations,audio})=>mediaQA.startEdit({id:'old',title:'Split fixture',medium:'cd',audio,works:[{title:'Program',tracks:durations.map((duration,i)=>({title:'Movement '+(i+1),duration}))}]}),{durations,audio});
  await page.locator('#form-audio-set').evaluate(n=>n.open=true);
  await page.locator('#form-audio-split').click();await page.locator('#win-split').waitFor({state:'visible'});
}
async function acceptWrite(page){await page.locator('#split-confirm').click();await page.locator('#split-ask-yes').click();await page.locator('#win-split').waitFor({state:'hidden'});}
const existing={file:'Album - 01 - First.flac',name:'Album - 01 - First.flac',size:100,track:1};
const second={file:'Album - 02 - Second.flac',name:'Album - 02 - Second.flac',size:100,track:2};
async function profileFixture({shared=false,missing=false}={}){
 const f=await fixture({native:true}),{page,state}=f;
 const cd=state.doc.cds.find(c=>c.id==='old');Object.assign(cd,{title:'Album',audio:[structuredClone(existing),missing?{...second,file:'Missing.flac',name:'Missing.flac'}:structuredClone(second)],works:[{title:'Program',tracks:[{title:'First',duration:'1:00'},{title:'Second',duration:'2:00'}]}]});
 state.doc.meta.playlists=[{id:'queue-test',name:'Test playlist',items:[{cdId:'old',file:existing.file},{cdId:'old',file:second.file}]}];
 state.copied.add(existing.file);state.copied.add(second.file);state.copied.add('Unrelated.flac');
 if(shared)state.doc.cds.find(c=>c.id==='tape').audio=[structuredClone(existing)];
 await page.reload();await page.locator('#card-old').waitFor();await page.evaluate(()=>mediaQA.openDetail('old'));return f;
}
async function main(){
 browser=await playwright.chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 await test('ordinary import supplies readable naming, stores flat paths and preserves native assignments',async()=>{
  const f=await fixture({native:true}),{page,state}=f;
  try{
   await page.evaluate(()=>mediaQA.startEdit({id:'old',title:'Album',audio:[{file:'Existing.flac',name:'Existing.flac',size:1,track:1}],works:[{title:'Program',tracks:[{title:'First',duration:'1:00'},{title:'Second',duration:'2:00'},{title:'Third',duration:'3:00'}]}]}));
   await page.locator('#form-audio-set').evaluate(n=>n.open=true);
   state.addedOverride=[{file:'Album - 02 - Second.flac',name:'Album - 02 - Second.flac',size:3,track:2},{file:'Album - 03 - Third.flac',name:'Album - 03 - Third.flac',size:4,track:3},{file:'Album - 04 - Track 04.flac',name:'Album - 04 - Track 04.flac',size:5,track:0}];
   await page.locator('#form-audio-add').click();await page.locator('#form-audio-add:not(:disabled)').waitFor();const call=state.commands.find(c=>c.command==='add_audio');assert.deepEqual(call.args.naming,{title:'Album',item:'',tracks:[{number:2,title:'Second'},{number:3,title:'Third'}],next:4});
   assert.deepEqual(await page.evaluate(()=>mediaQA.getDraft().list.map(a=>a.track)),[1,2,3,0]);await save(page);const audio=state.doc.cds.find(c=>c.id==='old').audio;assert(audio.every(a=>!a.file.includes('/')));assert.deepEqual(audio.slice(1),state.addedOverride);
   await page.evaluate(cd=>mediaQA.startEdit(cd),state.doc.cds.find(c=>c.id==='old'));assert.deepEqual(await page.locator('#form-audio .pa-file').allTextContents(),audio.map(a=>a.name));
  }finally{await f.close();}
 });
 await test('set naming uses medium ordinal, independent work slots and physical CD order',async()=>{
  const f=await fixture({native:true}),{page,state}=f;
  try{
   await page.evaluate(cd=>mediaQA.startEdit(cd),state.doc.cds.find(c=>c.id==='m2'));let naming=await page.evaluate(()=>mediaQA.formAudioNaming());assert.equal(naming.title,'Mixed anthology');assert.equal(naming.item,'CD2');
   await page.evaluate(()=>mediaQA.closeWin('cd',true));await page.evaluate(cd=>mediaQA.startEdit(cd),state.doc.cds.find(c=>c.id==='m3'));naming=await page.evaluate(()=>mediaQA.formAudioNaming());assert.equal(naming.item,'Vinyl1');assert.deepEqual(naming.tracks.map(t=>t.number),[1,2]);
   await page.evaluate(()=>mediaQA.closeWin('cd',true));await page.evaluate(()=>mediaQA.startEdit({id:'old',title:'Undivided',works:[{title:'One work',duration:'1:00',tracks:[]},{title:'Next work',duration:'2:00',tracks:[]}]}));naming=await page.evaluate(()=>mediaQA.formAudioNaming());assert.deepEqual(naming.tracks,[{number:1,title:'One work'},{number:2,title:'Next work'}]);
   naming=await page.evaluate(()=>mediaQA.formAudioNaming(3));assert.deepEqual(naming.tracks,[{number:1,title:'One work'},{number:2,title:'Next work'},{number:3,title:''}]);
  }finally{await f.close();}
 });
 await test('trim adoption receives album/remaining track names and attaches root files as drafts',async()=>{
  const f=await fixture({native:true}),{page,state}=f;
  try{
   state.splitOverride=[{file:'Split fixture - 02 - Movement 2.wav',name:'Split fixture - 02 - Movement 2.wav',size:10,track:2},{file:'Split fixture - 03 - Movement 3.wav',name:'Split fixture - 03 - Movement 3.wav',size:10,track:3}];
   await editor(page,['3:00','4:00','5:00'],[{file:'Existing.wav',name:'Existing.wav',size:1,track:1}]);await acceptWrite(page);
   const call=state.commands.find(c=>c.command==='adopt_audio_split');assert.equal(call.args.naming.title,'Split fixture');assert.deepEqual(call.args.naming.tracks,[{number:2,title:'Movement 2'},{number:3,title:'Movement 3'}]);
   assert.deepEqual(await page.evaluate(()=>mediaQA.getDraft().list.map(a=>a.track)),[1,2,3]);assert.equal((state.doc.cds.find(c=>c.id==='old').audio||[]).length,0);await save(page);assert(state.doc.cds.find(c=>c.id==='old').audio.every(a=>!a.file.includes('/')));
  }finally{await f.close();}
 });
 await test('profile audio removal asks first; Cancel and Escape retain files, collection, playlists and queue',async()=>{
  const f=await profileFixture(),{page,state}=f;
  try{
   await page.evaluate(()=>mediaQA.playId('old'));const queue=await page.evaluate(()=>mediaQA.queue()),before=structuredClone(state.doc);
   await page.locator('#audio-remove-0').click();assert(await page.locator('#win-audio-remove').isVisible());assert((await page.locator('#audio-remove-text').textContent()).includes(existing.name));assert.deepEqual(state.doc,before);assert(!state.commands.some(c=>c.command==='remove_audio'));
   await page.locator('#audio-remove-cancel').click();assert(await page.locator('#audio-remove-0').evaluate(n=>n===document.activeElement));await page.locator('#audio-remove-0').click();await page.keyboard.press('Escape');assert(await page.locator('#win-audio-remove').isHidden());assert.deepEqual(state.doc,before);assert.deepEqual(await page.evaluate(()=>mediaQA.queue()),queue);assert(state.copied.has(existing.file));
  }finally{await f.close();}
 });
 await test('confirmation persists audio/playlists before deleting exactly one flat file and updates playback',async()=>{
  const f=await profileFixture(),{page,state}=f;
  try{
   await page.evaluate(()=>mediaQA.playId('old'));const start=state.commands.length;await page.locator('#audio-remove-0').click();await page.locator('#audio-remove-confirm').click();await page.locator('#win-audio-remove').waitFor({state:'hidden'});
   assert.deepEqual(state.doc.cds.find(c=>c.id==='old').audio,[second]);assert.deepEqual(state.doc.meta.playlists[0].items,[{cdId:'old',file:second.file}]);assert(!state.copied.has(existing.file));assert(state.copied.has(second.file));assert(state.copied.has('Unrelated.flac'));
   const commands=state.commands.slice(start),saveAt=commands.findIndex(c=>c.command==='save_data'),removeAt=commands.findIndex(c=>c.command==='remove_audio');assert(saveAt>=0&&removeAt>saveAt);assert.deepEqual(commands[removeAt].args.files,[existing.file]);assert((await page.evaluate(()=>mediaQA.queue())).every(e=>e.file!==existing.file));
  }finally{await f.close();}
 });
 await test('failed removal retains references, original files and queue; confirmation retries successfully',async()=>{
  const f=await profileFixture(),{page,state}=f;
  try{
   await page.evaluate(()=>mediaQA.playId('old'));const before=structuredClone(state.doc),queue=await page.evaluate(()=>mediaQA.queue());state.failSave=true;await page.locator('#audio-remove-0').click();await page.locator('#audio-remove-confirm').click();await page.locator('#audio-remove-error').filter({hasText:'Could not save'}).waitFor();assert(await page.locator('#win-audio-remove').isVisible());assert.deepEqual(state.doc,before);assert(state.copied.has(existing.file));assert.deepEqual(await page.evaluate(()=>mediaQA.queue()),queue);assert(!state.commands.some(c=>c.command==='remove_audio'));
   state.failSave=false;await page.locator('#audio-remove-confirm').click();await page.locator('#win-audio-remove').waitFor({state:'hidden'});assert(!state.copied.has(existing.file));assert.deepEqual(state.doc.cds.find(c=>c.id==='old').audio,[second]);
  }finally{await f.close();}
 });
 await test('shared audio remains on disk while another item references it; missing audio can be removed',async()=>{
  const f=await profileFixture({shared:true,missing:true}),{page,state}=f;
  try{
   await page.locator('#audio-remove-0').click();await page.locator('#audio-remove-confirm').click();await page.locator('#win-audio-remove').waitFor({state:'hidden'});assert(state.copied.has(existing.file));assert(!state.commands.some(c=>c.command==='remove_audio'&&c.args.files.includes(existing.file)));
   await page.locator('#audio-remove-0').click();await page.locator('#audio-remove-confirm').click();await page.locator('#win-audio-remove').waitFor({state:'hidden'});assert.deepEqual(state.doc.cds.find(c=>c.id==='old').audio,[]);assert(state.copied.has('Unrelated.flac'));assert(await page.locator('#close-detail').evaluate(n=>n===document.activeElement));
  }finally{await f.close();}
 });
 await test('release removal deletes only its flat references after Undo expires, and Undo cancels cleanup',async()=>{
  const f=await profileFixture(),{page,state}=f;
  try{
   await page.clock.install();await page.locator('#detail-body').getByRole('button',{name:'Delete release',exact:true}).click();await page.locator('#detail-body').getByRole('button',{name:'Delete release',exact:true}).click();await page.locator('#win-detail').waitFor({state:'hidden'});assert(!state.commands.some(c=>c.command==='remove_audio'));
   await page.locator('#toast-action').click();await page.locator('#card-old').waitFor();await page.clock.fastForward(11000);assert(state.copied.has(existing.file));assert(state.copied.has(second.file));
   await page.evaluate(()=>mediaQA.openDetail('old'));await page.locator('#detail-body').getByRole('button',{name:'Delete release',exact:true}).click();await page.locator('#detail-body').getByRole('button',{name:'Delete release',exact:true}).click();await page.locator('#win-detail').waitFor({state:'hidden'});await page.clock.fastForward(11000);await until(()=>!state.copied.has(existing.file));assert(!state.copied.has(second.file));assert(state.copied.has('Unrelated.flac'));assert(state.commands.filter(c=>c.command==='remove_audio').every(c=>c.args.files.every(file=>file===existing.file||file===second.file)));
  }finally{await f.close();}
 });
 await test('remote removal cleans exact flat paths only after persistence and keeps another item’s audio',async()=>{
  const f=await profileFixture(),{page,state}=f;
  try{
   const before=structuredClone(state.doc);state.failSave=true;assert.equal(await page.evaluate(async()=>{const b=mediaQA.getBackend();try{await b.applySync(b.snapshot(),[],['old'],[],null,'fixture');return true;}catch{return false;}}),false);assert.deepEqual(state.doc,before);assert(state.copied.has(existing.file));assert(!state.commands.some(c=>c.command==='remove_audio'));
   state.failSave=false;await page.evaluate(async()=>{const b=mediaQA.getBackend();await b.applySync(b.snapshot(),[],['old'],[],null,'fixture');});await until(()=>!state.copied.has(existing.file));assert(!state.copied.has(second.file));assert(state.copied.has('Unrelated.flac'));assert(!state.doc.cds.some(c=>c.id==='old'));
  }finally{await f.close();}
 });
 await test('six icon toolbar has add-point first, restore-plus icon, Undo/Redo last, and wheel zoom remains',async()=>{
  const f=await fixture({native:true}),{page}=f;
  try{
   await editor(page);assert.deepEqual(await page.locator('.split-toolbar button').evaluateAll(ns=>ns.map(n=>n.id)),['split-add-point','split-drop','split-keep','split-reset','split-undo','split-redo']);assert.equal(await page.locator('#split-zoom-in,#split-zoom-out').count(),0);assert.match(await page.locator('#split-keep svg path').getAttribute('d'),/M8 12h8/);
   const rect=await page.locator('#split-ruler').boundingBox();await page.mouse.move(rect.x+rect.width/3,rect.y+12);await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await page.keyboard.up('Control');await page.waitForFunction(()=>mediaQA.getSplit().zoom===2);assert.equal(await page.locator('#split-zoom-value').textContent(),'2×');
  }finally{await f.close();}
 });
 await test('audio confirmation fits all locales/themes, supports keyboard cancellation and returns focus',async()=>{
  const f=await profileFixture(),{page}=f;
  try{
   for(const lang of ['en','ja','zh'])for(const theme of ['light','dark'])for(const width of [1280,360]){
    await page.setViewportSize({width,height:760});await page.evaluate(({lang,theme})=>{mediaQA.setLang(lang,false);document.documentElement.dataset.theme=theme;},{lang,theme});await page.locator('#audio-remove-0').click();
    assert(await page.locator('#audio-remove-cancel').evaluate(n=>n===document.activeElement));assert(await page.locator('#win-audio-remove .panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1));assert((await page.locator('#audio-remove-text').textContent()).includes(existing.name));await page.keyboard.press('Escape');assert(await page.locator('#audio-remove-0').evaluate(n=>n===document.activeElement));
   }
  }finally{await f.close();}
 });
 await browser.close();console.log(`${passed}/${passed+failed} flat audio / removal checks passed`);if(failed)process.exitCode=1;
}
main().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
