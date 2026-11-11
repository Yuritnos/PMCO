/* Isolated physical-media regression tests. No real accounts, drives or collection. */
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
      case 'audio_present':return args.files.map(()=>true);
      case 'tidy_covers':return null;
      case 'choose_audio_location': return state.locationResult || null;
      case 'prepare_audio_split': if(state.invalidSplit)throw 'split_invalid';return structuredClone(state.splitInfo);
      case 'start_audio_split': state.segments=structuredClone(args.segments);state.splitCount=args.segments.length;return null;
      case 'audio_split_status': return {state:state.writing?'writing':'done',progress:state.writing?30:100};
      case 'cancel_audio_split': state.writing=false;state.cancelled=true;return null;
      case 'adopt_audio_split': if(state.adoptHold)await state.adoptHold; return Array.from({length:state.splitCount},(_,i)=>{const file='old/cut-'+i+'.wav';state.copied.add(file);return {file,name:'cut-'+i+'.wav',size:100};});
      case 'add_audio': {
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
async function main(){
 browser=await playwright.chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 await test('A: six icon entrances and one child row fit every specified width and language while sticky',async()=>{
  const f=await fixture({native:true,extra:Array.from({length:50},(_,i)=>({id:'nav'+i,title:'Shelf '+i}))}),{page}=f;
  try{
   for(const lang of ['en','ja','zh'])for(const width of [860,760,640,480,360]){
    await page.setViewportSize({width,height:700});await page.evaluate(l=>mediaQA.setLang(l,false),lang);
    const rect=await page.locator('.side').boundingBox();assert(rect.height>=40&&rect.height<=48);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(await page.locator('#compact-nav button').count(),6);assert.equal(await page.locator('#compact-nav').textContent(),'');
    assert(await page.locator('#compact-nav button').evaluateAll(ns=>ns.every(n=>n.querySelector('svg')&&n.title&&n.getAttribute('aria-label')&&n.getBoundingClientRect().width>=36)));
    await page.evaluate(()=>scrollTo(0,600));assert((await page.locator('.side').boundingBox()).y>=-1);
    await page.locator('#compact-media').click();assert.equal(await page.locator('#compact-subnav button').count(),7);assert.equal(await page.locator('#compact-subnav').textContent(),'');
    await page.locator('#compact-favorite').click();assert.equal(await page.locator('#compact-nav [aria-expanded=true]').count(),1);assert((await page.locator('#compact-subnav').boundingBox()).height<=48);
    await page.keyboard.press('Escape');assert(await page.locator('#compact-subnav').isHidden());
    await page.locator('#compact-stats').click();assert(await page.locator('#win-stats').isVisible());await page.locator('#close-stats').click();
    await page.locator('#compact-settings').click();assert(await page.locator('#win-settings').isVisible());await page.locator('#close-settings').click();
   }
   await page.setViewportSize({width:1280,height:900});assert(await page.locator('.compact-nav').isHidden());assert(await page.locator('#albums').isVisible());
  }finally{await f.close();}
 });
 await test('A: keyboard access, many favorites/playlists and icon music filters preserve queue and current view',async()=>{
  const f=await fixture({native:true}),{page,state}=f;
  try{
   state.doc.meta.albums=Array.from({length:40},(_,i)=>({id:'fav'+i,name:'Favorite '+i,cdIds:['old']}));
   state.doc.meta.playlists=Array.from({length:20},(_,i)=>({id:'list'+i,name:'Playlist '+i,items:[]}));
   state.doc.cds.forEach(cd=>cd.audio=[{file:cd.id+'/saved.wav',name:'Saved.wav',track:1}]);
   await page.reload();await page.locator('#card-old').waitFor();await page.setViewportSize({width:360,height:700});
   await page.locator('#compact-media').focus();await page.keyboard.press('ArrowDown');assert(await page.locator('#compact-choice-all').evaluate(n=>n===document.activeElement));
   await page.locator('[id="compact-choice-media:vinyl"]').click();assert(await page.locator('#card-m3').isVisible());assert.equal(await page.locator('#compact-media').getAttribute('aria-pressed'),'true');
   await page.locator('#compact-favorite').click();assert(await page.locator('#compact-subnav').evaluate(n=>n.scrollWidth>n.clientWidth));await page.locator('#compact-choice-fav39').click();assert.equal(await page.locator('#compact-choice-fav39').getAttribute('aria-pressed'),'true');await page.locator('#compact-new-favorite').click();await page.keyboard.press('Escape');assert(await page.locator('#compact-favorite').evaluate(n=>n===document.activeElement));
   await page.locator('#compact-playlist').click();assert.equal(await page.locator('#compact-subnav').textContent(),'');await page.locator('[id="compact-choice-pl:list19"]').click();assert.equal(await page.locator('#compact-playlist').getAttribute('aria-pressed'),'true');await page.locator('#compact-new-playlist').click();await page.keyboard.press('Escape');assert(await page.locator('#compact-playlist').evaluate(n=>n===document.activeElement));
   await page.locator('#compact-music').click();assert.equal(await page.locator('#compact-subnav button').count(),7);await page.locator('#compact-choice-music').click();await page.evaluate(()=>mediaQA.playId('old'));const queue=await page.evaluate(()=>mediaQA.queue()),entry=await page.evaluate(()=>mediaQA.currentEntry());
   await page.locator('[id="compact-choice-music:cd"]').click();assert.equal(await page.locator('#grid .card').count(),2);assert.deepEqual(await page.evaluate(()=>mediaQA.queue()),queue);assert.deepEqual(await page.evaluate(()=>mediaQA.currentEntry()),entry);
   await page.locator('#compact-music').focus();await page.keyboard.press('ArrowRight');assert(await page.locator('#compact-playlist').evaluate(n=>n===document.activeElement));await page.keyboard.press('Escape');assert(await page.locator('#compact-subnav').isHidden());
   await page.locator('#compact-favorite').click();await page.mouse.click(4,680);assert(await page.locator('#compact-subnav').isHidden());
  }finally{await f.close();}
 });
 await test('B: condition saves and reopens for seven media, exports, and never accepts online lookup values',async()=>{
  const f=await fixture(),{page,state}=f;
  try{
   for(const medium of ['cd','vinyl','cassette','sacd','dvd','bluray','other']){
    await page.evaluate(cd=>mediaQA.startEdit(cd),{id:'old',title:'Condition fixture',medium,hub:'Legacy ring'});await page.locator('#more-details').evaluate(n=>n.open=true);
    assert(await page.locator('#condition').isVisible());assert.equal(await page.locator('#hub').isVisible(),medium==='cd');
    const value=medium==='cd'?' nm ':medium+' 良好 9';await page.locator('#condition').fill(value);
    await page.evaluate(()=>mediaQA.fillFromLookup({title:'Edition',condition:'BAD ONLINE VALUE'}));assert.equal(await page.locator('#condition').inputValue(),value);
    await save(page);assert.equal(state.doc.cds.find(c=>c.id==='old').condition,value);assert.equal(state.doc.cds.find(c=>c.id==='old').hub,'Legacy ring');
    await page.evaluate(cd=>mediaQA.startEdit(cd),state.doc.cds.find(c=>c.id==='old'));assert.equal(await page.locator('#condition').inputValue(),value);
    const csv=await page.evaluate(()=>mediaQA.exportCsv());assert(csv.includes(value));await page.evaluate(()=>mediaQA.closeWin('cd',true));
    await page.evaluate(()=>mediaQA.openDetail('old'));assert((await page.locator('#detail-body').textContent()).includes(value));await page.locator('#close-detail').click();
   }
   Object.assign(state.doc.cds.find(c=>c.id==='old'),{title:'Legacy SACD',medium:'sacd',hub:'透明圈'});await page.reload();await page.locator('#card-old').waitFor();await page.evaluate(cd=>mediaQA.startEdit(cd),state.doc.cds.find(c=>c.id==='old'));await save(page);assert.equal(state.doc.cds.find(c=>c.id==='old').hub,'透明圈');
  }finally{await f.close();}
 });
 await test('B: CD paired layout stacks at 480, SACD hub survives switches, condition labels and presets localize',async()=>{
  const f=await fixture(),{page}=f;
  try{
   await page.evaluate(()=>mediaQA.startEdit({id:'old',title:'Conditions',hub:'Ring',condition:'nm'}));await page.locator('#more-details').evaluate(n=>n.open=true);
   for(const lang of ['en','ja','zh']){
    await page.evaluate(l=>mediaQA.setLang(l,false),lang);assert((await page.locator('label[for=condition]').textContent()).trim());
    assert.deepEqual(await page.locator('#condition-options option').evaluateAll(ns=>ns.map(n=>n.value)),['M','NM','VG+','VG','G+','G','F','P']);
    await page.setViewportSize({width:760,height:900});const a=await page.locator('#hub').boundingBox(),b=await page.locator('#condition').boundingBox();assert(Math.abs(a.y-b.y)<2);assert(b.x>a.x);
    await page.setViewportSize({width:480,height:900});const c=await page.locator('#hub').boundingBox(),d=await page.locator('#condition').boundingBox();assert(d.y>c.y);assert(Math.abs(c.x-d.x)<2);
    await page.locator('#medium').selectOption('sacd');assert(await page.locator('#hub').isHidden());await page.locator('#medium').selectOption('cd');assert.equal(await page.locator('#hub').inputValue(),'Ring');
   }
   await page.locator('#condition').fill('');await save(page);await page.evaluate(()=>mediaQA.openDetail('old'));assert.equal(await page.locator('.facts dt').filter({hasText:'媒介品相'}).count(),0);
  }finally{await f.close();}
 });
 await test('B: real sync serialization preserves condition through mocked upload and newer remote download',async()=>{
  const f=await fixture({native:true}),{page,state}=f;
  try{
   state.doc.sync={account:'isolated-user',metaAt:1,deleted:{}};
   await page.evaluate(()=>localStorage.setItem('cdc.session',JSON.stringify({access_token:'fixture-only',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:'isolated-user',email:'fixture@example.test'}})));
   await page.reload();await page.locator('#card-old').waitFor();await page.evaluate(()=>mediaQA.startEdit({id:'old',title:'Sync condition'}));await page.locator('#more-details').evaluate(n=>n.open=true);await page.locator('#condition').fill('VG+ 手写');await save(page);
   await page.evaluate(()=>{window.PMCO_TRIAL=false;return mediaQA.Cloud.syncNow();});assert.equal(state.cloudRows.find(r=>r.id==='old').data.condition,'VG+ 手写');
   const row=state.cloudRows.find(r=>r.id==='old');row.data.condition='NM remote';row.updated_ms=Date.now()+10000;
   await page.evaluate(()=>mediaQA.Cloud.syncNow());assert.equal(state.doc.cds.find(c=>c.id==='old').condition,'NM remote');
  }finally{await f.close();}
 });
 await test('C3: all six automatic examples, zero durations, half-second tolerance and tiny fragments',async()=>{
  const f=await fixture(),{page}=f;
  try{
   const results=await page.evaluate(()=>[[600,[]],[600,[180,240,300]],[720,[180,240,300]],[810,[180,240,300]],[720,[180,0,300]],[600,[900,240]]].map(([T,d])=>{const a=mediaQA.splitAuto(T*1000,1000,d);return {parts:a.parts.map(p=>[p.start/1000,p.end/1000,p.keep]),warnings:a.warnings};}));
   assert.deepEqual(results.map(x=>x.parts),[[[0,600,true]],[[0,180,true],[180,420,true],[420,600,false]],[[0,180,true],[180,420,true],[420,720,true]],[[0,180,true],[180,420,true],[420,720,true],[720,810,false]],[[0,180,true],[180,480,true],[480,720,false]],[[0,600,true]]]);assert(results[4].warnings.some(x=>x.includes('2')));assert(results[5].warnings.length);
   const tolerance=await page.evaluate(()=>mediaQA.splitAuto(99500,1000,[100]).parts);assert.deepEqual(tolerance.map(p=>[p.start,p.end,p.keep]),[[0,99500,true]]);
   const tiny=await page.evaluate(()=>mediaQA.splitAuto(100050,1000,[100]).parts);assert.deepEqual(tiny.map(p=>[p.start,p.end,p.keep]),[[0,100050,true]]);
  }finally{await f.close();}
 });
 await test('C4: selecting, discarding, restoring and undo/redo keep segment positions and summary exact',async()=>{
  const f=await fixture({native:true}),{page}=f;
  try{
   await editor(page);assert.equal(await page.locator('#win-split select').count(),0);
   await page.locator('.split-part').nth(0).click();await page.locator('.split-part').nth(1).click({modifiers:['Control']});assert.equal(await page.locator('.split-part.is-selected').count(),2);
   await page.locator('#split-drop').click();assert.equal(await page.locator('.split-part.is-gap').count(),3);assert((await page.locator('#split-summary').textContent()).includes('0 files'));
   await page.keyboard.press('Control+z');assert.equal(await page.locator('.split-part.is-gap').count(),1);await page.keyboard.press('Control+Shift+z');assert.equal(await page.locator('.split-part.is-gap').count(),3);
   await page.locator('#split-keep').click();assert.equal(await page.locator('.split-part.is-gap').count(),1);
   await page.keyboard.press('Control+a');assert.equal(await page.locator('.split-part.is-selected').count(),3);
   await page.locator('.split-part').first().click();await page.locator('.split-part').last().click({modifiers:['Shift']});assert.equal(await page.locator('.split-part.is-selected').count(),3);
   await page.locator('#split-close').click();await page.locator('#split-ask-no').click();assert(await page.locator('#win-split').isVisible());await page.locator('#split-close').click();await page.locator('#split-ask-yes').click();await page.locator('#win-split').waitFor({state:'hidden'});assert.equal(f.state.copied.size,0);assert(await page.locator('#form-audio-split').evaluate(n=>n===document.activeElement));
  }finally{await f.close();}
 });
 await test('C4: points add, move precisely, reject invalid input, merge and reset with confirmation',async()=>{
  const f=await fixture({native:true}),{page}=f;
  try{
   await editor(page);await page.evaluate(()=>mediaQA.splitSeek(60000,false));await page.locator('#split-add-point').click();assert.equal(await page.locator('.split-part').count(),4);
   await page.locator('.split-point').first().click();await page.locator('#split-point-time').fill('1:05.123');await page.locator('#split-point-time').press('Tab');assert.equal(await page.evaluate(()=>mediaQA.getSplit().parts[0].end),65123);
   await page.locator('#split-point-time').fill('99:99.000');await page.locator('#split-point-time').press('Tab');assert.equal(await page.locator('#split-point-time').inputValue(),'1:05.123');
   await page.locator('.split-point').first().focus();await page.keyboard.press('Delete');assert(await page.locator('#split-ruler').evaluate(n=>n===document.activeElement));assert.equal(await page.locator('.split-part').count(),3);await page.locator('#split-undo').click();assert.equal(await page.locator('.split-part').count(),4);
   await page.locator('#split-reset').click();assert(await page.locator('#win-split-confirm').isVisible());await page.locator('#split-ask-yes').click();assert.equal(await page.locator('.split-part').count(),3);
   await page.evaluate(()=>mediaQA.splitZoom(2));assert.equal(await page.locator('#split-zoom-value').textContent(),'2×');assert(await page.locator('#split-scroll').evaluate(n=>n.scrollWidth>n.clientWidth));
  }finally{await f.close();}
 });
 await test('C4: multi-move preserves lengths, intervals, states and clamps both edges; keyboard nudges undo',async()=>{
  const f=await fixture({native:true}),{page}=f;
  try{
   const moved=await page.evaluate(()=>{const parts=[{id:'a',start:0,end:1000,keep:true},{id:'gap',start:1000,end:2000,keep:false},{id:'b',start:2000,end:3000,keep:true},{id:'rest',start:3000,end:6000,keep:false}];return mediaQA.splitMove(parts,['a','b'],1000,6000,1000);});
   assert.deepEqual(moved.filter(p=>['a','b'].includes(p.id)).map(p=>[p.start,p.end,p.keep]),[[1000,2000,true],[3000,4000,true]]);assert.equal(moved[0].keep,false);
   const clamped=await page.evaluate(()=>mediaQA.splitMove([{id:'x',start:1000,end:2000,keep:true},{id:'y',start:2000,end:3000,keep:false}],['x','y'],99999,3000,1000));assert.deepEqual(clamped.map(p=>[p.start,p.end]),[[1000,2000],[2000,3000]]);
   await editor(page);await page.locator('.split-part').nth(1).click();await page.locator('.split-part').nth(1).press('ArrowRight');const selected=await page.evaluate(()=>{const ed=mediaQA.getSplit();return ed.parts.find(p=>ed.selected.has(p.id));});assert.equal(selected.start,180100);assert.equal(selected.end,420100);await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>mediaQA.getSplit().parts[1].start),180000);
  }finally{await f.close();}
 });
 await test('C4: pointer dragging moves selected intervals and boundaries; point keyboard focus survives repeated nudges',async()=>{
  const f=await fixture({native:true}),{page}=f;
  try{
   await editor(page);await page.locator('.split-part').nth(1).click();const rect=await page.locator('.split-part').nth(1).boundingBox();
   await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.keyboard.down('Alt');await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+20,rect.y+rect.height/2,{steps:4});await page.mouse.up();await page.keyboard.up('Alt');
   const shifted=await page.evaluate(()=>{const ed=mediaQA.getSplit();return ed.parts.find(p=>ed.selected.has(p.id));});assert(shifted.start>180000);assert.equal(shifted.end-shifted.start,240000);
   await page.locator('#split-undo').click();const point=page.locator('.split-point').first(),pr=await point.boundingBox();await page.mouse.move(pr.x+pr.width/2,pr.y+4);await page.mouse.down();await page.mouse.move(pr.x+pr.width/2+15,pr.y+4,{steps:4});await page.mouse.up();assert(await page.evaluate(()=>mediaQA.getSplit().parts[0].end>180000));
   await page.locator('.split-point').first().focus();const before=await page.evaluate(()=>mediaQA.getSplit().parts[0].end);await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>mediaQA.getSplit().parts[0].end),before+2);
  }finally{await f.close();}
 });
 await test('C5: example 2 writes only retained ranges, stages sequential assignments and saves after release confirmation',async()=>{
  const f=await fixture({native:true}),{page,state}=f;
  try{
   await editor(page);await acceptWrite(page);assert.deepEqual(state.segments,[{start:0,end:180000},{start:180000,end:420000}]);assert.equal((state.doc.cds.find(c=>c.id==='old').audio||[]).length,0);
   assert.deepEqual(await page.evaluate(()=>mediaQA.getDraft().list.map(a=>a.track)),[1,2]);await save(page);assert.deepEqual(state.doc.cds.find(c=>c.id==='old').audio.map(a=>a.track),[1,2]);
  }finally{await f.close();}
 });
 await test('C5: gaps compact assignments, existing slots stay intact, excess files remain unassigned and discard cleans new copies',async()=>{
  const f=await fixture({native:true}),{page,state}=f;
  try{
   state.splitInfo.frames=300000;await editor(page,['1:00'],[{file:'old/saved.wav',name:'saved.wav',size:1,track:1}]);
   await page.evaluate(()=>{mediaQA.splitSeek(30000,false);mediaQA.splitAddPoint();});await acceptWrite(page);
   assert.deepEqual(await page.evaluate(()=>mediaQA.getDraft().list.map(a=>a.track)),[1,0,0]);assert.equal(state.copied.size,2);
   await page.locator('#close-cd').click();await page.locator('#cd-unsaved-discard').click();await until(()=>state.copied.size===0);
  }finally{await f.close();}
 });
 await test('C5: cancellation during writing and delayed adoption leaves no new files or draft entries',async()=>{
  const f=await fixture({native:true}),{page,state}=f;
  try{
   await editor(page);state.writing=true;await page.locator('#split-confirm').click();await page.locator('#split-ask-yes').click();await page.locator('#split-progress').waitFor({state:'visible'});await page.locator('#split-close').click();await page.locator('#split-ask-yes').click();await page.locator('#win-split').waitFor({state:'hidden'});assert(state.cancelled);assert.equal(state.copied.size,0);
   await page.locator('#form-audio-split').click();await page.locator('#win-split').waitFor({state:'visible'});let release;state.adoptHold=new Promise(r=>release=r);await page.locator('#split-confirm').click();await page.locator('#split-ask-yes').click();await until(()=>state.commands.some(c=>c.command==='adopt_audio_split'));await page.locator('#split-close').click();await page.locator('#split-ask-yes').click();await page.locator('#win-split').waitFor({state:'hidden'});release();await until(()=>state.commands.some(c=>c.command==='remove_audio'));assert.equal(state.copied.size,0);assert.deepEqual(await page.evaluate(()=>mediaQA.getDraft().list),[]);
  }finally{await f.close();}
 });
 await test('C1 and 3.5: invalid durations abort, old folder action is absent, folder change carries localized merge choices',async()=>{
  const f=await fixture({native:true}),{page,state}=f;
  try{
   await page.evaluate(()=>mediaQA.startEdit({id:'old',title:'Bad source'}));await page.locator('#form-audio-set').evaluate(n=>n.open=true);assert.equal(await page.locator('#form-audio-folder').count(),0);state.invalidSplit=true;await page.locator('#form-audio-split').click();assert(await page.locator('#win-split').isHidden());assert.equal(await page.evaluate(()=>mediaQA.getDraft().busy),false);
   await page.evaluate(()=>mediaQA.closeWin('cd',true));await page.locator('#open-settings').click();state.locationResult='C:\\Chosen';await page.locator('#audio-location-choose').click();await until(()=>state.commands.some(c=>c.command==='choose_audio_location'));assert((await page.locator('#audio-location-path').textContent()).includes('Chosen'));const command=state.commands.find(c=>c.command==='choose_audio_location');assert(command.args.prompt.includes('merge'));assert(command.args.no.includes('Switch'));
  }finally{await f.close();}
 });
 await test('refinement: six localized icon tools stay on one row and audio strip is slimmer',async()=>{
  const f=await fixture({native:true}),{page}=f;
  try{
   for(const lang of ['en','ja','zh'])for(const width of [1280,480,360]){
    await page.setViewportSize({width,height:900});await page.evaluate(l=>mediaQA.setLang(l,false),lang);await editor(page);
    assert.equal(await page.locator('#split-select-all,#split-preview,#split-zoom-in,#split-zoom-out').count(),0);assert.deepEqual(await page.locator('.split-toolbar button').evaluateAll(ns=>ns.map(n=>n.id)),['split-add-point','split-drop','split-keep','split-reset','split-undo','split-redo']);assert.equal(await page.locator('.split-toolbar button').count(),6);assert.equal(await page.locator('.split-toolbar').textContent(),'');
    const geometry=await page.locator('.split-toolbar').evaluate(n=>{const buttons=[...n.children],rects=buttons.map(b=>b.getBoundingClientRect());return {oneRow:rects.every(r=>Math.abs(r.y-rects[0].y)<1),labelled:buttons.every(b=>b.title&&b.getAttribute('aria-label')&&b.querySelector('svg')),fit:n.scrollWidth<=n.clientWidth};});assert.deepEqual(geometry,{oneRow:true,labelled:true,fit:true});
    const height=(await page.locator('.split-part').first().boundingBox()).height;assert(height>=60&&height<80);
    await page.locator('#split-close').click();await page.locator('#split-ask-yes').click();await page.locator('#win-split').waitFor({state:'hidden'});await page.evaluate(()=>mediaQA.closeWin('cd',true));
   }
  }finally{await f.close();}
 });
 await test('refinement: ruler and audio strip click/drag seek without moving segments; double click adds a cut',async()=>{
  const f=await fixture({native:true}),{page}=f;
  try{
   await editor(page);const original=await page.evaluate(()=>mediaQA.getSplit().parts.map(p=>[p.start,p.end,p.keep]));const rect=await page.locator('#split-ruler').boundingBox();
   await page.mouse.move(rect.x+rect.width*.1,rect.y+16);await page.mouse.down();await page.mouse.move(rect.x+rect.width*.7,rect.y+16,{steps:6});await page.mouse.up();assert(Math.abs(await page.evaluate(()=>mediaQA.getSplit().head)-420000)<1000);
   const strip=await page.locator('.split-part').first().boundingBox();await page.mouse.click(strip.x+strip.width*.4,strip.y+strip.height/2);assert(Math.abs(await page.evaluate(()=>mediaQA.getSplit().head)-72000)<1000);
   await page.mouse.move(strip.x+strip.width*.2,strip.y+strip.height/2);await page.mouse.down();await page.mouse.move(strip.x+strip.width*.7,strip.y+strip.height/2,{steps:6});await page.mouse.up();assert(Math.abs(await page.evaluate(()=>mediaQA.getSplit().head)-126000)<1000);
   assert.deepEqual(await page.evaluate(()=>mediaQA.getSplit().parts.map(p=>[p.start,p.end,p.keep])),original);
   await page.locator('.split-part').first().dblclick({position:{x:strip.width*.4,y:strip.height/2}});assert.equal(await page.locator('.split-part').count(),4);assert(Math.abs(await page.evaluate(()=>mediaQA.getSplit().parts[0].end)-72000)<1000);
  }finally{await f.close();}
 });
 await test('refinement: centered triangular point indicators match sample boundaries through zoom and scroll',async()=>{
  const f=await fixture({native:true}),{page}=f;
  try{
   await editor(page);
   await page.locator('.split-point').first().click();assert(await page.locator('#split-point-row').isVisible());assert.equal(await page.locator('#split-point-time').inputValue(),'3:00.000');
   for(const zoom of [1,2,4,8,16,32]){
    if(zoom>1)await page.evaluate(()=>mediaQA.splitZoom(2));
    await page.locator('#split-scroll').evaluate(n=>n.scrollLeft=n.scrollWidth*.27);
    const checks=await page.evaluate(()=>{const ed=mediaQA.getSplit(),timeline=document.getElementById('split-timeline').getBoundingClientRect();return [...document.querySelectorAll('.split-point')].map(n=>{const rect=n.getBoundingClientRect(),i=Number(n.dataset.point);return {error:Math.abs(rect.left+rect.width/2-(timeline.left+timeline.width*ed.parts[i].end/ed.info.frames)),triangle:getComputedStyle(n,'::before').clipPath,lineWidth:getComputedStyle(n,'::after').width};});});assert(checks.every(c=>c.error<.75&&c.triangle.includes('polygon')&&c.triangle.includes('50% 100%')&&c.lineWidth==='2px'));
   }
  }finally{await f.close();}
 });
 await test('refinement: Ctrl wheel zoom keeps the time under the pointer fixed while already scrolled',async()=>{
  const f=await fixture({native:true}),{page}=f;
  try{
   await editor(page);const original=await page.evaluate(()=>mediaQA.getSplit().parts.map(p=>[p.start,p.end]));
   async function wheel(fraction,delta,zoom){
    const rect=await page.locator('#split-scroll').boundingBox(),x=rect.x+rect.width*fraction,y=rect.y+22;
    const before=await page.evaluate(x=>{const n=document.getElementById('split-timeline').getBoundingClientRect();return (x-n.left)/n.width;},x);
    await page.mouse.move(x,y);await page.keyboard.down('Control');await page.mouse.wheel(0,delta);await page.keyboard.up('Control');await page.waitForFunction(z=>mediaQA.getSplit().zoom===z,zoom);
    const after=await page.evaluate(x=>{const n=document.getElementById('split-timeline').getBoundingClientRect();return (x-n.left)/n.width;},x);assert(Math.abs(after-before)<.001);
   }
   await wheel(.23,-100,2);await wheel(.77,-100,4);await page.locator('#split-scroll').evaluate(n=>n.scrollLeft=n.clientWidth*1.25);await wheel(.68,100,2);
   assert.deepEqual(await page.evaluate(()=>mediaQA.getSplit().parts.map(p=>[p.start,p.end])),original);
  }finally{await f.close();}
 });
 await test('visual: split editor is usable in all locales, themes and narrow widths',async()=>{
  const f=await fixture({native:true}),{page}=f;
  try{
   const out=path.join(require('node:os').tmpdir(),'pmco-34-qa');fs.mkdirSync(out,{recursive:true});
   for(const lang of ['en','ja','zh'])for(const theme of ['light','dark'])for(const width of [1280,480,360]){
    await page.setViewportSize({width,height:900});await page.evaluate(({lang,theme})=>{mediaQA.setLang(lang,false);document.documentElement.dataset.theme=theme;},{lang,theme});
    await editor(page);assert(await page.locator('#win-split .panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1));assert((await page.locator('#split-summary').textContent()).trim());
    if(lang==='zh'&&[1280,360].includes(width)&&theme==='dark')await page.screenshot({path:path.join(out,'split-'+width+'.png')});
    await page.locator('#split-close').click();await page.locator('#split-ask-yes').click();await page.locator('#win-split').waitFor({state:'hidden'});await page.evaluate(()=>mediaQA.closeWin('cd',true));
   }
  }finally{await f.close();}
 });
 await browser.close();console.log(`${passed}/${passed+failed} improvements 3.4/3.5 checks passed`);if(failed)process.exitCode=1;
}
main().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
