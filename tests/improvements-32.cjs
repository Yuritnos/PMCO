/* Isolated physical-media regression tests. No real accounts, drives or collection. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8').replace('  /* ---------- start ---------- */',
  '  window.mediaQA = { listFields, cardFields, renderGrid, startEdit, setLang, openDetail, discTracks, dgMedia, dgDiscLists, discogsSource, lookupDiscData, populateLookupDrafts, playId: function(id) { playAudio(cdById(id)); }, renderPlaylist, moveCard, resetWorks, readWorks, cdFormDirty, closeWin, queue: function() { return clone(player.queue); }, currentEntry };\n  /* ---------- start ---------- */');
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
 assert.equal(await page.locator('#collection-quantity').inputValue(),'1');await page.locator('#quantity-plus').click();assert(await page.evaluate(()=>mediaQA.cdFormDirty()));
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
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();console.log(passed+'/'+(passed+failed)+' improvements 3.2 checks passed');if(failed)process.exitCode=1;});
