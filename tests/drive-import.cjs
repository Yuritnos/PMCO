/* Isolated browser/native-device fixtures. Never enumerates a real drive or touches a real account/library. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
let playwright;try{playwright=require('playwright');}catch{playwright=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const source=fs.readFileSync(path.join(__dirname,'../src/index.html'),'utf8');
const html=source.replace('  /* ---------- start ---------- */','  window.driveQA={CdDrive,closeWin,clearForm,openAdd,resetWorks,readWorks};\n  /* ---------- start ---------- */');
const executablePath=[process.env.CDC_CHROMIUM_PATH,playwright.chromium.executablePath(),'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&fs.existsSync(p));
const disc={driveId:'D:',fingerprint:'a'.repeat(40),tracks:[{number:1,startSector:0,sectors:9000,duration:'2:00'},{number:2,startSector:9000,sectors:9000,duration:'2:00'}]};
let browser,passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS:',name);}catch(e){failed++;console.error('FAIL:',name,e.stack);}}
async function fixture(options={}){
  const state={doc:{cds:[],meta:{albums:[],playlists:[],settings:{lang:'en'}}},drives:['D:'],removed:[],calls:[],errors:[],complete:true,cancelled:false,...options};
  const context=await browser.newContext({reducedMotion:'reduce',viewport:{width:1280,height:900}});
  await context.exposeBinding('__driveNative',async(_,command,args={})=>{
    state.calls.push({command,args});
    switch(command){
      case 'load_data':return structuredClone(state.doc);
      case 'save_data':if(state.saveFail)throw Error('Isolated save failure');state.doc=structuredClone(args.data);return null;
      case 'covers_root_dir':return 'C:\\isolated-drive-qa\\covers';
      case 'audio_root_dir':return 'C:\\isolated-drive-qa\\audio';
      case 'audio_present':return args.files.map(()=>true);
      case 'tidy_covers':return 0;
      case 'list_cd_drives':return state.drives;
      case 'read_cd_disc':if(state.readHold)await state.readHold;if(state.readError)throw state.readError;return structuredClone(disc);
      case 'start_cd_import':state.cancelled=false;if(state.startHold)await state.startHold;return 'rip-fixture';
      case 'cd_import_status':return {state:state.cancelled?'cancelled':state.jobError?'error':state.complete?'done':'copying',code:state.cancelled?'drive_cancelled':state.jobError||'',track:1,tracks:2,progress:state.complete?100:25};
      case 'cancel_cd_import':state.cancelled=true;return null;
      case 'adopt_cd_import':if(state.adoptHold)await state.adoptHold;return [1,2].map(n=>({file:args.cdId+'/rip-fixture-track-0'+n+'.'+(state.calls.findLast(c=>c.command==='start_cd_import').args.format),name:'Track 0'+n,track:n,size:10000}));
      case 'remove_audio':state.removed.push(...args.files);return null;
      default:throw Error('Unexpected isolated native command: '+command);
    }
  });
  await context.addInitScript(native=>{window.CDC_DESKTOP=true;localStorage.setItem('cdc.lang','en');if(native)window.__TAURI__={core:{invoke:(c,a)=>window.__driveNative(c,a),convertFileSrc:p=>'http://drive.test/audio/'+encodeURIComponent(p)}};},options.native!==false);
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname==='drive.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});if(url.hostname==='drive.test'&&url.pathname==='/api/data'){if(route.request().method()==='PUT')state.doc=route.request().postDataJSON();return route.fulfill({json:state.doc});}return route.abort();});
  const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>state.errors.push(e.message));await page.goto('http://drive.test/');await page.locator('#open-add').click();
  return {page,state,close:async()=>{await context.close();assert.deepEqual(state.errors,[]);}};
}
async function openDrive(page){await page.locator('#form-audio-set').evaluate(n=>n.open=true);await page.locator('#drive-open').click();}
async function scan(page){await openDrive(page);await page.waitForFunction(()=>!document.getElementById('drive-read').disabled);await page.locator('#drive-read').click();await page.locator('#drive-preview').waitFor({state:'visible'});}
async function copy(page){await page.locator('#drive-copy').click();await page.waitForFunction(()=>document.getElementById('drive-status').textContent.includes('Audio copied'));}
async function main(){
  browser=await playwright.chromium.launch({headless:true,executablePath});
  await test('browser preview hides native-only controls and no-drive state gives refresh guidance',async()=>{
    let f=await fixture({native:false});try{assert.equal(await f.page.locator('#drive-section').isVisible(),false);}finally{await f.close();}
    f=await fixture({drives:[]});try{await openDrive(f.page);await f.page.waitForFunction(()=>document.getElementById('drive-status').textContent.includes('No CD drive'));assert(await f.page.locator('#drive-read').isDisabled());}finally{await f.close();}
  });
  await test('drive is inside folded Audio and reads only track counts and measured durations',async()=>{
    const f=await fixture();try{
      assert.equal(await f.page.locator('#form-audio-set').evaluate(n=>n.open),false);
      assert.equal(await f.page.locator('#form-audio-set #drive-open').count(),1);
      await scan(f.page);
      assert.equal(await f.page.locator('#drive-open').textContent(),'Add from CD drive');
      assert.equal(await f.page.locator('#drive-release').count(),0);
      assert.equal(await f.page.locator('#drive-tracks li').count(),2);
      assert.deepEqual(await f.page.locator('#drive-tracks .len').allTextContents(),['2:00','2:00']);
      assert(!f.state.calls.some(c=>c.command==='start_cd_import'||c.command.startsWith('lookup_cd_')));
      assert.equal(await f.page.locator('#title').inputValue(),'');
    }finally{await f.close();}
  });
  await test('FLAC import maps two physical tracks into the draft then saves and reloads without cleanup',async()=>{
    const f=await fixture();try{await f.page.locator('#title').fill('Manual title');await scan(f.page);await copy(f.page);assert.equal(f.state.calls.find(c=>c.command==='start_cd_import').args.format,'flac');assert.equal(await f.page.locator('#form-audio .paudio > li').count(),2);assert.equal(f.state.doc.cds.length,0);await f.page.locator('#submit').click();await f.page.locator('#win-cd').waitFor({state:'hidden'});assert.equal(f.state.doc.cds.length,1);const cd=f.state.doc.cds[0];assert.equal(cd.title,'Manual title');assert.deepEqual(cd.audio.map(a=>a.track),[1,2]);assert(cd.audio.every(a=>a.file.endsWith('.flac')));assert.equal(cd.works[0].tracks.length,2);assert.deepEqual(f.state.removed,[]);await f.page.reload();assert.equal(f.state.doc.cds[0].audio.length,2);}finally{await f.close();}
  });
  await test('WAV import keeps measured times and discard removes only new copies',async()=>{
    const f=await fixture({doc:{cds:[{id:'saved',title:'Saved original',audio:[{file:'saved/original.flac',track:1}]}],meta:{albums:[],playlists:[],settings:{lang:'en'}}}});try{await scan(f.page);await f.page.locator('#drive-format').selectOption('wav');await copy(f.page);assert.deepEqual(await f.page.locator('#work-list .t-len').evaluateAll(ns=>ns.map(n=>n.value)),['2:00','2:00']);await f.page.locator('#close-cd').click();await f.page.locator('#cd-unsaved-discard').click();await f.page.locator('#win-cd').waitFor({state:'hidden'});assert.equal(f.state.removed.length,2);assert(f.state.removed.every(file=>file.endsWith('.wav')&&file!=='saved/original.flac'));assert.equal(f.state.doc.cds[0].audio[0].file,'saved/original.flac');}finally{await f.close();}
  });
  await test('ejected or changed disc reports failure without adopting audio, and retry can succeed',async()=>{
    const f=await fixture({jobError:'drive_changed'});try{await scan(f.page);await f.page.locator('#drive-copy').click();await f.page.waitForFunction(()=>document.getElementById('drive-status').textContent.includes('ejected'));assert(!f.state.calls.some(c=>c.command==='adopt_cd_import'));assert.equal(f.state.doc.cds.length,0);f.state.jobError='';await copy(f.page);assert.equal(await f.page.locator('#form-audio .paudio > li').count(),2);}finally{await f.close();}
  });
  await test('close during pending start cancels the eventual job and retains the changed-form choice',async()=>{
    let releaseStart;const f=await fixture({startHold:new Promise(r=>releaseStart=r),complete:false});try{await f.page.locator('#title').fill('Keep draft');await scan(f.page);await f.page.locator('#drive-copy').click();await f.page.waitForFunction(()=>window.driveQA.CdDrive.busy);await f.page.locator('#close-cd').click();assert(await f.page.locator('#win-cd').isVisible());releaseStart();await f.page.locator('#win-cd-unsaved').waitFor({state:'visible'});assert(f.state.calls.some(c=>c.command==='cancel_cd_import'));assert(!f.state.calls.some(c=>c.command==='adopt_cd_import'));assert.equal(f.state.doc.cds.length,0);}finally{releaseStart();await f.close();}
  });
  await test('cancel racing adoption cleans returned files instead of attaching them to the draft',async()=>{
    let releaseAdopt;const f=await fixture({adoptHold:new Promise(r=>releaseAdopt=r)});try{await scan(f.page);await f.page.locator('#drive-copy').click();await f.page.waitForFunction(()=>document.getElementById('drive-cancel').hidden===false);for(let i=0;i<100&&!f.state.calls.some(c=>c.command==='adopt_cd_import');i++)await new Promise(r=>setTimeout(r,10));assert(f.state.calls.some(c=>c.command==='adopt_cd_import'));await f.page.locator('#drive-cancel').click();releaseAdopt();await f.page.waitForFunction(()=>document.getElementById('drive-status').textContent.includes('cancelled'));assert.equal(f.state.removed.length,2);assert.equal(await f.page.locator('#form-audio .paudio > li').count(),0);}finally{releaseAdopt();await f.close();}
  });
  await test('late disc read cannot populate a different editor session',async()=>{
    let finish;const f=await fixture({readHold:new Promise(r=>finish=r)});try{await openDrive(f.page);await f.page.waitForFunction(()=>!document.getElementById('drive-read').disabled);await f.page.locator('#drive-read').click();await f.page.locator('#close-cd').click();await f.page.locator('#win-cd').waitFor({state:'hidden'});await f.page.locator('#open-add').click();finish();await new Promise(r=>setTimeout(r,100));assert(await f.page.locator('#drive-preview').isHidden());assert.equal(await f.page.locator('#title').inputValue(),'');}finally{finish();await f.close();}
  });
  await test('failed collection save retains copied draft audio for a successful retry',async()=>{
    const f=await fixture({saveFail:true});try{await f.page.locator('#title').fill('Retry draft');await scan(f.page);await copy(f.page);await f.page.locator('#submit').click();await f.page.waitForFunction(()=>!document.getElementById('submit').disabled);assert(await f.page.locator('#win-cd').isVisible());assert.equal(await f.page.locator('#form-audio .paudio > li').count(),2);assert.deepEqual(f.state.removed,[]);f.state.saveFail=false;await f.page.locator('#submit').click();await f.page.locator('#win-cd').waitFor({state:'hidden'});assert.equal(f.state.doc.cds[0].audio.length,2);}finally{await f.close();}
  });
  await test('preview controls fit all locales, themes and narrow widths with no automatic imports',async()=>{
    const f=await fixture();try{await scan(f.page);for(const lang of ['en','ja','zh']){await f.page.locator('#lang-set').evaluate((n,l)=>{n.value=l;n.dispatchEvent(new Event('change',{bubbles:true}));},lang);assert((await f.page.locator("#drive-status").textContent()).includes({en:"tracks read",ja:"トラックを読み取りました",zh:"已读取"}[lang]));for(const width of [1280,420,360]){await f.page.setViewportSize({width,height:900});for(const theme of ['light','dark']){await f.page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);assert(await f.page.locator('#win-cd .panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1),`${lang}/${theme}/${width}`);}}}assert(!f.state.calls.some(c=>c.command==='start_cd_import'));if(process.env.CDC_QA_ARTIFACTS){fs.mkdirSync(process.env.CDC_QA_ARTIFACTS,{recursive:true});await f.page.screenshot({path:path.join(process.env.CDC_QA_ARTIFACTS,'drive-preview-mobile-zh.png')});}}finally{await f.close();}
  });
  await test('copy preserves all entered metadata and work grouping while updating physical durations',async()=>{
    const f=await fixture();try{
      await f.page.locator('#title').fill('Piano Concertos');
      await f.page.locator('#composer').fill('My composer');
      await f.page.locator('#type').fill('Piano concerto');
      await f.page.locator('#more-details').evaluate(n=>n.open=true);
      await f.page.locator('#label').fill('My label');
      await f.page.locator('#notes').fill('My notes');
      const works=[{title:'Concerto',composer:'Work composer',type:'Concerto',performers:[{role:'Piano',name:'Work pianist'}],performersMode:'additional',tracks:[{title:'Allegro',duration:'1:11'},{title:'Andante',duration:'1:22'}]}];
      await f.page.evaluate(works=>window.driveQA.resetWorks(works),works);
      await scan(f.page);await copy(f.page);
      for(const [id,value] of Object.entries({title:'Piano Concertos',composer:'My composer',type:'Piano concerto',label:'My label',notes:'My notes'})) assert.equal(await f.page.locator('#'+id).inputValue(),value);
      assert.deepEqual(await f.page.evaluate(()=>window.driveQA.readWorks()),[{...works[0],tracks:[{title:'Allegro',duration:'2:00'},{title:'Andante',duration:'2:00'}]}]);
      assert.deepEqual(f.state.calls.find(c=>c.command==='adopt_cd_import').args.naming,{title:'Piano Concertos',item:'',tracks:[{number:1,title:'Allegro'},{number:2,title:'Andante'}],next:3});
      assert(!f.state.calls.some(c=>c.command.startsWith('lookup_cd_')));
    }finally{await f.close();}
  });
  await test('work-only tracks retain their titles and virtual audio slots',async()=>{
    const f=await fixture();try{
      await f.page.evaluate(()=>window.driveQA.resetWorks([{title:'Theme and variations',duration:'1:11',tracks:[]},{title:'Overture',tracks:[]}]));
      await scan(f.page);await copy(f.page);
      assert.deepEqual(await f.page.evaluate(()=>window.driveQA.readWorks()),[{title:'Theme and variations',composer:'',duration:'2:00',tracks:[]},{title:'Overture',composer:'',duration:'2:00',tracks:[]}]);
      assert.deepEqual(await f.page.locator('#form-audio select').evaluateAll(ns=>ns.map(n=>n.value)),['1','2']);
    }finally{await f.close();}
  });
  await test('mismatched existing track layout stops copying and preserves editor content',async()=>{
    const f=await fixture();try{
      const works=[{title:'Keep work',duration:'1:11',tracks:[]}];
      await f.page.evaluate(works=>window.driveQA.resetWorks(works),works);
      await scan(f.page);await f.page.locator('#drive-copy').click();
      assert((await f.page.locator('#drive-status').textContent()).includes('editor has 1 tracks'));
      assert(!f.state.calls.some(c=>c.command==='start_cd_import'));
      assert.equal(await f.page.locator('.w-duration').inputValue(),'1:11');
    }finally{await f.close();}
  });
  await test('failed copying does not change entered durations or names',async()=>{
    const f=await fixture({jobError:'drive_changed'});try{
      await f.page.evaluate(()=>window.driveQA.resetWorks([{title:'Keep work',tracks:[{title:'First',duration:'1:11'},{title:'Second',duration:'1:22'}]}]));
      await scan(f.page);await f.page.locator('#drive-copy').click();
      await f.page.waitForFunction(()=>document.getElementById('drive-status').textContent.includes('ejected'));
      assert.deepEqual(await f.page.locator('.t-len').evaluateAll(ns=>ns.map(n=>n.value)),['1:11','1:22']);
    }finally{await f.close();}
  });
  await test('an existing disc with audio cannot be overwritten by drive import',async()=>{
    const saved={id:'saved',title:'Existing audio',works:[{title:'Keep original',duration:'1:00',tracks:[]}],audio:[{file:'saved/original.flac',track:1}]};
    const f=await fixture({doc:{cds:[saved],meta:{albums:[],playlists:[],settings:{lang:'en'}}}});try{await f.page.locator('#close-cd').click();await f.page.locator('#grid .card h3').click();await f.page.locator('#win-detail .profile-actions > button').first().click();await scan(f.page);await f.page.locator('#drive-copy').click();await f.page.waitForFunction(()=>document.getElementById('drive-status').textContent.includes('already has audio'));assert(!f.state.calls.some(c=>c.command==='start_cd_import'));assert.equal(await f.page.locator('#title').inputValue(),'Existing audio');assert.deepEqual(f.state.removed,[]);}finally{await f.close();}
  });
}
main().catch(e=>{failed++;console.error(e);}).finally(async()=>{if(browser)await browser.close();console.log(`${passed}/${passed+failed} drive-import checks passed`);if(failed)process.exitCode=1;});
