/* Failure-path and recovery checks. Only mocked services/files in fresh browser contexts. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const raw = fs.readFileSync(path.join(__dirname,'../src/index.html'),'utf8');
const html = raw.replace('  /* ---------- start ---------- */', `
  window.qa = { startEdit, openDetail, setLang, openAlbumDlg, commitMeta,
    backend:function(){return backend;}, state:function(){return {cds:clone(cds),meta:clone(meta)};},
    exportCsv:async function(){var result;var old=downloadsApi;downloadsApi={save:async function(req){result=req.data;}};try{await doExport('csv');return result;}finally{downloadsApi=old;}}
  };
  /* ---------- start ---------- */`);
// Mirror Tauri's inline-script hash injection when testing the configured policy in Chrome.
const directives=JSON.parse(fs.readFileSync(path.join(__dirname,'../src-tauri/tauri.conf.json'),'utf8')).app.security.csp;
const inlineHashes=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].filter(m=>m[1].trim()).map(m=>`'sha256-${createHash('sha256').update(m[1].replace(/\r\n/g,'\n')).digest('base64')}'`);
const csp=Object.entries(directives).map(([key,value])=>`${key} ${value}${key==='script-src'?' '+inlineHashes.join(' '):''}`).join('; ');
const seed = {cds:[{id:'one',title:'Existing',medium:'vinyl',addedAt:Date.now(),type:'Symphony',notes:'=formula',audio:[],works:[{title:'Work',duration:'130:00',tracks:[]}]}],meta:{albums:[{id:'fav',name:'Favorite',cdIds:[]}],playlists:[],settings:{lang:'en'}}};
let browser, passed=0, failed=0;
async function test(name,run) { if(process.env.CDC_TEST_FILTER&&!new RegExp(process.env.CDC_TEST_FILTER,'i').test(name))return; try { await run();passed++;console.log('PASS:',name); }catch(e){failed++;console.error('FAIL:',name,e.stack);} }
async function fixture({native=false,corrupt=false,doc=seed}={}) {
  const state={doc:structuredClone(doc),fail:false,corrupt,commands:[],errors:[],requests:[],root:'C:\\isolated\\audio',chosen:null,hold:null};
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  async function save(data) {const fail=state.fail;if(state.hold)await state.hold;if(fail)throw Error('isolated disk failure');state.doc=structuredClone(data);}
  await context.exposeBinding('__invoke',async(_,cmd,args={})=>{
    state.commands.push({cmd,args});
    switch(cmd){
      case 'load_data':if(state.corrupt)throw Error('collection_unreadable');return structuredClone(state.doc);
      case 'save_data':return save(args.data);
      case 'covers_root_dir':return 'C:\\isolated\\covers';
      case 'audio_root_dir':return state.root;
      case 'tidy_covers':return null;
      case 'audio_present':return args.files.map(()=>true);
      case 'remove_cd_audio':case 'remove_audio':return null;
      case 'list_backups':return [{name:'collection.backup.json',date:'2026-11-04',kind:'previous',cds:1}];
      case 'read_backup':return structuredClone(seed);
      case 'recover_collection':if(state.fail)throw Error('unreadable');state.corrupt=false;state.doc=args.backup?structuredClone(seed):{cds:[],meta:{}};return null;
      case 'choose_audio_location':if(state.fail)throw Error('copy failure');if(state.chosen)state.root=state.chosen;return state.chosen;
      default:throw Error('Unexpected command '+cmd);
    }
  });
  await context.addInitScript(native=>{
    window.CDC_DESKTOP=true; localStorage.setItem('cdc.lang','en');
    window.policyViolations=[];document.addEventListener('securitypolicyviolation',e=>window.policyViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI}));
    if(native)window.__TAURI__={core:{invoke:(cmd,args)=>window.__invoke(cmd,args),convertFileSrc:file=>'http://qa.test/audio/'+encodeURIComponent(file)}};
  },native);
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    state.requests.push(url.hostname);
    if(url.hostname==='ogpzmnaqybxybybooebi.supabase.co')return route.fulfill({json:[]});
    if(url.hostname!=='qa.test')return route.abort();
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html,headers:{'Content-Security-Policy':csp}});
    if(/^\/fonts\/[a-z0-9-]+\.(css|woff2)$/.test(url.pathname))return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'font/woff2',body:fs.readFileSync(path.join(__dirname,'../src',url.pathname))});
    if(url.pathname==='/api/data'){
      if(route.request().method()==='PUT'){
        state.commands.push({cmd:'http_save'});
        try{await save(route.request().postDataJSON());return route.fulfill({json:{ok:true}});}catch{return route.fulfill({status:500,body:'failed'});}
      }
      return route.fulfill({json:state.corrupt?{}:state.doc});
    }
    return route.fulfill({status:204,body:''});
  });
  const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>state.errors.push(e.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.goto('http://qa.test/');
  await page.locator(corrupt?'#win-recovery':'#grid .card').first().waitFor();
  return {page,state,close:async()=>{await context.close();assert.deepEqual(state.errors,[]);}};
}
async function settleSave(page) {await page.locator('#submit:not([disabled])').waitFor();}
async function main(){
  const executablePath=['C:/Program Files/Google/Chrome/Application/chrome.exe',playwright.chromium.executablePath()].find(fs.existsSync);
  browser=await playwright.chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  for(const native of [false,true])await test(`title-only add/edit failures preserve drafts and favorites; retry persists atomically (${native?'native':'HTTP'})`,async()=>{
    const f=await fixture({native}),{page,state}=f;
    try{
      await page.locator('#open-add').click();await page.locator('#title').fill('New title only');
      await page.locator('#form-fav-toggle').click();await page.locator('#form-fav-item-fav').click();
      state.fail=true;await page.locator('#submit').click();await settleSave(page);
      assert(await page.locator('#win-cd').isVisible());assert(await page.locator('#form-save-error').isVisible());
      assert.equal(await page.locator('#title').inputValue(),'New title only');assert.equal(state.doc.cds.length,1);
      assert.equal(await page.locator('#grid .card').count(),1);assert.deepEqual(state.doc.meta.albums[0].cdIds,[]);
      state.fail=false;await page.locator('#submit').click();await page.locator('#win-cd').waitFor({state:'hidden'});
      const added=state.doc.cds.find(c=>c.title==='New title only');assert(added);assert.deepEqual(state.doc.meta.albums[0].cdIds,[added.id]);
      await page.evaluate(()=>qa.startEdit(qa.state().cds.find(c=>c.id==='one')));
      await page.locator('#title').fill('Changed title only');state.fail=true;
      await page.locator('#submit').click();await settleSave(page);assert(await page.locator('#win-cd').isVisible());
      assert.equal(state.doc.cds.find(c=>c.id==='one').title,'Existing');assert.equal(await page.locator('#title').inputValue(),'Changed title only');
      state.fail=false;await page.keyboard.press('Control+s');await page.locator('#win-cd').waitFor({state:'hidden'});
      assert.equal(state.doc.cds.find(c=>c.id==='one').title,'Changed title only');
    }finally{await f.close();}
  });
  await test('failed metadata stays visibly pending, never enters sync snapshot, and Retry saves it',async()=>{
    const f=await fixture({native:true}),{page,state}=f;
    try{
      state.fail=true;
      assert.equal(await page.evaluate(()=>qa.commitMeta(m=>{m.albums[0].name='Pending name';})),false);
      assert(await page.locator('#storage-notice').isVisible());assert.equal(state.doc.meta.albums[0].name,'Favorite');
      assert.equal(await page.evaluate(()=>qa.backend().snapshot().meta.albums[0].name),'Favorite');
      state.fail=false;await page.locator('#storage-retry').click();await page.locator('#storage-notice').waitFor({state:'hidden'});
      assert.equal(state.doc.meta.albums[0].name,'Pending name');
      await page.reload();await page.locator('#card-one').waitFor();assert.equal(await page.evaluate(()=>qa.state().meta.albums[0].name),'Pending name');
    }finally{await f.close();}
  });
  await test('failed Favorites creation keeps its dialog and input; retry creates exactly one list',async()=>{
    const f=await fixture({native:true}),{page,state}=f;
    try{
      await page.evaluate(()=>qa.openAlbumDlg('new',null,'favorite',[]));await page.locator('#album-name').fill('New favorite');
      state.fail=true;await page.locator('#album-save').click();await page.locator('#album-name-err').filter({hasText:/./}).waitFor();
      assert(await page.locator('#win-album').isVisible());assert.equal(state.doc.meta.albums.length,1);
      assert.equal((await page.evaluate(()=>qa.state().meta.albums)).length,1);
      state.fail=false;await page.locator('#album-save').click();await page.locator('#win-album').waitFor({state:'hidden'});
      assert.equal(state.doc.meta.albums.filter(a=>a.name==='New favorite').length,1);
    }finally{await f.close();}
  });
  await test('serialized writes cannot lose a later edit when an earlier write fails',async()=>{
    const f=await fixture({native:true}),{page,state}=f;let release;
    try{
      state.hold=new Promise(r=>release=r);state.fail=true;
      const pending=page.evaluate(async()=>{
        var b=qa.backend();var first=b.update('one',Object.assign({},qa.state().cds[0],{title:'Rejected'}),true);
        var second=b.update('one',Object.assign({},qa.state().cds[0],{title:'Later'}),true);
        return Promise.allSettled([first,second]);
      });
      for(let i=0;i<100&&!state.commands.some(c=>c.cmd==='save_data');i++)await new Promise(r=>setTimeout(r,10));
      assert(state.commands.some(c=>c.cmd==='save_data'));
      assert.equal(await page.evaluate(()=>qa.state().cds[0].title),'Existing');
      state.fail=false;release();state.hold=null;
      const result=await pending;
      assert.equal(result[0].status,'rejected');assert.equal(result[1].status,'fulfilled');
      assert.equal(state.doc.cds[0].title,'Later');assert.equal(await page.evaluate(()=>qa.state().cds[0].title),'Later');
    }finally{if(release)release();await f.close();}
  });
  await test('unreadable startup blocks dismissal and writes, restores backup, and retries recovery errors',async()=>{
    const f=await fixture({native:true,corrupt:true}),{page,state}=f;
    try{
      await page.keyboard.press('Escape');assert(await page.locator('#win-recovery').isVisible());
      assert.equal(state.commands.filter(c=>c.cmd==='save_data'||c.cmd==='tidy_covers').length,0);
      await page.locator('#recovery-list option').waitFor({state:'attached'});state.fail=true;await page.locator('#recovery-restore').click();
      await page.locator('#recovery-error').filter({hasText:/./}).waitFor();assert(await page.locator('#win-recovery').isVisible());
      state.fail=false;await page.locator('#recovery-restore').click();await page.locator('#win-recovery').waitFor({state:'hidden'});
      await page.locator('#card-one').waitFor();assert.equal(state.commands.find(c=>c.cmd==='recover_collection').args.backup,'collection.backup.json');
    }finally{await f.close();}
  });
  await test('new empty collection requires explicit confirmation; invalid HTTP document blocks startup too',async()=>{
    for(const native of [true,false]){
      const f=await fixture({native,corrupt:true}),{page,state}=f;
      try{
        if(native){await page.locator('#recovery-new').click();assert.equal(state.commands.filter(c=>c.cmd==='recover_collection').length,0);await page.locator('#recovery-new-yes').click();await page.locator('#win-recovery').waitFor({state:'hidden'});assert.deepEqual(state.doc.cds,[]);}
        else {assert(await page.locator('#recovery-new').isHidden());await page.locator('#recovery-retry').click();assert(await page.locator('#win-recovery').isVisible());}
      }finally{await f.close();}
    }
  });
  await test('failed import rolls back the collection and retains import confirmation for retry',async()=>{
    const f=await fixture(),{page,state}=f;
    try{
      await page.locator('#open-settings').click();
      await page.locator('#import-file').setInputFiles({name:'fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({cds:[{id:'new',title:'Imported'}]}))});
      state.fail=true;await page.locator('#import-replace').click();await page.locator('#import-replace:not([disabled])').waitFor();
      assert(await page.locator('#import-ask').isVisible());assert.equal(state.doc.cds[0].id,'one');assert.equal(await page.evaluate(()=>qa.state().cds[0].id),'one');
      state.fail=false;await page.locator('#import-replace').click();await page.locator('#import-ask').waitFor({state:'hidden'});assert.equal(state.doc.cds[0].id,'new');
    }finally{await f.close();}
  });
  await test('failed sync removal does not delete local audio or publish the removed collection',async()=>{
    const f=await fixture({native:true}),{page,state}=f;
    try{
      await page.evaluate(()=>qa.startEdit(qa.state().cds[0]));await page.locator('#title').fill('Draft must survive');
      state.fail=true;assert.equal(await page.evaluate(async()=>{try{await qa.backend().applySync(qa.backend().snapshot(),[],['one'],[],null,'fixture');return true;}catch{return false;}}),false);
      assert.equal(state.commands.filter(c=>c.cmd==='remove_cd_audio').length,0);assert.equal(await page.evaluate(()=>qa.state().cds[0].id),'one');
      assert(await page.locator('#win-cd').isVisible());assert.equal(await page.locator('#title').inputValue(),'Draft must survive');
    }finally{await f.close();}
  });
  await test('failed Undo offers Retry without a false restoration toast or deleting audio',async()=>{
    const f=await fixture({native:true}),{page,state}=f;
    try{
      await page.evaluate(()=>qa.openDetail('one'));
      await page.locator('#detail-body').getByRole('button',{name:'Delete release',exact:true}).click();
      await page.locator('#detail-body').getByRole('button',{name:'Delete release',exact:true}).click();
      await page.locator('#win-detail').waitFor({state:'hidden'});assert.equal(state.doc.cds.length,0);
      state.fail=true;await page.locator('#toast-action').click();
      await page.locator('#toast-action').filter({hasText:'Retry save'}).waitFor();assert.equal(state.doc.cds.length,0);
      assert.equal(state.commands.filter(c=>c.cmd==='remove_cd_audio').length,0);
      state.fail=false;await page.locator('#toast-action').click();await page.locator('#card-one').waitFor();
      assert.equal(state.doc.cds[0].id,'one');
    }finally{await f.close();}
  });
  await test('audio folder chooser handles cancel/failure/success locally and guards active drafts',async()=>{
    const f=await fixture({native:true}),{page,state}=f;
    try{
      await page.locator('#open-settings').click();await page.locator('#audio-location-path').filter({hasText:/isolated/}).waitFor();
      await page.locator('#audio-location-choose').click();await page.locator('#audio-location-choose:not([disabled])').waitFor();assert.equal(state.root,'C:\\isolated\\audio');
      state.fail=true;state.chosen='D:\\Music\\PMCO Audio';await page.locator('#audio-location-choose').click();await page.locator('#audio-location-status').filter({hasText:/Could not/}).waitFor();assert.equal(state.root,'C:\\isolated\\audio');
      state.fail=false;await page.locator('#audio-location-choose').click();await page.locator('#audio-location-path').filter({hasText:'D:'}).waitFor();
      assert(!JSON.stringify(state.doc).includes('D:'));await page.locator('#close-settings').click();
      await page.evaluate(()=>qa.startEdit(qa.state().cds[0]));
      await page.evaluate(()=>document.getElementById('open-settings').click());
      assert(await page.locator('#audio-location-choose').isDisabled());
      await page.locator('#close-settings').click();await page.locator('#close-cd').click();
      await page.locator('#open-settings').click();assert(await page.locator('#audio-location-choose').isEnabled());
    }finally{await f.close();}
  });
  await test('set-item popup accepts keyboard focus, traps Tab, and returns Escape to its trigger',async()=>{
    const doc=structuredClone(seed);doc.cds=[1,2].map(n=>({id:'s'+n,title:'Set',set:{id:'set',title:'Set',disc:n,total:2},medium:'cd',notes:'Details'}));
    const f=await fixture({doc}),{page}=f;
    try{
      await page.evaluate(()=>qa.openDetail('s1'));const button=page.locator('#disc-info-s1');await button.focus();await button.press('Enter');
      const close=page.locator('#disc-info-popup button');assert(await close.evaluate(n=>n===document.activeElement));
      await page.keyboard.press('Tab');assert(await close.evaluate(n=>n===document.activeElement));
      await page.keyboard.press('Shift+Tab');assert(await close.evaluate(n=>n===document.activeElement));
      await page.keyboard.press('Escape');assert.equal(await page.locator('#disc-info-popup').count(),0);assert(await button.evaluate(n=>n===document.activeElement));assert(await page.locator('#win-detail').isVisible());
    }finally{await f.close();}
  });
  await test('CSV uses display labels and preserves formula protection; stats stay readable at narrow widths',async()=>{
    const f=await fixture(),{page}=f;
    try{
      const csv=await page.evaluate(()=>qa.exportCsv());assert(csv.includes('"Type of work"'));assert(csv.includes('"Vinyl"'));assert(csv.includes('"\'=formula"'));
      for(const lang of ['en','ja','zh']){
        await page.evaluate(lang=>qa.setLang(lang,false),lang);await page.locator('#open-stats').click();
        for(const width of [390,420,768,1280]){
          await page.setViewportSize({width,height:900});
          assert(await page.locator('.stat-tile.time b').evaluate(n=>n.scrollWidth<=n.parentElement.clientWidth));
          assert.equal(await page.locator('.bars li').evaluateAll(rows=>rows.filter(r=>r.querySelector('.bv').textContent==='0').filter(r=>getComputedStyle(r.querySelector('.fill')).display!=='none').length),0);
        }
        if(lang==='en') assert.equal(await page.locator('.stat-tile').first().textContent(),'1Album');
        assert.equal(await page.locator('#set-stats,#set-storage').count(),0);
        const out=process.env.CDC_QA_ARTIFACTS||path.join(os.tmpdir(),'pmco-persistence-qa');fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'stats-'+lang+'.png')});
        await page.locator('#close-stats').click();await page.setViewportSize({width:1280,height:900});
      }
    }finally{await f.close();}
  });
  await test('bundled fonts load offline under CSP; configured sync endpoint works and unrelated connections are blocked',async()=>{
    const f=await fixture(),{page,state}=f;
    try{
      await page.evaluate(()=>document.fonts.ready);
      assert(await page.evaluate(()=>document.fonts.check('16px "IBM Plex Sans"')));
      assert(await page.evaluate(()=>document.fonts.check('16px "IBM Plex Mono"')));
      assert.equal(state.requests.filter(host=>host!=='qa.test').length,0);
      assert.deepEqual(await page.evaluate(()=>window.policyViolations),[]);
      assert.deepEqual(await page.evaluate(async()=>{var r=await fetch('https://ogpzmnaqybxybybooebi.supabase.co/rest/v1/cds?select=id');return r.json();}),[]);
      assert.equal(await page.evaluate(async()=>{try{await fetch('https://unapproved.test/data');return true;}catch{return false;}}),false);
      assert(!state.requests.includes('unapproved.test'));
      assert((await page.evaluate(()=>window.policyViolations)).some(v=>v.directive==='connect-src'));
    }finally{await f.close();}
  });
  await browser.close();console.log(`${passed}/${passed+failed} persistence/recovery checks passed`);if(failed)process.exitCode=1;
}
main().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
