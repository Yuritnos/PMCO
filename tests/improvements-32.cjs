/* Isolated physical-media regression tests. No real accounts, drives or collection. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8').replace('  /* ---------- start ---------- */',
  '  window.mediaQA = { fillMetadataSuggestions, renderHandlePolicy, openProfile, Cloud, listFields, cardFields, renderGrid, startEdit, setLang, openDetail, discTracks, dgMedia, dgDiscLists, discogsSource, lookupDiscData, populateLookupDrafts, playId: function(id) { playAudio(cdById(id)); }, renderPlaylist, moveCard, resetWorks, readWorks, cdFormDirty, closeWin, queue: function() { return clone(player.queue); }, currentEntry };\n  /* ---------- start ---------- */');
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
  const state = {doc:{cds:structuredClone(seed.concat(extra)),meta:{albums:[{id:'fav',name:'Favorites',cdIds:['m1','m2','m3']}],playlists:[],settings:{lang:'en'}}}, errors:[], commands:[], copied:new Set()};
  const context = await browser.newContext({viewport:{width:1280,height:900}, reducedMotion:'reduce'});
  if(native) await context.exposeBinding('__mediaInvoke',async(_,command,args={})=>{
    state.commands.push({command,args});
    switch(command){
      case 'load_data':return structuredClone(state.doc);
      case 'save_data':if(state.failSave)throw Error('isolated failure');state.doc=structuredClone(args.data);return null;
      case 'audio_root_dir':return 'C:\\isolated-media\\audio';
      case 'covers_root_dir':return 'C:\\isolated-media\\covers';
      case 'list_backups':return [{file:'collection.backup.json',modified:1794100000000,count:7}];
      case 'audio_present':return args.files.map(()=>true);
      case 'tidy_covers':return null;
      case 'add_audio_folder': {
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
    if(url.hostname === 'api.discogs.com')return route.fulfill({json:state.lookup||{}});
    return route.abort();
  });
  const page=await context.newPage(); page.setDefaultTimeout(6000); page.on('pageerror',e=>state.errors.push(e.message));
  await page.goto('http://media.test/'); await page.locator('#card-old').waitFor();
  return {page,state,close:async()=>{await context.close();assert.deepEqual(state.errors,[]);}};
}
const view = async(page,m) => { if(await page.locator('#chip-all').getAttribute('aria-expanded')==='false')await page.locator('#chip-all').press('ArrowRight');await page.locator('[id="chip-media:'+m+'"]').click(); };
async function save(page) { await page.locator('#submit').click(); await page.locator('#win-cd').waitFor({state:'hidden'}); }

async function main(){
 browser=await playwright.chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 await test('quantity defaults, stepper, dirty guard, validation and whole-set save/reopen',async()=>{const f=await fixture(),{page,state}=f;try{
 await page.locator('#card-old').click();await page.locator('#detail-body').getByRole('button',{name:'Edit',exact:true}).click();
 assert.equal(await page.locator('#collection-quantity').inputValue(),'1');assert.equal(await page.locator('#quantity-plus, #quantity-minus').count(),0);await page.locator('#collection-quantity').press('ArrowUp');assert.equal(await page.locator('#collection-quantity').inputValue(),'2');assert(await page.evaluate(()=>mediaQA.cdFormDirty()));await page.locator('#collection-quantity').press('ArrowDown');assert.equal(await page.locator('#collection-quantity').inputValue(),'1');
 await page.locator('#collection-quantity').fill('0');await page.locator('#submit').click();assert(await page.locator('#quantity-error').textContent());
 await page.locator('#collection-quantity').fill('3');await save(page);assert.equal(state.doc.cds.find(c=>c.id==='old').quantity,3);assert((await page.locator('#count').textContent()).includes('9 items'));
 await page.evaluate(cd=>mediaQA.startEdit(cd),state.doc.cds.find(c=>c.id==='m1'));await page.locator('#collection-quantity').fill('2');await save(page);
 assert(state.doc.cds.filter(c=>c.set).every(c=>c.quantity===2));
 await page.evaluate(cd=>mediaQA.startEdit(cd),state.doc.cds.find(c=>c.id==='m2'));assert.equal(await page.locator('#collection-quantity').inputValue(),'2');
 }finally{await f.close();}});
 await test('settings help is compact and keyboard accessible; list choices persist independently',async()=>{const f=await fixture(),{page,state}=f;try{
 await page.locator('#open-settings').click();assert.equal(await page.locator('#win-settings .settings-info').count(),5);
 const info=page.locator('[data-help="cardDefaultHint"]');await info.focus();assert(await page.locator('#settings-help').isVisible());await page.keyboard.press('Escape');assert.equal(await page.locator('#settings-help').count(),0);
 await page.locator('#lf-toggle').click();await page.locator('#lf-notes').check();assert(state.doc.meta.settings.listFields.includes('notes'));assert.equal(state.doc.meta.settings.cardFields,undefined);
 for(const lang of ['en','ja','zh']){await page.evaluate(l=>mediaQA.setLang(l,false),lang);for(const width of [420,1280]){await page.setViewportSize({width,height:900});await page.locator('#audio-location-sect').evaluate(n=>n.hidden=false);const dir=path.join(os.tmpdir(),'pmco-32-qa');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'settings-'+lang+'-'+width+'.png')});}}await page.evaluate(()=>mediaQA.setLang('en',false));await page.setViewportSize({width:1280,height:900});
 await page.locator('#close-settings').click();await page.locator('#view-list').click();assert((await page.locator('.ltable th').allTextContents()).includes('Notes'));await page.reload();await page.locator('#row-old').waitFor();assert((await page.locator('.ltable th').allTextContents()).includes('Notes'));
 }finally{await f.close();}});
 await test('contextual medium badges and editable metadata suggestions preserve custom values',async()=>{const f=await fixture(),{page,state}=f;try{
 assert.equal(await page.locator('#card-old .medium-badge').textContent(),'CD');assert((await page.locator('#card-m1 .medium-badge').textContent()).includes('2 CD'));
 await view(page,'cd');assert.equal(await page.locator('#card-old .medium-badge').count(),0);
 await page.evaluate(cd=>mediaQA.startEdit(cd),state.doc.cds[0]);await page.locator('#more-details').evaluate(n=>n.open=true);
 for(const id of ['label','issuer','manufacturer','madeIn']){assert(await page.locator('#suggest-'+id+' option').count()>1);await page.locator('#'+id).fill('Custom '+id);}
 await save(page);assert.equal(state.doc.cds.find(c=>c.id==='old').issuer,'Custom issuer');
 }finally{await f.close();}});
 await test('Discogs company and explicit recording dates fill; copyright/release years never substitute',async()=>{const f=await fixture(),{page,state}=f;try{
 state.lookup={id:1,title:'Fixture',year:2000,companies:[{entity_type_name:'Record Company',name:'Fixture Issuer'}],notes:'Recorded in London, May 1985 and June 1987. ℗ 1999',tracklist:[]};
 var got=await page.evaluate(()=>mediaQA.discogsSource.details({id:1},''));assert.equal(got.issuer,'Fixture Issuer');assert.equal(got.recordingYear,'1985 / 1987');assert.equal(got.releaseYear,'2000');
 state.lookup.notes='Recorded in 1985. Remastered in 1999.';got=await page.evaluate(()=>mediaQA.discogsSource.details({id:1},''));assert.equal(got.recordingYear,'1985');
 state.lookup.notes='℗ 1999; released 2000';got=await page.evaluate(()=>mediaQA.discogsSource.details({id:1},''));assert.equal(got.recordingYear,undefined);
 }finally{await f.close();}});
 await test('settings captions keep information icons beside their text in every language and size',async()=>{const f=await fixture({native:true}),{page}=f;try{
 await page.locator('#open-settings').click();await page.locator('#backup-box').waitFor();
 for(const lang of ['en','ja','zh'])for(const width of [420,1280]){
 await page.evaluate(l=>mediaQA.setLang(l,false),lang);await page.setViewportSize({width,height:900});
 for(const help of ['cardDefaultHint','backupNote']){
 const geometry=await page.locator('[data-help="'+help+'"]').evaluate(n=>{const text=n.previousElementSibling.getBoundingClientRect(),icon=n.getBoundingClientRect();return {text:{x:text.x,right:text.right,y:text.y,bottom:text.bottom},icon:{x:icon.x,y:icon.y,bottom:icon.bottom,width:icon.width}};});
 assert(geometry.icon.x>=geometry.text.right-1,JSON.stringify(geometry));assert(geometry.icon.width<40);assert(geometry.icon.y<geometry.text.bottom&&geometry.icon.bottom>geometry.text.y,JSON.stringify(geometry));
 }
 const dir=path.join(os.tmpdir(),'pmco-display-qa');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'settings-'+lang+'-'+width+'.png')});
 }
 }finally{await f.close();}});
 await test('statistics time follows Works on the same desktop row and remains readable on narrow screens',async()=>{const f=await fixture({extra:[{id:'long',title:'Long fixture',works:[{title:'Long work',duration:'38:15:00',tracks:[]}]}]}),{page}=f;try{
 await page.locator('#open-stats').click();
 for(const lang of ['en','ja','zh'])for(const width of [420,768,1280]){
 await page.evaluate(l=>mediaQA.setLang(l,false),lang);await page.setViewportSize({width,height:900});
 if(lang==='en')assert.equal(await page.locator('.stat-tile.time b').textContent(),'38 h 18 min');
 const boxes=await page.locator('.stat-tile').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,overflow:n.scrollWidth>n.clientWidth};}));
 assert.equal(boxes.length,4);assert(boxes.every(b=>!b.overflow),JSON.stringify(boxes));
 if(width>600){assert(boxes.every(b=>Math.abs(b.y-boxes[0].y)<1),JSON.stringify(boxes));assert(boxes[3].x>boxes[2].x);}
 else{assert.equal(boxes[2].y,boxes[3].y);assert(boxes[2].y>boxes[0].y);}
 const dir=path.join(os.tmpdir(),'pmco-display-qa');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'stats-'+lang+'-'+width+'.png')});
 }
 }finally{await f.close();}});
 await test('User ID explanation wraps normally and monthly notice continues in the same paragraph',async()=>{const f=await fixture(),{page}=f;try{
 await page.evaluate(()=>{mediaQA.Cloud.profile=()=>({nickname:'Fixture',handle:'fixture_123',avatar:null,handlePolicy:true,handleChangedAt:null});mediaQA.Cloud.email=()=> 'fixture@example.test';mediaQA.Cloud.loadProfile=()=>Promise.resolve();mediaQA.openProfile();});
 for(const lang of ['en','ja','zh'])for(const width of [420,1280]){
 await page.evaluate(l=>{mediaQA.setLang(l,false);mediaQA.renderHandlePolicy();},lang);await page.setViewportSize({width,height:900});
 assert(await page.locator('#pf-handle-hint').evaluate(n=>{const p=n.parentElement;return n.nextElementSibling.id==='pf-handle-policy'&&p.tagName==='P'&&getComputedStyle(n).whiteSpace==='normal'&&p.scrollWidth<=p.clientWidth;}));
 assert(await page.locator('#pf-handle-policy').evaluate(n=>getComputedStyle(n).display==='inline'&&n.textContent.length>0));
 const dir=path.join(os.tmpdir(),'pmco-display-qa');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'profile-'+lang+'-'+width+'.png')});
 }
 assert.equal(await page.locator('#pf-handle').getAttribute('aria-describedby'),'pf-handle-hint pf-handle-policy');
 }finally{await f.close();}});
 await test('suggestions collapse aliases, pin country order and preserve legacy stored/input values',async()=>{const extra=[
 {id:'alias1',title:'Alias 1',manufacturer:'Universal M&L',madeIn:'US',label:'RCA Red Seal'},
 {id:'alias2',title:'Alias 2',manufacturer:'Universal M & L',madeIn:'Europe',label:'RCA red seal'},
 {id:'alias3',title:'Alias 3',manufacturer:'Universal M & L, Germany',madeIn:'Austria'},
 {id:'alias4',title:'Alias 4',manufacturer:'Universal M&L',madeIn:'Korea'},
 {id:'alias5',title:'Alias 5',madeIn:'Netherlands'}
 ];const f=await fixture({extra}),{page,state}=f;try{
 const before=structuredClone(state.doc);await page.evaluate(cd=>mediaQA.startEdit(cd),extra[2]);await page.locator('#more-details').evaluate(n=>n.open=true);
 const options=async field=>page.locator('#suggest-'+field+' option').evaluateAll(nodes=>nodes.map(n=>n.value));
 assert.deepEqual((await options('manufacturer')).filter(n=>/^Universal/i.test(n)),['Universal M&L']);
 assert.deepEqual((await options('label')).filter(n=>/^RCA/i.test(n)),['RCA Red Seal']);
 const countries=await options('madeIn');assert.deepEqual(countries.slice(0,2),['West Germany','Japan']);assert(countries.includes('United States'));assert(!countries.some(n=>['US','Europe','Austria','Korea','Netherlands'].includes(n)));
 assert.equal(await page.locator('#manufacturer').inputValue(),'Universal M & L, Germany');assert.equal(await page.locator('#madeIn').inputValue(),'Austria');assert.deepEqual(state.doc,before);
 await page.locator('#notes').fill('Only notes changed');await save(page);const saved=state.doc.cds.find(c=>c.id==='alias3');assert.equal(saved.manufacturer,'Universal M & L, Germany');assert.equal(saved.madeIn,'Austria');
 }finally{await f.close();}});

}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();console.log(passed+'/'+(passed+failed)+' improvements 3.2 checks passed');if(failed)process.exitCode=1;});
