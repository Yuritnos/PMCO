/* Isolated physical-media regression tests. No real accounts, drives or collection. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8').replace('  /* ---------- start ---------- */',
  '  window.mediaQA = { startEdit, setLang, openDetail, discTracks, dgMedia, dgDiscLists, discogsSource, lookupDiscData, populateLookupDrafts, playId: function(id) { playAudio(cdById(id)); }, renderPlaylist, moveCard, resetWorks, readWorks, cdFormDirty, closeWin, queue: function() { return clone(player.queue); }, currentEntry };\n  /* ---------- start ---------- */');
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
    return route.abort();
  });
  const page=await context.newPage(); page.setDefaultTimeout(6000); page.on('pageerror',e=>state.errors.push(e.message));
  await page.goto('http://media.test/'); await page.locator('#card-old').waitFor();
  return {page,state,close:async()=>{await context.close();assert.deepEqual(state.errors,[]);}};
}
const view = async(page,m) => { if(await page.locator('#chip-all').getAttribute('aria-expanded')==='false')await page.locator('#chip-all').press('ArrowRight');await page.locator('[id="chip-media:'+m+'"]').click(); };
async function save(page) { await page.locator('#submit').click(); await page.locator('#win-cd').waitFor({state:'hidden'}); }
async function main() {
  const executablePath=['C:/Program Files/Google/Chrome/Application/chrome.exe',playwright.chromium.executablePath()].find(fs.existsSync);
  browser=await playwright.chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  await test('medium name accepts continuous keyboard input and keeps caret/selection in standalone and set editors',async()=>{
    const f=await fixture(),{page,state}=f;
    try {
      for(const grouped of [false,true]){
        await page.locator('#open-add').click(); await page.locator('#title').fill(grouped?'Custom set':'Custom standalone');
        if(grouped){await page.locator('#set-choice').selectOption('+new');await page.locator('#form-disc-tabs .item-edit').first().click();}
        await page.locator('#medium').selectOption('other');
        const input=page.locator('#mediumName'); await input.focus(); await input.pressSequentially('Reel-to-reel',{delay:15});
        assert.equal(await input.inputValue(),'Reel-to-reel'); assert.equal(await input.evaluate(n=>n===document.activeElement),true);
        await input.press('Home'); await input.press('ArrowRight'); await input.press('ArrowRight'); await input.press('ArrowRight'); await input.press('ArrowRight');
        await input.pressSequentially(' tape'); assert.equal(await input.inputValue(),'Reel tape-to-reel');
        await input.press('Shift+ArrowLeft'); await input.press('Shift+ArrowLeft'); await input.pressSequentially('PE');
        assert.equal(await input.inputValue(),'Reel taPE-to-reel'); assert.equal(await input.evaluate(n=>n.selectionStart),9);
        await input.press('Backspace'); await input.press('Delete'); assert.equal(await input.inputValue(),'Reel taPto-reel');
        assert.equal(await input.evaluate(n=>n===document.activeElement),true);
        await save(page); const saved=state.doc.cds.find(c=>c.title===(grouped?'Custom set':'Custom standalone')); assert.equal(saved.mediumName,'Reel taPto-reel');
        await page.evaluate(c=>mediaQA.startEdit(c),saved);
        if(grouped)await page.locator('#form-disc-tabs .item-edit').first().click();
        assert.equal(await input.inputValue(),'Reel taPto-reel'); await page.locator('#close-cd').click(); assert.equal(await page.locator('#win-cd-unsaved').isHidden(),true);
      }
    } finally {await f.close();}
  });
  await test('localized Medium name input retains focus during composition and never reparents on input',async()=>{
    const f=await fixture(),{page}=f;
    try {
      await page.locator('#open-add').click(); await page.locator('#title').fill('Composition'); await page.locator('#set-choice').selectOption('+new'); await page.locator('#form-disc-tabs .item-edit').first().click(); await page.locator('#medium').selectOption('other');
      for(const [lang,label,value] of [['en','Medium name','Reel-to-reel'],['ja','メディア名','オープンリール'],['zh','媒介名称','开盘带']]){
        await page.evaluate(l=>mediaQA.setLang(l,false),lang); assert.equal(await page.locator('label[for=mediumName]').textContent(),label);
        const input=page.locator('#mediumName'); await input.fill(''); await input.focus();
        const result=await input.evaluate((node,value)=>{
          const fields=document.querySelector('#medium-fields'), parent=fields.parentNode; let moves=0;
          const observer=new MutationObserver(records=>{for(const r of records)if([...r.removedNodes,...r.addedNodes].includes(fields))moves++;}); observer.observe(parent,{childList:true});
          node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
          for(const letter of value){node.value+=letter;node.setSelectionRange(node.value.length,node.value.length);node.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:node.value}));node.dispatchEvent(new InputEvent('input',{bubbles:true,data:letter,inputType:'insertCompositionText',isComposing:true}));}
          node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:node.value}));
          for(const r of observer.takeRecords())if([...r.removedNodes,...r.addedNodes].includes(fields))moves++; observer.disconnect();
          return {value:node.value,focused:node===document.activeElement,caret:node.selectionStart,moves};
        },value);
        assert.deepEqual(result,{value,focused:true,caret:value.length,moves:0});
        assert.equal(await page.locator('#more-details summary').textContent(),lang==='en'?value+' details':lang==='ja'?value+'の詳細':value+'详情');
      }
    } finally {await f.close();}
  });
  await test('standalone has one medium; set item buttons contain their own name and medium editor',async()=>{
    const f=await fixture(),{page,state}=f;
    try {
      await page.locator('#open-add').click(); await page.locator('#title').fill('Shared title');
      assert.equal(await page.locator('#set-fields').evaluate(n=>!!(n.compareDocumentPosition(document.querySelector('#medium-fields'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
      assert.equal(await page.locator('#medium').getAttribute('multiple'),null);
      await page.locator('#set-choice').selectOption('+new');
      assert.equal(await page.locator('#set-media,#set-title').count(),0); assert.equal(await page.locator('#medium').isHidden(),true);
      await page.locator('#form-add-disc').click(); await page.locator('#medium').selectOption('vinyl'); await page.locator('#item-name').fill('Bonus record');
      await page.locator('#item-editor-done').click();
      assert.equal(await page.locator('#form-disc-tabs .item-tab').count(),2);
      assert.equal(await page.locator('#form-disc-tabs .item-edit').count(),2);
      assert.equal(await page.locator('#form-disc-tabs .segment-select').last().innerText(),'Bonus record\nVinyl');
      await page.locator('#form-disc-tabs .segment-select').first().click(); assert.equal(await page.locator('#title').inputValue(),'Shared title'); await save(page);
      const saved=state.doc.cds.filter(c=>c.set?.title==='Shared title'); assert.deepEqual(saved.map(c=>c.medium),['cd','vinyl']); assert(saved.every(c=>c.title==='Shared title')); assert.equal(saved[1].set.subtitle,'Bonus record');
      await page.reload(); await page.evaluate(c=>mediaQA.startEdit(c),saved[0]); await page.locator('#form-disc-tabs .item-edit').last().click(); assert.equal(await page.locator('#medium').inputValue(),'vinyl'); assert.equal(await page.locator('#item-name').inputValue(),'Bonus record');
      assert.equal(await page.evaluate(()=>mediaQA.cdFormDirty()),false);
    } finally {await f.close();}
  });
  await test('matrix and catalogue stay distinct; removed condition/capacity fields survive unseen edits',async()=>{
    const original={id:'fields',title:'Fields',medium:'vinyl',catalogNo:'CAT-1',matrixRunout:'RUN-2',mediaCondition:'VG+',sleeveCondition:'NM',capacity:'16 GB',spars:'AAA'};
    const f=await fixture({extra:[original]}),{page,state}=f;
    try {
      await page.evaluate(c=>mediaQA.startEdit(c),original); await page.locator('#more-details').evaluate(n=>n.open=true);
      assert.equal(await page.locator('#mediaCondition,#sleeveCondition,#capacity').count(),0);
      assert.equal(await page.locator('#matrixRunout').inputValue(),'RUN-2');
      assert.equal(await page.locator('#barcode').evaluate(n=>n.closest('.two').contains(document.querySelector('#matrixRunout'))),true);
      assert.equal(await page.locator('#catalogNo').evaluate(n=>n.closest('.field').parentElement.classList.contains('two')),false);
      await page.locator('#catalogNo').fill('CAT-NEW'); await page.locator('#matrixRunout').fill('RUN-NEW'); await save(page);
      const saved=state.doc.cds.find(c=>c.id==='fields');
      assert.equal(saved.catalogNo,'CAT-NEW'); assert.equal(saved.matrixRunout,'RUN-NEW');
      for(const key of ['mediaCondition','sleeveCondition','capacity','spars'])assert.equal(saved[key],original[key]);
      await page.evaluate(id=>mediaQA.openDetail(id),'fields');
      assert.match(await page.locator('#detail-body').innerText(),/RUN-NEW/);
      assert.doesNotMatch(await page.locator('#detail-body').innerText(),/VG\+|NM|16 GB/);
    } finally {await f.close();}
  });
  await test('all media expose audio technology and independent matrix, with editable vinyl/cassette suggestions',async()=>{
    const f=await fixture(),{page}=f;
    try {
      await page.locator('#open-add').click(); await page.locator('#more-details').evaluate(n=>n.open=true);
      for(const m of ['cd','vinyl','cassette','sacd','dvd','bluray','other']){
        await page.locator('#medium').selectOption(m);
        assert.equal(await page.locator('#spars').isVisible(),true); assert.equal(await page.locator('#matrixRunout').isVisible(),true);
      }
      await page.locator('#medium').selectOption('vinyl');
      for(const field of ['recordSize','recordSpeed','recordColour'])assert((await page.locator('#'+field+'-options option').count())>=2);
      assert((await page.locator('#recordColour-options option').evaluateAll(ns=>ns.map(n=>n.value))).includes('Black vinyl'));
      await page.locator('#recordSpeed').fill('16⅔'); assert.equal(await page.locator('#recordSpeed').inputValue(),'16⅔');
      await page.locator('#medium').selectOption('cassette');
      for(const field of ['tapeType','noiseReduction'])assert((await page.locator('#'+field+'-options option').count())>=3);
      await page.locator('#tapeType').fill('Custom tape'); assert.equal(await page.locator('#tapeType').inputValue(),'Custom tape');
      await page.locator('#medium').selectOption('sacd'); assert.equal(await page.locator('label[for=audioPrograms]').textContent(),'Audio channels');
    } finally {await f.close();}
  });
  await test('format headings and custom Other names localize safely; works hints omit printed numbering',async()=>{
    const f=await fixture(),{page}=f;
    try {
      await page.locator('#open-add').click();
      for(const [lang,info,details] of [['en','Vinyl information','Vinyl details'],['ja','レコードの情報','レコードの詳細'],['zh','黑胶信息','黑胶详情']]){
        await page.evaluate(l=>mediaQA.setLang(l,false),lang); await page.locator('#medium').selectOption('vinyl');
        assert.equal(await page.locator('#albumOverall summary > span').first().textContent(),info);
        assert.equal(await page.locator('#more-details summary').textContent(),details);
        assert.doesNotMatch(await page.locator('#works-set summary .section-hint').textContent(),/A1|B2/);
      }
      await page.locator('#medium').selectOption('other'); assert.equal(await page.locator('#more-details summary').textContent(),'媒介详情');
      await page.locator('#mediumName').fill('USB'); assert.equal(await page.locator('#albumOverall summary > span').first().textContent(),'USB信息'); assert.equal(await page.locator('#more-details summary').textContent(),'USB详情');
      await page.locator('#mediumName').fill('<b>Reel</b>'); assert.equal(await page.locator('#more-details summary b').count(),0);
    } finally {await f.close();}
  });
  await test('composer and localized work-type filter options follow initial-letter order',async()=>{
    const f=await fixture({extra:[{id:'az1',title:'A',composer:'Zara Alpha',type:'Symphony',performers:[]},{id:'az2',title:'B',composer:'Alice Zulu',type:'PianoConcerto',performers:[]},{id:'az3',title:'C',composer:'Bob Beta',type:'Custom form',performers:[]}]}),{page}=f;
    try {
      await page.locator('#filter-btn').click();
      assert.deepEqual(await page.locator('#f-composer-options label span').allTextContents(),['Alice Zulu','Bob Beta','Zara Alpha']);
      for(const lang of ['en','ja','zh']){
        await page.evaluate(l=>mediaQA.setLang(l,false),lang);
        const values=await page.locator('#f-type-options label span').allTextContents();
        const sorted=await page.evaluate(values=>values.slice().sort((a,b)=>a.localeCompare(b,document.documentElement.lang,{sensitivity:'base',numeric:true})),values);
        assert.deepEqual(values,sorted);
      }
    } finally {await f.close();}
  });
  await test('medium shelf keyboard and drag ordering move whole mixed sets in the global relative order',async()=>{
    const extra=[{id:'v1',title:'Record 1',medium:'vinyl'},{id:'v2',title:'Record 2',medium:'vinyl'}];
    const f=await fixture({extra}),{page,state}=f;
    try {
      await view(page,'vinyl'); assert.equal(await page.locator('#grid').evaluate(n=>n.classList.contains('arranging')),true);
      await page.locator('#card-v2').press('Alt+ArrowLeft');
      assert.deepEqual(await page.locator('#grid .card').evaluateAll(ns=>ns.map(n=>n.dataset.id)),['m3','v2','v1']);
      const savedOrder=page.waitForResponse(r=>r.url().endsWith('/api/data')&&r.request().method()==='PUT'&&r.request().postDataJSON().meta.order.all.indexOf('v1')<r.request().postDataJSON().meta.order.all.indexOf('m1'));
      await page.evaluate(()=>mediaQA.moveCard('m3','v1',false)); await savedOrder;
      assert.deepEqual(state.doc.meta.order.all.filter(id=>['m1','m2','m3','v1','v2'].includes(id)),['v2','v1','m1','m2','m3']);
      await page.locator('#chip-all').click();
      const ids=await page.locator('#grid .card').evaluateAll(ns=>ns.map(n=>n.dataset.id));
      assert(ids.indexOf('v2')<ids.indexOf('v1')); assert(ids.indexOf('v1')<ids.indexOf('m1'));
      const hidden=['old','tape','sacd','usb']; assert.deepEqual(state.doc.meta.order.all.filter(id=>hidden.includes(id)),hidden);
      await view(page,'vinyl'); await page.locator('#search').fill('Record'); assert.equal(await page.locator('#grid').evaluate(n=>n.classList.contains('arranging')),false);
    } finally {await f.close();}
  });
  await test('undivided works consume numeric slots in editor and standalone/set profiles',async()=>{
    const works=[{title:'First',tracks:[{title:'I'},{title:'II'},{title:'III'}]},...['A','B','C','D'].map(title=>({title,tracks:[]})),{title:'TEST',tracks:[{title:'Should be 8'}]}];
    const standalone={id:'slots',title:'Slots',works}; const member={...standalone,id:'setslots',set:{id:'slots-set',title:'Slots set',disc:1,total:1}};
    const f=await fixture({extra:[standalone,member]}),{page}=f;
    try {
      for(const cd of [standalone,member]){
        await page.evaluate(c=>mediaQA.startEdit(c),cd);
        assert.deepEqual(await page.locator('#work-list .trow .no').allTextContents(),['1','2','3','8']);
        await page.locator('#close-cd').click(); assert.equal(await page.locator('#win-cd-unsaved').isHidden(),true);
        await page.evaluate(id=>mediaQA.openDetail(id),cd.id);
        if(cd.set)await page.locator('.set-disc summary').click();
        assert.deepEqual(await page.locator('#detail-body .ptracks .no').allTextContents(),['1','2','3','8']);
        assert.equal(await page.locator('#detail-body .pwork-heading .no').count(),0);
        await page.locator('#close-detail').click();
      }
      assert.equal((await page.evaluate(c=>mediaQA.discTracks(c),standalone)).at(-1).no,8);
    } finally {await f.close();}
  });
  await test('vinyl side switching is clean, names/works save and reload, and side-local numbering includes virtual tracks',async()=>{
    const f=await fixture(),{page,state}=f;
    try {
      await view(page,'vinyl'); await page.locator('#open-add').click(); await page.locator('#title').fill('Sides'); await page.locator('#works-set').evaluate(n=>n.open=true);
      assert.deepEqual(await page.locator('#vinyl-sides button[data-side]').allTextContents(),['Side A','Side B']);
      assert.equal(await page.locator('.t-position').first().isHidden(),true);
      await page.locator('.work:visible .w-title').fill('A whole'); await page.locator('.work:visible .trow .iconbtn').click();
      await page.locator('.work:visible .w-duration').fill('1:00');
      await page.locator('#add-work').click(); await page.locator('.work:visible').last().locator('.w-title').fill('A divided'); await page.locator('.work:visible .t-title').fill('A movement');
      assert.equal(await page.locator('.work:visible .trow .no').textContent(),'2');
      await page.locator('[data-edit-side=a]').click(); await page.locator('#vinyl-side-name').fill('Front'); await page.locator('#vinyl-sides button[data-side=b]').click(); await page.locator('#add-work').click();
      await page.locator('.work:visible .w-title').fill('B work'); await page.locator('.work:visible .t-title').fill('B movement'); assert.equal(await page.locator('.work:visible .trow .no').textContent(),'1');
      await page.locator('[data-edit-side=b]').click(); await page.locator('#vinyl-side-name').fill('Back'); await save(page);
      const saved=state.doc.cds.find(c=>c.title==='Sides'); assert.deepEqual(saved.sides.map(s=>s.name),['Front','Back']); assert.deepEqual(saved.works.map(w=>w.side),['a','a','b']);
      await page.reload(); await page.evaluate(c=>mediaQA.startEdit(c),saved); await page.locator('#vinyl-sides button[data-side=b]').click();
      assert.equal(await page.locator('.work:visible .w-title').inputValue(),'B work'); assert.equal(await page.evaluate(()=>mediaQA.cdFormDirty()),false);
      await page.locator('#close-cd').click(); assert.equal(await page.locator('#win-cd-unsaved').isHidden(),true);
      await page.evaluate(id=>mediaQA.openDetail(id),saved.id); assert.deepEqual(await page.locator('.program-side').allTextContents(),['Front','Back']); assert.deepEqual(await page.locator('.ptracks .no').allTextContents(),['2','1']);
    } finally {await f.close();}
  });
  await test('vinyl side removal is staged, preserves original audio files and remaps surviving assignments',async()=>{
    const cd={id:'sides-audio',title:'Audio sides',medium:'vinyl',sides:[{id:'a',letter:'A',name:''},{id:'b',letter:'B',name:''}],works:[{title:'A',side:'a',tracks:[]},{title:'B',side:'b',tracks:[{title:'B1'}]}],audio:[{track:1,name:'A.wav',file:'sides-audio/A.wav'},{track:2,name:'B.wav',file:'sides-audio/B.wav'}]};
    const f=await fixture({native:true,extra:[cd]}),{page,state}=f;
    try {
      await page.evaluate(c=>mediaQA.startEdit(c),cd); await page.locator('[data-remove-side=a]').click(); await page.locator('#vinyl-side-ask button').first().click();
      assert.equal(await page.locator('#vinyl-sides button[data-side]').count(),1); assert.equal(await page.locator('#vinyl-add-side').isVisible(),true);
      await save(page); const saved=state.doc.cds.find(c=>c.id===cd.id); assert.deepEqual(saved.works.map(w=>w.title),['B']); assert.deepEqual(saved.audio.map(a=>a.track),[0,1]);
      assert.equal(state.commands.some(c=>c.command==='remove_audio'),false);
      await page.evaluate(c=>mediaQA.startEdit(c),saved); await page.locator('#vinyl-add-side').click(); assert.equal(await page.locator('#vinyl-sides button[data-side]').count(),2);
      await page.locator('#close-cd').click(); await page.locator('#cd-unsaved-discard').click(); assert.equal(state.doc.cds.find(c=>c.id===cd.id).sides.length,1);
    } finally {await f.close();}
  });
  await test('legacy C/D vinyl sides display as local A/B without rewriting data or changing audio slots',async()=>{
    const cd={id:'lp2',title:'LP 2',medium:'vinyl',works:[{title:'Across C and D',composer:'Own composer',performers:[{name:'Own soloist',role:'Pianist'}],tracks:[{title:'C piece',position:'C1'},{title:'D piece',position:'D1'}]}],audio:[{track:1,name:'C.wav',file:'lp2/C.wav'},{track:2,name:'D.wav',file:'lp2/D.wav'}]};
    const f=await fixture({native:true,extra:[cd]}),{page,state}=f;
    try {
      await page.evaluate(c=>mediaQA.startEdit(c),cd); await page.locator('#vinyl-sides button[data-side=b]').click();
      assert.equal(await page.locator('.work:visible .t-title').inputValue(),'D piece');
      assert.deepEqual(await page.locator('#vinyl-sides button[data-side]').allTextContents(),['Side A','Side B']);
      assert.equal(await page.evaluate(()=>mediaQA.cdFormDirty()),false);
      await page.locator('#close-cd').click(); assert.deepEqual(state.doc.cds.find(c=>c.id===cd.id),cd);
      await page.evaluate(c=>mediaQA.startEdit(c),cd); await save(page);
      const saved=state.doc.cds.find(c=>c.id===cd.id); assert.deepEqual(saved.audio,cd.audio); assert.deepEqual(saved.works.map(w=>w.side),['a','b']);
      assert.deepEqual(saved.works.map(w=>w.composer),['Own composer','Own composer']); assert.deepEqual(saved.works.map(w=>w.performers),[cd.works[0].performers,cd.works[0].performers]);
    } finally {await f.close();}
  });
  await test('invalid hidden-side duration reveals that side and preserves its draft',async()=>{
    const cd={id:'invalid-side',title:'Invalid side',medium:'vinyl',sides:[{id:'a',letter:'A'},{id:'b',letter:'B'}],works:[{title:'A',side:'a',tracks:[]},{title:'B',side:'b',tracks:[]}]};
    const f=await fixture({extra:[cd]}),{page}=f;
    try {
      await page.evaluate(c=>mediaQA.startEdit(c),cd); await page.locator('#vinyl-sides button[data-side=b]').click(); await page.locator('.work:visible .w-duration').fill('bad'); await page.locator('#vinyl-sides button[data-side=a]').click(); await page.locator('#submit').click();
      assert.equal(await page.locator('#vinyl-sides button[data-side=b]').getAttribute('aria-pressed'),'true'); assert.equal(await page.locator('.work:visible .w-duration').inputValue(),'bad'); assert.equal(await page.locator('.work:visible .w-duration').evaluate(n=>n===document.activeElement),true);
    } finally {await f.close();}
  });
  await test('barcode 028942761124 imports and saves the matrix from each Discogs disc label',async()=>{
    const f=await fixture(),{page,state}=f;
    const release=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/discogs-10374216.json'),'utf8').replace(/^\uFEFF/,''));
    try {
      await page.route('https://api.discogs.com/database/search?**',route=>route.fulfill({json:{results:[
        {id:release.id,title:release.title,barcode:['0 28942 76112 4']}
      ]}}));
      await page.route('https://api.discogs.com/releases/'+release.id,route=>route.fulfill({json:release}));
      await page.locator('#open-add').click();
      await page.locator('#lookup-q').fill('028942761124');
      await page.locator('#lookup-go').click();
      await page.locator('#lookup-use-0').click();
      const tabs=page.locator('#form-disc-tabs .segment-select');
      await tabs.nth(1).waitFor();
      assert.equal(await page.locator('#matrixRunout').inputValue(),'427 612-2 01 #');
      await tabs.nth(1).click();
      assert.equal(await page.locator('#matrixRunout').inputValue(),'427 613-2 01 #');
      await save(page);
      const discs=state.doc.cds.filter(cd=>cd.title===release.title).sort((a,b)=>a.set.disc-b.set.disc);
      assert.deepEqual(discs.map(d=>d.matrixRunout),['427 612-2 01 #','427 613-2 01 #']);
      assert(discs.every(d=>d.catalogNo==='427 611-2 [GH2]'));
      await page.reload();
      await page.evaluate(cd=>mediaQA.startEdit(cd),discs[1]);
      assert.equal(await page.locator('#matrixRunout').inputValue(),'427 613-2 01 #');
    } finally {await f.close();}
  });
  await test('card titles stop after three lines and quantity badges appear only for multiple copies',async()=>{
    const title='Rachmaninov · Piano Concerto No. 2 / Prokofiev · Piano Concerto No. 5 (Klavierkonzerte · Concertos Pour Piano)';
    const single={id:'copies',title,quantity:3};
    const setCopy={id:'copies-set',title:'Two copies of a set',quantity:2,set:{id:'copies-group',title:'Two copies of a set',disc:1,total:1}};
    const f=await fixture({extra:[single,setCopy]}),{page}=f;
    try {
      const heading=page.locator('#card-copies h3');
      assert.equal(await heading.textContent(),title);
      assert.equal(await heading.getAttribute('title'),title);
      const layout=await heading.evaluate(node=>{
        const {lineHeight,webkitLineClamp}=getComputedStyle(node);
        return {clamp:webkitLineClamp,lines:Math.round(node.clientHeight/parseFloat(lineHeight)),clipped:node.scrollHeight>node.clientHeight};
      });
      assert.deepEqual(layout,{clamp:'3',lines:3,clipped:true});
      assert.equal(await page.locator('#card-copies .card-body > :last-child').textContent(),'x3');
      assert.equal(await page.locator('#card-copies-set .quantity-badge').textContent(),'x2');
      assert.equal(await page.locator('#card-old .quantity-badge').count(),0);
      for(const [id,quantity] of [['old',''],['copies','x3'],['copies-set','x2']]){
        await page.locator('#card-'+id).click();
        const profile=page.locator('#detail-body');
        assert(!/items catalogued|Collection quantity/.test(await profile.innerText()));
        assert.deepEqual(await profile.locator('.quantity-badge').allTextContents(),quantity?[quantity]:[]);
        if(id==='copies') assert.equal(await profile.locator('#detail-h').textContent(),title);
        await page.locator('#close-detail').click();
      }
    } finally {await f.close();}
  });
  await test('barcode 9787884182404 keeps every vinyl and CD track as an independent work',async()=>{
    const f=await fixture(),{page,state}=f;
    const release=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/discogs-37843299.json'),'utf8'));
    const tracks=release.tracklist.filter(track=>track.type_==='track');
    try {
      await page.route('https://api.discogs.com/database/search?**',route=>route.fulfill({json:{results:[
        {id:release.id,title:release.title,barcode:['9787884182404']}
      ]}}));
      await page.route('https://api.discogs.com/releases/'+release.id,route=>route.fulfill({json:release}));
      await page.locator('#open-add').click();
      await page.locator('#lookup-q').fill('9787884182404');
      await page.locator('#lookup-go').click();
      await page.locator('#lookup-use-0').click();
      const tabs=page.locator('#form-disc-tabs .segment-select');
      await tabs.nth(1).waitFor();
      const workTitles=page.locator('#work-list .work:visible .w-title');
      assert.equal(await workTitles.count(),10);
      await page.locator('#vinyl-sides button[data-side=b]').click();
      assert.equal(await workTitles.count(),11);
      await tabs.nth(1).click();
      assert.equal(await workTitles.count(),21);
      assert.equal(await page.locator('#work-list .trow').count(),0);
      await save(page);
      const discs=state.doc.cds.filter(cd=>cd.set?.total===2&&cd.title.includes('Tidal Sonata')).sort((a,b)=>a.set.disc-b.set.disc);
      assert.deepEqual(discs.map(d=>d.medium),['vinyl','cd']);
      for(const [index,disc] of discs.entries()){
        const expected=tracks.slice(index*21,(index+1)*21);
        assert.deepEqual(disc.works.map(w=>[w.title,w.duration,w.tracks]),expected.map(t=>[t.title,t.duration,[]]));
        const slots=await page.evaluate(cd=>mediaQA.discTracks(cd),disc);
        assert.deepEqual(slots.map(slot=>slot.title),expected.map(t=>t.title));
      }
      assert.deepEqual(discs[0].works.map(w=>w.position),tracks.slice(0,21).map(t=>t.position));
    } finally {await f.close();}
  });
  await test('barcode 9787884181865 imports one work, one audio slot and only Side A',async()=>{
    const f=await fixture(),{page,state}=f;
    const release=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/discogs-20011237.json'),'utf8'));
    try {
      await page.route('https://api.discogs.com/database/search?**',route=>{
        const query=new URL(route.request().url()).searchParams;
        assert.equal(query.get('barcode'),'9787884181865');
        assert.equal(query.has('format'),false);
        assert.equal(query.has('title'),false);
        return route.fulfill({json:{results:[{id:release.id,title:release.title,barcode:['9 787884 181865'],format:['Vinyl']}]}});
      });
      await page.route('https://api.discogs.com/releases/'+release.id,route=>route.fulfill({json:release}));
      await page.locator('#open-add').click();
      await page.locator('#medium').selectOption('cd');
      await page.locator('#title').fill('Unrelated draft title');
      await page.locator('#lookup-q').fill('9787884181865');
      await page.locator('#lookup-go').click();
      await page.locator('#lookup-use-0').waitFor();
      await page.locator('#medium').selectOption('cassette');
      await page.locator('#lookup-use-0').click();
      await page.waitForFunction(title=>document.getElementById('title').value===title,release.title);
      assert.equal(await page.locator('#medium').inputValue(),'vinyl');
      assert.equal(await page.locator('#work-list .w-title').inputValue(),'灯华梦踏');
      assert.equal(await page.locator('#work-list .trow').count(),0);
      assert(await page.locator('#work-list .w-duration').isVisible());
      assert.equal(await page.locator('#work-list .w-duration').inputValue(),'');
      assert.deepEqual(await page.locator('#vinyl-sides button[data-side]').allTextContents(),['Side A']);
      assert(await page.locator('#vinyl-add-side').isVisible());
      await save(page);
      const saved=state.doc.cds.find(cd=>cd.title===release.title);
      assert.deepEqual(saved.sides.map(s=>s.id),['a']);
      assert.deepEqual(saved.works.map(w=>[w.title,w.side,w.position,w.tracks]),[['灯华梦踏','a','A',[]]]);
      assert.deepEqual((await page.evaluate(cd=>mediaQA.discTracks(cd),saved)).map(slot=>slot.position),['A · 1']);
      await page.reload();
      await page.evaluate(cd=>mediaQA.startEdit(cd),saved);
      assert.deepEqual(await page.locator('#vinyl-sides button[data-side]').allTextContents(),['Side A']);
      await page.locator('#vinyl-add-side').click();
      assert.equal(await page.locator('#vinyl-sides button[data-side=b]').getAttribute('aria-pressed'),'true');
      const work=page.locator('.work:visible .w-title');
      assert.equal(await work.count(),1);
      assert.equal(await work.inputValue(),'');
      assert(await work.evaluate(input=>document.activeElement===input));
      assert.equal(await page.locator('.work:visible .trow').count(),0);
    } finally {await f.close();}
  });
  await test('All music saves and playlists audio-only albums outside the physical collection',async()=>{
    const f=await fixture({native:true}),{page,state}=f;
    const release={id:7311,title:'Unowned album',formats:[{name:'CD',qty:'2'}],tracklist:[
      {type_:'track',position:'1-1',title:'Morning song'},{type_:'track',position:'2-1',title:'Evening song'}
    ]};
    try {
      await page.route('https://api.discogs.com/database/search?**',route=>route.fulfill({json:{results:[{id:release.id,title:release.title,barcode:['123456789012']}]}}));
      await page.route('https://api.discogs.com/releases/'+release.id,route=>route.fulfill({json:release}));
      const physicalCount=await page.locator('#chip-all .n').textContent();
      await page.locator('#chip-music').click();
      const add=page.locator('#open-add');
      assert.equal(await add.locator('#fab-text').textContent(),'Add music');
      await add.click();
      const audio=page.locator('#form-audio-set');
      assert(await audio.evaluate(n=>n.open&&n.parentElement.firstElementChild===n));
      assert(await page.locator('#form-audio-add').evaluate(n=>document.activeElement===n));
      await audio.locator('summary').click();
      assert(await audio.evaluate(n=>n.open));
      for(const id of ['medium','collection-quantity','more-details','drive-section','photo-hint'])
        assert(await page.locator('#'+id).isHidden(),id);
      assert.equal(await page.locator('#set-storage,#set-stats,[data-i18n=lookupNote]').count(),0);
      assert(!/Choose a folder on this computer/.test(await audio.textContent()));
      assert.equal(await page.locator('#albumOverall summary > span').first().textContent(),'Album information');
      assert.equal(await page.locator('#works-set summary > span').first().textContent(),'Works on this album');
      await page.locator('#lookup-q').fill('123456789012');
      await page.locator('#lookup-go').click();
      await page.locator('#lookup-use-0').click();
      await page.waitForFunction(title=>document.getElementById('title').value===title,release.title);
      assert(await page.locator('#lookup-disc-row').isHidden());
      await page.locator('#form-audio-add').click();
      await audio.locator('.audio-draft li').nth(2).waitFor();
      await save(page);
      const saved=state.doc.cds.find(cd=>cd.title===release.title);
      assert.equal(saved.musicOnly,true);
      for(const field of ['medium','quantity','set','barcode']) assert(!Object.hasOwn(saved,field),field);
      assert.deepEqual(saved.works.map(work=>work.title),['Morning song','Evening song']);
      assert.equal(saved.audio.length,3);
      assert.equal(await page.locator('#chip-all .n').textContent(),physicalCount);
      await page.reload();
      await page.locator('#chip-music').click();
      await page.locator('#card-info-'+saved.id).click();
      assert.equal(await page.locator('#win-detail .medium-badge').textContent(),'Audio files');
      assert(!/Collection quantity/.test(await page.locator('#win-detail .profile-main').textContent()));
      await page.getByRole('button',{name:'Edit music',exact:true}).click();
      assert(await audio.evaluate(n=>n.open&&n.parentElement.firstElementChild===n));
      await page.locator('#title').fill('Renamed album');
      await save(page);
      const edited=state.doc.cds.find(cd=>cd.id===saved.id);
      assert.equal(edited.title,'Renamed album');
      assert.equal(edited.musicOnly,true);
      assert.deepEqual(edited.audio,saved.audio);
      await page.locator('#card-addpl-'+saved.id).click();
      await page.locator('#cardpl-new').click();
      await page.locator('#album-name').fill('Audio-only picks');
      await page.locator('#album-save').click();
      await page.waitForFunction(()=>document.getElementById('win-album').hidden);
      assert.deepEqual(state.doc.meta.playlists[0].items.map(i=>i.file).sort(),saved.audio.map(a=>a.file).sort());
      await page.locator('#chip-all').click();
      assert.equal(await page.locator('#card-'+saved.id).count(),0);
      await add.click();
      for(const id of ['medium','collection-quantity','more-details'])
        assert(await page.locator('#'+id).isVisible(),id);
      assert(await page.locator('#drive-section').evaluate(n=>!n.hidden));
      assert(await audio.evaluate(n=>!n.open&&n.nextElementSibling.id==='cardshow-set'));
    } finally {await f.close();}
  });
  await test('vinyl lookup keeps documented sides for each disc in a set',async()=>{
    const f=await fixture(),{page,state}=f;
    try {
      const release={id:3102,title:'Sided vinyl lookup fixture',formats:[
        {name:'Vinyl',qty:'1',descriptions:['Single Sided']},{name:'Vinyl',qty:'3'}
      ],tracklist:[
        {type_:'track',position:'LP1-1',title:'First disc',duration:'1:00'},
        {type_:'track',position:'C1',title:'Second front',duration:'2:00'},
        {type_:'track',position:'D1',title:'Second back',duration:'3:00'},
        {type_:'track',position:'E1',title:'Third disc',duration:'4:00'},
        {type_:'track',position:'LP4-1',title:'Unknown sides',duration:'5:00'}
      ]};
      await page.route('https://api.discogs.com/releases/3102',route=>route.fulfill({json:release}));
      const result=await page.evaluate(()=>mediaQA.discogsSource.details({id:3102},''));
      await page.locator('#open-add').click();
      await page.evaluate(data=>mediaQA.populateLookupDrafts(data),result);
      await save(page);
      const discs=state.doc.cds.filter(cd=>cd.set?.title===release.title).sort((a,b)=>a.set.disc-b.set.disc);
      assert.deepEqual(discs.map(cd=>cd.sides.map(s=>s.id)),[['a'],['a','b'],['a'],['a','b']]);
      assert.deepEqual(discs[1].works.map(w=>[w.side,w.position,w.duration,w.tracks]),[
        ['a','C1','2:00',[]],['b','D1','3:00',[]]
      ]);
      assert.deepEqual((await page.evaluate(cd=>mediaQA.discTracks(cd),discs[1])).map(slot=>slot.position),['A · 1','B · 1']);
    } finally {await f.close();}
  });
  await test('reported LP + CD pattern maps plain/CD-prefixed tracks to CD; matrix lookup never overwrites catalogue',async()=>{
    const f=await fixture(),{page,state}=f;
    try {
      // Representative regression for reported barcode 9787884182411; not a captured public response.
      await page.route('https://api.discogs.com/releases/3101',route=>route.fulfill({json:{id:3101,title:'Mixed 9787884182411',formats:[{name:'Vinyl',qty:'1'},{name:'CD',qty:'1'}],labels:[{name:'Fixture',catno:'CAT-31'}],identifiers:[{type:'Matrix / Runout',value:'RUN-31'}],tracklist:[{type_:'track',position:'A1',title:'LP front'},{type_:'track',position:'B1',title:'LP back'},{type_:'track',position:'1',title:'CD first'},{type_:'track',position:'2',title:'CD second'}]}}));
      const result=await page.evaluate(()=>mediaQA.discogsSource.details({id:3101},'RUN-31'));
      assert.equal(result.catalogNo,'CAT-31'); assert.equal(result.matrixRunout,'RUN-31');
      assert.deepEqual(result.lookupDiscs.map(d=>[d.medium,d.works.flatMap(w=>w.tracks.map(t=>t.title).length?w.tracks.map(t=>t.title):[w.title])]),[['vinyl',['LP front','LP back']],['cd',['CD first','CD second']]]);
      const groups=await page.evaluate(()=>mediaQA.dgDiscLists([{position:'A1'},{position:'B1'},{position:'CD1'},{position:'CD2'}],[{medium:'vinyl'},{medium:'cd'}])); assert.equal(groups['1'].length,2); assert.equal(groups['2'].length,2);
      await page.locator('#open-add').click(); await page.evaluate(p=>mediaQA.populateLookupDrafts(p),result); await save(page);
      const imported=state.doc.cds.filter(c=>c.set?.title===result.title); assert.deepEqual(imported.map(c=>c.medium),['vinyl','cd']); assert.equal(imported[1].works.length,2);
      assert(imported.every(cd=>!cd.matrixRunout));
    } finally {await f.close();}
  });
  await test('side buttons fill their row and each owns edit/delete; rename opens only on demand and cancels cleanly',async()=>{
    const f=await fixture({native:true}),{page}=f;
    try {
      await page.evaluate(c=>mediaQA.startEdit(c),seed[3]);
      assert.equal(await page.locator('#vinyl-side-name').count(),0);
      for(const width of [1280,375]){
        await page.setViewportSize({width,height:900});
        assert.equal(await page.locator('.side-tabs').evaluate(row=>{
          const sides=Array.from(row.querySelectorAll('.side-tab')).map(n=>n.getBoundingClientRect());
          return Math.abs(sides[0].width-sides[1].width)<1&&Math.abs(sides[0].left-row.getBoundingClientRect().left)<1&&Math.abs(sides[1].right-row.getBoundingClientRect().right)<1;
        }),true);
      }
      assert.equal(await page.locator('.side-tab .side-edit').count(),2); assert.equal(await page.locator('.side-tab .side-remove').count(),2);
      await page.locator('[data-edit-side=b]').click(); await page.locator('#vinyl-side-name').fill('Temporary'); await page.locator('#vinyl-side-name').press('Escape');
      assert.equal(await page.locator('#vinyl-side-name').count(),0); assert.equal(await page.locator('button[data-side=b]').textContent(),'Side B'); assert.equal(await page.evaluate(()=>mediaQA.cdFormDirty()),false);
      await page.locator('[data-edit-side=a]').click(); await page.locator('#vinyl-side-name').fill('Front'); await page.locator('#vinyl-side-name').press('Enter'); assert.equal(await page.locator('button[data-side=a]').textContent(),'Front');
      assert.equal(await page.locator('#vinyl-side-name').count(),0); assert.equal(await page.evaluate(()=>mediaQA.cdFormDirty()),true);
      await page.locator('[data-remove-side=b]').click(); await page.locator('#vinyl-side-ask button').first().click();
      assert.equal(await page.locator('button[data-side=a]').count(),1); assert.equal(await page.locator('[data-remove-side=a]').isDisabled(),true);
      assert.equal(await page.locator('.work .t-title').inputValue(),'First');
    } finally {await f.close();}
  });
  await test('set titles save once across every item while old distinct titles become editable item names',async()=>{
    const discs=[1,2,3].map(n=>({id:'legacy-name-'+n,title:'Old item '+n,medium:n===2?'cassette':'cd',set:{id:'legacy-names',title:'Common release',disc:n,total:3,extra:{keep:n}},works:[{title:'Work '+n,tracks:[]}],notes:'Keep '+n}));
    const f=await fixture({extra:discs}),{page,state}=f;
    try {
      await page.evaluate(c=>mediaQA.startEdit(c),discs[0]); assert.equal(await page.locator('#title').inputValue(),'Common release');
      await page.locator('#form-disc-tabs .segment-select').last().click(); assert.equal(await page.evaluate(()=>mediaQA.cdFormDirty()),false); assert.deepEqual(state.doc.cds.filter(c=>c.set?.id==='legacy-names'),discs);
      await page.locator('#title').fill('Renamed release'); await page.locator('#form-disc-tabs .item-edit').nth(1).click();
      assert.equal(await page.locator('#title').inputValue(),'Renamed release'); assert.equal(await page.locator('#item-name').inputValue(),'Old item 2');
      await page.locator('#item-name').fill('Bonus tape'); await page.locator('#medium').selectOption('dvd'); await save(page);
      const saved=state.doc.cds.filter(c=>c.set?.id==='legacy-names').sort((a,b)=>a.set.disc-b.set.disc);
      assert(saved.every(c=>c.title==='Renamed release'&&c.set.title==='Renamed release')); assert.deepEqual(saved.map(c=>c.set.subtitle),['Old item 1','Bonus tape','Old item 3']); assert.deepEqual(saved.map(c=>c.medium),['cd','dvd','cd']);
      saved.forEach((c,i)=>{assert.deepEqual(c.set.extra,{keep:i+1});assert.equal(c.notes,'Keep '+(i+1));assert.equal(c.works[0].title,discs[i].works[0].title);assert.deepEqual(c.works[0].tracks,[]);assert.equal(c.works[0].composer||'','');});
      await page.reload(); await page.evaluate(c=>mediaQA.startEdit(c),saved[1]); assert.equal(await page.locator('#title').inputValue(),'Renamed release'); await page.locator('#form-disc-tabs .item-edit').nth(1).click(); assert.equal(await page.locator('#item-name').inputValue(),'Bonus tape');
      await page.locator('#item-name').fill('Discarded'); await page.locator('#close-cd').click(); await page.locator('#cd-unsaved-discard').click(); assert.equal(state.doc.cds.find(c=>c.id===saved[1].id).set.subtitle,'Bonus tape');
    } finally {await f.close();}
  });
  await test('undivided cassette/DVD/Blu-ray/Other works have printed positions that survive track transfers and audio mapping',async()=>{
    const originals=['cassette','dvd','bluray','other'].map(m=>({id:'position-'+m,title:'Positions '+m,medium:m,works:[{title:'Unbroken work',duration:'2:00',tracks:[]}],audio:[{file:'position-'+m+'/1.wav',name:'One.wav',track:1}]}));
    const f=await fixture({native:true,extra:originals}),{page,state}=f;
    try {
      for(const cd of originals){
        await page.evaluate(c=>mediaQA.startEdit(c),cd);
        assert.equal(await page.locator('.w-position').isVisible(),true); assert.equal(await page.locator('.w-position').getAttribute('placeholder'),'A1');
        await page.locator('.w-position').fill('B2'); await page.locator('.work > [data-i18n=addTrack]').click();
        assert.equal(await page.locator('.w-position').isHidden(),true); assert.equal(await page.locator('.t-position').inputValue(),'B2'); assert.equal(await page.locator('.t-len').inputValue(),'2:00');
        await page.locator('.trow .iconbtn').click(); assert.equal(await page.locator('.w-position').inputValue(),'B2'); assert.equal(await page.locator('.w-duration').inputValue(),'2:00');
        await save(page); const saved=state.doc.cds.find(c=>c.id===cd.id); assert.equal(saved.works[0].position,'B2'); assert.deepEqual(saved.works[0].tracks,[]); assert.deepEqual(saved.audio,cd.audio);
        assert.equal((await page.evaluate(c=>mediaQA.discTracks(c),saved))[0].position,'B2'); await page.evaluate(id=>mediaQA.openDetail(id),cd.id); assert.equal(await page.locator('.work-position').textContent(),'B2'); await page.locator('#close-detail').click();
      }
      for(const medium of ['cd','sacd','vinyl']) { await page.evaluate(c=>mediaQA.startEdit(c),{...originals[0],medium}); assert.equal(await page.locator('.w-position').isHidden(),true); await page.locator('#close-cd').click(); }
    } finally {await f.close();}
  });
  await test('edition details use catalogue above barcode/matrix, venue beside technology and complete localized examples',async()=>{
    const f=await fixture(),{page}=f;
    try {
      await page.locator('#open-add').click(); await page.locator('#more-details').evaluate(n=>n.open=true);
      for(const lang of ['en','ja','zh']){
        await page.evaluate(l=>mediaQA.setLang(l,false),lang);
        assert.match(await page.locator('#catalogNo').getAttribute('placeholder'),/UCCS-50032\/3/); assert.match(await page.locator('#matrixRunout').getAttribute('placeholder'),/410 084-2/);
        assert.equal(await page.locator('[data-i18n=sparsHint]').count(),0);
        assert.equal(await page.locator('#barcode-matrix').evaluate(n=>n.previousElementSibling.contains(document.querySelector('#catalogNo'))),true);
        assert.equal(await page.locator('#venue-technology').evaluate(n=>n.contains(document.querySelector('#recordingVenue'))&&n.contains(document.querySelector('#spars'))),true);
        for(const medium of ['cd','vinyl','cassette','sacd','dvd','bluray','other']){
          await page.locator('#medium').selectOption(medium);
          assert.deepEqual(await page.locator('#more-details input:visible').evaluateAll(ns=>ns.filter(n=>!n.placeholder.trim()).map(n=>n.id)),[]);
        }
      }
      await page.evaluate(()=>mediaQA.setLang('en',false)); await page.locator('#medium').selectOption('vinyl');
      assert.deepEqual(await page.locator('#recordColour-options option').evaluateAll(ns=>ns.map(n=>n.value)),['Black vinyl','Coloured vinyl','Clear vinyl','Red vinyl','Blue vinyl']);
    } finally {await f.close();}
  });
  await test('set details copy stays in drafts and respects selected fields, items, and media',async()=>{
    const discs=['vinyl','cd','vinyl','vinyl'].map((medium,index)=>({
      id:'copy-'+index,title:'Details copy set',medium,set:{id:'details-copy',title:'Details copy set',disc:index+1,total:4},
      label:'Label '+index,notes:'Note '+index,recordSpeed:index===0?'33⅓':'45',
      works:[{title:'Work '+index,tracks:[]}]
    }));
    const f=await fixture({extra:discs}),{page,state}=f;
    try {
      await page.evaluate(cd=>mediaQA.startEdit(cd),discs[0]);
      const picker=page.locator('#win-copy-details');
      await page.locator('#copy-details').click();
      assert.deepEqual(await picker.locator('#copy-details-fields input:checked').evaluateAll(inputs=>inputs.map(i=>i.value)),['label','recordSpeed','notes']);
      assert.equal(await picker.locator('#copy-details-items input:checked').count(),3);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(()=>mediaQA.cdFormDirty()),false);
      await page.locator('#copy-details').click();
      await picker.locator('#copy-details-fields input[value=notes]').uncheck();
      await picker.locator('#copy-details-items input[value=copy-3]').uncheck();
      await page.locator('#copy-details-apply').click();
      assert.equal(await page.evaluate(()=>mediaQA.cdFormDirty()),true);
      assert.deepEqual(state.doc.cds.filter(cd=>cd.set?.id==='details-copy'),discs);
      await page.locator('#disc-tab-copy-2').click();
      assert.equal(await page.locator('#recordSpeed').inputValue(),'33⅓');
      assert.equal(await page.locator('#notes').inputValue(),'Note 2');
      await save(page);
      const saved=state.doc.cds.filter(cd=>cd.set?.id==='details-copy');
      assert.deepEqual(saved.map(cd=>cd.label),['Label 0','Label 0','Label 0','Label 3']);
      assert.deepEqual(saved.map(cd=>cd.recordSpeed),['33⅓','45','33⅓','45']);
      assert.deepEqual(saved.map(cd=>cd.notes),discs.map(cd=>cd.notes));
      assert.deepEqual(saved.map(cd=>cd.works.map(w=>w.title)),discs.map(cd=>cd.works.map(w=>w.title)));
    } finally {await f.close();}
  });
  await test('set item rail stays at the left and scrolls separately from the editor',async()=>{
    const discs=Array.from({length:20},(_,index)=>({
      id:'rail-'+index,title:'Long set',set:{id:'rail',title:'Long set',disc:index+1,total:20},notes:'Notes'
    }));
    const f=await fixture({extra:discs}),{page}=f;
    try {
      await page.setViewportSize({width:375,height:600});
      await page.evaluate(cd=>mediaQA.startEdit(cd),discs[0]);
      const panel=page.locator('#win-cd .panel');
      const geometry=await panel.evaluate(node=>{
        const tools=document.getElementById('form-disc-tools'),tabs=document.getElementById('form-disc-tabs');
        const form=document.getElementById('cd-form');
        node.scrollTop=220;
        const first=tools.getBoundingClientRect(),outer=node.getBoundingClientRect();
        node.scrollTop=400;
        const second=tools.getBoundingClientRect(),scroll=node.scrollTop;
        tabs.scrollTop=120;
        return {left:second.right<=form.getBoundingClientRect().left, visible:second.top>=outer.top&&second.bottom<=outer.bottom,
          fixed:Math.abs(first.top-second.top)<1, separate:tabs.scrollTop>0&&node.scrollTop===scroll,
          overflow:node.scrollWidth>node.clientWidth+1};
      });
      assert.deepEqual(geometry,{left:true,visible:true,fixed:true,separate:true,overflow:false});
      assert(await page.locator('#form-add-disc').isVisible());
      assert(await page.locator('#form-remove-disc').isVisible());
    } finally {await f.close();}
  });
  await test('item editors and undivided work positions fit all locales/themes at desktop and narrow widths',async()=>{
    const f=await fixture(),{page}=f;
    try {
      for(const lang of ['en','ja','zh'])for(const theme of ['light','dark'])for(const width of [1280,375]){
        await page.setViewportSize({width,height:900}); await page.evaluate(({lang,theme})=>{mediaQA.setLang(lang,false);document.documentElement.dataset.theme=theme;},{lang,theme});
        await page.evaluate(c=>mediaQA.startEdit(c),seed[3]); await page.locator('#form-disc-tabs .item-edit').last().click(); await page.locator('#item-name').fill('Bonus record / 附赠黑胶');
        assert.equal(await page.locator('#medium').isVisible(),true); assert.equal(await page.locator('#win-cd .panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
        if(process.env.CDC_QA_ARTIFACTS&&lang==='zh'&&theme==='dark'){
          fs.mkdirSync(process.env.CDC_QA_ARTIFACTS,{recursive:true}); await page.locator('#item-editor').scrollIntoViewIfNeeded(); await page.screenshot({path:path.join(process.env.CDC_QA_ARTIFACTS,`item-editor-${width}.png`)});
        }
        await page.evaluate(()=>mediaQA.startEdit({id:'layout-work',title:'Unbroken tape',medium:'cassette',works:[{title:'Long work title for an undivided piece',duration:'2:00',position:'A1',tracks:[]}]}));
        await page.locator('#more-details').evaluate(n=>n.open=true);
        assert.equal(await page.locator('.w-position').isVisible(),true); assert.equal(await page.locator('#win-cd .panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
        assert.equal(await page.locator('#recordingVenue').evaluate(n=>Math.abs(n.getBoundingClientRect().top-document.querySelector('#spars').getBoundingClientRect().top)<1),true);
        if(process.env.CDC_QA_ARTIFACTS&&lang==='zh'&&theme==='dark'){
          await page.locator('#works-set').scrollIntoViewIfNeeded(); await page.screenshot({path:path.join(process.env.CDC_QA_ARTIFACTS,`work-position-${width}.png`)});
        }
      }
    } finally {await f.close();}
  });
  await test('vinyl side and medium controls fit desktop/mobile in every locale and theme',async()=>{
    const f=await fixture(),{page}=f;
    try {
      await page.evaluate(c=>mediaQA.startEdit(c),seed[3]);
      for(const lang of ['en','ja','zh'])for(const theme of ['light','dark'])for(const width of [1280,375]){
        await page.setViewportSize({width,height:900}); await page.evaluate(({lang,theme})=>{mediaQA.setLang(lang,false);document.documentElement.dataset.theme=theme;},{lang,theme});
        for(const id of ['works-set','more-details'])await page.locator('#'+id).evaluate(n=>n.open=true);
        assert.equal(await page.locator('#win-cd .panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1),true,`${lang}/${theme}/${width}`);
        assert.equal(await page.locator('.work:visible .t-position').isHidden(),true);
        assert.equal(await page.locator('#matrixRunout').isVisible(),true);
        if(process.env.CDC_QA_ARTIFACTS&&lang==='zh'&&theme==='dark'){
          fs.mkdirSync(process.env.CDC_QA_ARTIFACTS,{recursive:true}); await page.locator('#vinyl-sides').scrollIntoViewIfNeeded(); await page.screenshot({path:path.join(process.env.CDC_QA_ARTIFACTS,`vinyl-editor-${width}.png`)});
          await page.locator('#barcode').scrollIntoViewIfNeeded(); await page.screenshot({path:path.join(process.env.CDC_QA_ARTIFACTS,`vinyl-details-${width}.png`)});
        }
      }
    } finally {await f.close();}
  });
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();console.log(`${passed}/${passed+failed} media-editor checks passed`);if(failed)process.exitCode=1;});
