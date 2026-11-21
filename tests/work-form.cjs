/* Targeted edit-form regressions. Run: node tests/work-form.cjs
   Browser storage, native commands and network requests stay inside isolated fixtures. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
let playwright;
try { playwright = require(process.env.CDC_PLAYWRIGHT_MODULE || 'playwright'); }
catch { playwright = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const executablePath = [process.env.CDC_CHROMIUM_PATH, playwright.chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));
// Expose real closure helpers in the test response only; production source stays unchanged.
const fixtureHtml = html.replace('  /* ---------- start ---------- */',
  '  window.workFormQA = { workMetadata, workOverrides, fillFromLookup, resetWorks, readWorks, setLang, clearForm, discogsSource };\n  /* ---------- start ---------- */');
const globalPerformers = [{role: 'Conductor', name: 'Album conductor'}];
let browser;
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('PASS:', name); }
  catch (error) { results.push(false); console.error('FAIL:', name, error.stack); }
}
async function fixture(cds = [], viewport = {width: 1100, height: 850}) {
  const state = {doc: {cds: structuredClone(cds), meta: {albums: [], playlists: [], settings: {lang: 'en'}}}, errors: []};
  const context = await browser.newContext({viewport, reducedMotion: 'reduce'});
  await context.addInitScript(() => { window.CDC_DESKTOP = true; localStorage.setItem('cdc.lang', 'en'); });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'cdc-work-form.test') {
      if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: fixtureHtml});
      if (url.pathname === '/api/data') {
        if (route.request().method() === 'PUT') state.doc = route.request().postDataJSON();
        return route.fulfill({json: state.doc});
      }
    }
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto('http://cdc-work-form.test/');
  await page.locator('#open-add').waitFor();
  return {page, state, close: async () => { await context.close(); assert.deepEqual(state.errors, []); }};
}
async function save(page) {
  await page.locator('#submit').click();
  await page.locator('#win-cd').waitFor({state: 'hidden'});
}
async function edit(page, title) {
  await page.locator('#grid .card').filter({has: page.getByRole('heading', {name: title, exact: true})}).click();
  await page.getByRole('button', {name: 'Edit', exact: true}).click();
  await page.locator('#works-set').evaluate(n => n.open = true);
}
async function openAdd(page) {
  await page.locator('#open-add').click();
  await page.locator('#works-set').evaluate(n => n.open = true);
}
const sortedCredits = works => works.map(people => people.slice().sort((a,b) => a.name.localeCompare(b.name) || a.role.localeCompare(b.role)));
const selected = row => row.locator('input[type=checkbox]:checked').evaluateAll(ns => ns.map(n => n.value));
async function main() {
  await test('inline syntax and equal translation keys', async () => {
    for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
    const start = html.indexOf('  var I18N = '), end = html.indexOf('  var LANGS = ', start);
    const dict = vm.runInNewContext(html.slice(start, end) + '\nI18N;');
    for (const lang of ['ja', 'zh']) assert.deepEqual(Object.keys(dict[lang]).sort(), Object.keys(dict.en).sort());
  });
  browser = await playwright.chromium.launch({headless: true, ...(executablePath ? {executablePath} : {})});
  await test('album grouping and translated work details stay closed on add and edit', async () => {
    const cd = {id: 'grouping', title: 'Grouping QA', composer: 'Album composer', type: 'Symphony', performers: globalPerformers,
      works: [{title: 'Work', composer: 'Work composer', type: 'Concerto', performers: [{role: 'Pianist', name: 'Work soloist'}], tracks: []}]};
    const f = await fixture([cd]), {page} = f;
    try {
      await edit(page, cd.title);
      assert.deepEqual(await page.locator('#albumOverall').evaluate(n => Array.from(n.querySelectorAll('#composer,#type,#perf-set')).map(n => n.id)), ['composer', 'type', 'perf-set']);
      assert.equal(await page.locator('#albumOverall').evaluate(n => !!(n.compareDocumentPosition(document.querySelector('#works-set')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
      for (const [lang, title, type, details, composerPh, typePh] of [
        ['en', 'Title', 'Type of work', 'Work details', 'Composer', 'Type of work'],
        ['ja', 'タイトル', '作品の種類', '作品の詳細', '作曲家', '作品の種類'],
        ['zh', '标题', '作品类型', '作品详情', '作曲家', '作品类型']
      ]) {
        await page.evaluate(lang => window.workFormQA.setLang(lang, false), lang);
        assert.equal(await page.locator('label[for=title] [data-i18n]').textContent(), title);
        assert.equal(await page.locator('label[for=type]').textContent(), type);
        assert.equal(await page.locator('.w-details > summary').textContent(), details);
        assert.equal(await page.locator('.w-composer').getAttribute('placeholder'), composerPh);
        assert.equal(await page.locator('.w-type').getAttribute('placeholder'), typePh);
        assert.equal(await page.locator('.w-details').getAttribute('open'), null);
        assert.equal(await page.locator('.w-composer').isVisible(), false);
        assert.equal(await page.locator('.w-performers').isVisible(), false);
      }
      assert.equal(await page.locator('.w-details').evaluate(n => !!(n.parentElement.querySelector('.tracks').compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
      await page.evaluate(() => { window.workFormQA.clearForm(); });
      assert.equal(await page.locator('.w-details').getAttribute('open'), null);
      assert.equal(await page.locator('.w-composer').inputValue(), '');
    } finally { await f.close(); }
  });
  await test('blank work fields remain inherited through save, reload and album metadata edits', async () => {
    const f = await fixture(), {page, state} = f;
    try {
      await openAdd(page);
      await page.locator('#title').fill('Inherited QA');
      await page.locator('#composer').fill('Album composer');
      await page.locator('#type').fill('Symphony');
      await page.locator('#perf-rows .perf-name').fill('Album conductor');
      await page.locator('.w-title').fill('Inherited work');
      await page.locator('.w-details > summary').click();
      await page.locator('.w-add-perf').click(); // An empty performer row must not become an override.
      await save(page);
      let cd = state.doc.cds[0], w = cd.works[0];
      assert.equal(w.composer || '', ''); assert.equal(w.type, undefined); assert.equal(w.performers, undefined);
      assert.deepEqual(await page.evaluate(cd => window.workFormQA.workMetadata(cd, cd.works[0]), cd),
        {composer: 'Album composer', type: 'Symphony', performers: globalPerformers});
      await page.reload(); await edit(page, cd.title);
      assert.equal(await page.locator('.w-details').getAttribute('open'), null);
      assert.equal(await page.locator('.w-composer').inputValue(), '');
      assert.equal(await page.locator('.w-type').inputValue(), '');
      assert.deepEqual(await page.locator('.w-perf-rows .perf-name').allTextContents(), []);
      await page.locator('#composer').fill('Updated album composer');
      await page.locator('#type').fill('Concerto');
      await page.locator('#perf-rows .perf-name').fill('Updated conductor');
      await save(page);
      cd = state.doc.cds[0]; w = cd.works[0];
      assert.equal(w.composer || '', ''); assert.equal(w.type, undefined); assert.equal(w.performers, undefined);
      assert.deepEqual(await page.evaluate(cd => window.workFormQA.workMetadata(cd, cd.works[0]), cd),
        {composer: 'Updated album composer', type: 'Concerto', performers: [{role: 'Conductor', name: 'Updated conductor'}]});
      assert.deepEqual(await page.evaluate(cd => window.workFormQA.workOverrides(cd, cd.works[0]), cd), {});
    } finally { await f.close(); }
  });
  await test('work role controls keep multiple/custom roles scoped, survive edit, and clear back to inheritance', async () => {
    const f = await fixture(), {page, state} = f;
    try {
      await openAdd(page); await page.locator('#title').fill('Overrides QA');
      await page.locator('#composer').fill('Album composer'); await page.locator('#type').fill('Symphony');
      await page.locator('#perf-rows .perf-name').fill('Album conductor');
      await page.locator('.w-title').fill('Work one');
      await page.locator('.w-details > summary').click();
      await page.locator('.w-composer').fill('Own composer'); await page.locator('.w-type').fill('Sonata');
      await page.locator('.w-add-perf').click();
      const row = page.locator('.w-perf-rows .prow').first();
      await row.locator('.perf-name').fill('  Work soloist  '); await row.locator('.perf-role-trigger').click();
      assert.equal(await row.getByRole('checkbox', {name: 'Conductor', exact: true}).isDisabled(), true);
      await row.getByRole('checkbox', {name: 'Pianist', exact: true}).check();
      await row.getByRole('checkbox', {name: 'Conductor', exact: true}).uncheck();
      await row.getByRole('checkbox', {name: 'Other', exact: true}).check();
      await row.locator('.perf-custom-name').fill('Organist'); await page.keyboard.press('Enter');
      assert.deepEqual(await selected(row), ['Pianist', 'Organist']);
      await page.keyboard.press('Escape');
      assert.equal(await row.locator('.perf-role-trigger').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#win-cd').isVisible(), true);
      await page.locator('#add-work').click(); await page.locator('.w-title').nth(1).fill('Work two');
      await save(page);
      let cd = state.doc.cds[0];
      const own = [{role: 'Pianist', name: 'Work soloist'}, {role: 'Organist', name: 'Work soloist'}];
      assert.deepEqual(cd.performers, globalPerformers); assert.deepEqual(cd.works[0].performers, own);
      assert.equal(cd.works[1].performers, undefined);
      await page.reload(); await edit(page, cd.title);
      assert.equal(await page.locator('.w-details[open]').count(), 0);
      assert.deepEqual(await selected(row), ['Pianist', 'Organist']);
      await page.locator('.w-details > summary').first().click();
      assert.equal(await page.locator('.w-perf-rows .prow').count(), 1, 'same-name role pairs reload as one row');
      await page.locator('.w-composer').first().fill(''); await page.locator('.w-type').first().fill('');
      await row.locator('.iconbtn').click(); await save(page);
      cd = state.doc.cds[0];
      assert.equal(cd.works[0].performers, undefined); assert.equal(cd.works[0].type, undefined);
      assert.deepEqual(await page.evaluate(cd => window.workFormQA.workMetadata(cd, cd.works[0]), cd),
        {composer: 'Album composer', type: 'Symphony', performers: globalPerformers});
    } finally { await f.close(); }
  });
  const lookup = {title: 'Source QA', composer: 'Album composer', type: 'Symphony', performers: globalPerformers,
    works: [{title: 'Imported work', composer: 'Source composer', type: 'Sonata',
      performers: [{role: 'Pianist', name: 'Source soloist'}], tracks: [{title: 'Movement', duration: '2:34'}]}]};
  await test('lookup preserves per-work metadata and ignores role checkbox values when clearing prior source data', async () => {
    const f = await fixture(), {page} = f;
    try {
      await openAdd(page); await page.evaluate(p => window.workFormQA.fillFromLookup(p), lookup);
      assert.equal(await page.locator('.w-details').getAttribute('open'), null);
      assert.equal(await page.locator('.w-perf-rows .perf-name.filled').inputValue(), 'Source soloist');
      assert.equal(await page.locator('#work-list input[type=checkbox].filled').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.workFormQA.readWorks()), lookup.works);
      await page.evaluate(() => window.workFormQA.fillFromLookup({title: 'Incomplete source'}));
      assert.equal(await page.locator('.w-title').inputValue(), '');
      assert.equal(await page.locator('.w-perf-rows .prow').count(), 0);
      assert.equal(await page.locator('#perf-rows .perf-name').inputValue(), '');
    } finally { await f.close(); }
  });
  await test('editing a source work role keeps that work on an incomplete lookup without keeping untouched global credits', async () => {
    const f = await fixture(), {page, state} = f;
    try {
      await openAdd(page); await page.evaluate(p => window.workFormQA.fillFromLookup(p), lookup);
      await page.locator('.w-details > summary').click();
      const row = page.locator('.w-perf-rows .prow');
      await row.locator('.perf-role-trigger').click();
      await row.getByRole('checkbox', {name: 'Conductor', exact: true}).check();
      await page.keyboard.press('Escape');
      assert.equal(await row.locator('.perf-name.filled').count(), 0);
      assert.equal(await page.locator('.w-title.filled').count(), 0);
      await page.evaluate(() => window.workFormQA.fillFromLookup({title: 'Incomplete source'}));
      assert.equal(await page.locator('.w-title').inputValue(), 'Imported work');
      assert.equal(await row.locator('.perf-name').inputValue(), 'Source soloist');
      assert.equal(await page.locator('#perf-rows .perf-name').inputValue(), '');
      await save(page);
      assert.deepEqual(state.doc.cds[0].performers, []);
      assert.deepEqual(state.doc.cds[0].works[0].performers,
        ['Conductor', 'Pianist'].map(role => ({role, name: 'Source soloist'})));
      assert.equal(state.doc.cds[0].works[0].composer, 'Source composer');
      assert.equal(state.doc.cds[0].works[0].type, 'Sonata');
      assert.deepEqual(state.doc.cds[0].works[0].tracks, lookup.works[0].tracks);
    } finally { await f.close(); }
  });
  await test('Discogs work and track credits reach the form and survive save/edit in their original work', async () => {
    const f = await fixture(), {page, state} = f;
    try {
      await page.route('https://api.discogs.com/releases/765', route => route.fulfill({json: {
        id: 765, title: 'Discogs Work QA', formats: [{name: 'CD', qty: '1'}],
        extraartists: [{name: 'Album conductor', role: 'Conductor'}],
        tracklist: [
          {type_: 'index', title: 'Piano Sonata', extraartists: [{name: 'Index soloist', role: 'Piano'}],
            sub_tracks: [{type_: 'track', position: '1', title: 'Allegro', duration: '3:45',
              extraartists: [{name: 'Track soloist', role: 'Violin'}]}]},
          {type_: 'index', title: 'Cello Sonata', extraartists: [{name: 'Other soloist', role: 'Cello'}],
            sub_tracks: [{type_: 'track', position: '2', title: 'Andante', duration: '2:00'}]}
        ]
      }}));
      await openAdd(page);
      await page.evaluate(async () => {
        const result = await window.workFormQA.discogsSource.details({id: 765}, 'QA001');
        window.workFormQA.fillFromLookup(result);
      });
      const own = [[{role: 'Pianist', name: 'Index soloist'}, {role: 'Violinist', name: 'Track soloist'}],
        [{role: 'Cellist', name: 'Other soloist'}]];
      assert.equal(await page.locator('.w-details[open]').count(), 0);
      await save(page);
      assert.deepEqual(sortedCredits(state.doc.cds[0].works.map(w => w.performers)), sortedCredits(own));
      await page.reload(); await edit(page, 'Discogs Work QA');
      assert.equal(await page.locator('.w-details[open]').count(), 0);
      assert.deepEqual(await page.locator('.w-perf-rows').evaluateAll(ns => ns.map(n => Array.from(n.querySelectorAll('.perf-name')).map(n => n.value).sort())),
        [['Index soloist', 'Track soloist'], ['Other soloist']]);
      await save(page);
      assert.deepEqual(sortedCredits(state.doc.cds[0].works.map(w => w.performers)), sortedCredits(own));
    } finally { await f.close(); }
  });
  await test('Chinese clear hub displays 胶圈 while old 透明圈 still normalizes on save', async () => {
    const f = await fixture(), {page, state} = f;
    try {
      await openAdd(page);
      await page.evaluate(() => window.workFormQA.setLang('zh', false));
      assert.deepEqual(await page.locator('#hub-options [role=option]').allTextContents(), ['满银圈', '半银圈', '胶圈', '其他']);
      await page.locator('#title').fill('Hub alias QA');
      await page.locator('#more-details > summary').click(); await page.locator('#hub').fill('透明圈'); await save(page);
      assert.equal(state.doc.cds[0].hub, 'clear');
      await page.locator('#grid .card').click();
      await page.locator('.profile-actions > button').first().click();
      assert.equal(await page.locator('#hub').inputValue(), '胶圈');
      await save(page);
      assert.equal(state.doc.cds[0].hub, 'clear');
    } finally { await f.close(); }
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  console.log(`${results.filter(Boolean).length}/${results.length} work form checks passed`);
  if (results.includes(false)) process.exitCode = 1;
});
