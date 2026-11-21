/* Run: node tests/form-sections.cjs
   Isolated browser state and mocked native calls; never touches the real library. */
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
const fixtureHtml = html.replace('  /* ---------- start ---------- */',
  '  window.sectionQA = { clearForm, startEdit, setLang, resetWorks, readWorks, workMetadata, failOn: function(selector) { readWorks = function() { return { bad: document.querySelector(selector) }; }; } };\n  /* ---------- start ---------- */');
const sectionIds = ['albumOverall', 'works-set', 'more-details', 'form-audio-set'];
const cd = {id: 'section-qa', title: 'Section QA', performers: [{role: 'Conductor', name: 'Album conductor'}],
  works: [{title: 'Work', tracks: [{title: 'Movement', duration: '2:00'}]}]};
let browser;
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('PASS:', name); }
  catch (error) { results.push(false); console.error('FAIL:', name, error.stack); }
}
async function fixture({native = false, cds = [cd]} = {}) {
  const state = {doc: structuredClone({cds, meta: {albums: [], playlists: [], settings: {lang: 'en'}}}), errors: [], commands: []};
  const context = await browser.newContext({viewport: {width: 1100, height: 850}, reducedMotion: 'reduce'});
  if (native) await context.exposeBinding('__sectionInvoke', async (_, command, args = {}) => {
    state.commands.push({command, args});
    switch (command) {
      case 'load_data': return structuredClone(state.doc);
      case 'save_data': state.doc = structuredClone(args.data); return null;
      case 'covers_root_dir': return 'C:\\isolated-section-qa\\covers';
      case 'audio_root_dir': return 'C:\\isolated-section-qa\\audio';
      case 'audio_present': return args.files.map(() => false);
      case 'tidy_covers': return null;
      case 'add_audio': return [{file: args.cdId + '/movement.flac', name: 'movement.flac', size: 100}];
      case 'remove_audio': return null;
      default: throw new Error('Unexpected native command: ' + command);
    }
  });
  await context.addInitScript(native => {
    window.CDC_DESKTOP = true;
    localStorage.setItem('cdc.lang', 'en');
    if (native) window.__TAURI__ = {core: {invoke: (command, args) => window.__sectionInvoke(command, args),
      convertFileSrc: file => location.origin + '/isolated/' + encodeURIComponent(file)}};
  }, native);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'cdc-sections.test') {
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
  await page.goto('http://cdc-sections.test/');
  if (cds.length) await page.locator('#grid .card').first().waitFor();
  else await page.locator('#open-add').waitFor();
  return {page, state, close: async () => { await context.close(); assert.deepEqual(state.errors, []); }};
}
async function save(page) {
  await page.locator('#submit').click();
  await page.locator('#win-cd').waitFor({state: 'hidden'});
}
async function openEdit(page, data = cd) { await page.evaluate(data => window.sectionQA.startEdit(data), data); }
async function main() {
  await test('script syntax, translations and exactly one additional-performers load/save statement', async () => {
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
    const start = html.indexOf('  var I18N = '), end = html.indexOf('  var LANGS = ', start);
    const dict = vm.runInNewContext(html.slice(start, end) + '\nI18N;');
    for (const lang of ['ja', 'zh']) assert.deepEqual(Object.keys(dict[lang]).sort(), Object.keys(dict.en).sort());
    assert.equal((html.match(/box\.dataset\.performersMode = "additional"/g) || []).length, 1);
    assert.equal((html.match(/work\.performersMode = "additional"/g) || []).length, 1);
  });
  browser = await playwright.chromium.launch({headless: true, ...(executablePath ? {executablePath} : {})});
  await test('sections preserve IDs/order, native disclosure markers and default states through clear and edit', async () => {
    const f = await fixture(), {page} = f;
    try {
      await page.locator('#open-add').click();
      assert.deepEqual(await page.locator('#cd-form > .form-section').evaluateAll(ns => ns.map(n => [n.id, n.tagName, n.open])),
        sectionIds.map((id, i) => [id, 'DETAILS', i === 0]));
      assert.equal(await page.locator('#form-audio-set').isHidden(), true);
      for (const id of sectionIds) {
        const summary = page.locator('#' + id + ' > summary');
        assert.equal(await summary.evaluate(n => getComputedStyle(n).display), 'list-item');
        assert.notEqual(await summary.evaluate(n => getComputedStyle(n).listStyleType), 'none');
      }
      await page.locator('#albumOverall > summary').click(); await page.locator('#works-set > summary').click();
      await page.evaluate(() => window.sectionQA.clearForm());
      assert.deepEqual(await page.locator('#cd-form > .form-section').evaluateAll(ns => ns.map(n => n.open)), [true, false, false, false]);
      await openEdit(page);
      assert.deepEqual(await page.locator('#cd-form > .form-section').evaluateAll(ns => ns.map(n => n.open)), [true, true, false, false]);
      assert.equal(await page.locator('.w-details').getAttribute('open'), null);
      assert.equal(await page.locator('.work > [data-i18n=addTrack]').evaluate(n => !!(n.compareDocumentPosition(n.parentElement.querySelector('.w-details')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
      await page.locator('.work > [data-i18n=addTrack]').click();
      assert.equal(await page.locator('.trow').count(), 2);
    } finally { await f.close(); }
  });
  await test('translated short labels, parenthesized wrapping hints, Other hub and separators work in both themes', async () => {
    const f = await fixture(), {page, state} = f;
    try {
      await openEdit(page); await page.setViewportSize({width: 375, height: 740});
      for (const [lang, album, composer, type, performers, spars, hub, other] of [
        ['en', 'CD information', 'Composer', 'Type of work', 'Performers', 'Audio technology', 'Inner ring manufacturing', 'Other'],
        ['ja', 'CDの情報', '作曲家', '作品の種類', '演奏者', '音声技術', '内周部の製造方式', 'その他'],
        ['zh', 'CD信息', '作曲家', '作品类型', '演奏者', '音频技术', '内圈制作工艺', '其他']
      ]) {
        await page.evaluate(lang => window.sectionQA.setLang(lang, false), lang);
        assert.equal(await page.locator('#albumOverall > summary [data-i18n=albumOverall]').textContent(), album);
        assert.equal(await page.locator('.w-composer').getAttribute('placeholder'), composer);
        assert.equal(await page.locator('.w-type').getAttribute('placeholder'), type);
        assert.equal(await page.locator('.w-performers legend').textContent(), performers);
        assert.equal(await page.locator('label[for=spars]').textContent(), spars);
        assert.equal(await page.locator('label[for=hub]').textContent(), hub);
        assert.equal((await page.locator('#hub-options [role=option]').allTextContents()).at(-1), other);
        for (const id of ['albumOverall', 'works-set']) {
          assert.match(await page.locator('#' + id + ' > summary .section-hint').textContent(), /^ \(.+\)$/);
          assert.equal(await page.locator('#' + id + ' > summary').evaluate(n => getComputedStyle(n).whiteSpace), 'normal');
        }
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
          assert.deepEqual(await page.locator('#cd-form > .form-section').evaluateAll(ns => ns.map(n => {
            const s = getComputedStyle(n), probe = document.createElement('span');
            probe.style.color = 'var(--line)'; n.appendChild(probe);
            const expectedColor = getComputedStyle(probe).color; probe.remove();
            return [s.borderTopWidth, s.borderBottomWidth, s.borderBottomColor === expectedColor];
          })), [['1px', '1px', true], ['0px', '1px', true], ['0px', '1px', true], ['0px', '1px', true]]);
          assert.equal(await page.locator('#cd-form').evaluate(n => n.scrollWidth <= n.clientWidth), true);
        }
      }
      await page.locator('#more-details').evaluate(n => n.open = true); await page.locator('#hub').fill('其他');
      await save(page); assert.equal(state.doc.cds[0].hub, 'other');
    } finally { await f.close(); }
  });
  await test('album and works summary titles, parentheses and hint text have equal computed font sizes in every locale', async () => {
    const f = await fixture(), {page} = f;
    try {
      await openEdit(page);
      for (const width of [1100, 375]) {
        await page.setViewportSize({width, height: 850});
        for (const lang of ['en', 'ja', 'zh']) {
          await page.evaluate(lang => window.sectionQA.setLang(lang, false), lang);
          for (const theme of ['light', 'dark']) {
            await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
            for (const id of ['albumOverall', 'works-set']) {
              for (const open of [false, true]) {
                await page.locator('#' + id).evaluate((n, value) => n.open = value, open);
                const sizes = await page.locator('#' + id + ' > summary').evaluate(summary => {
                  const title = summary.querySelector(':scope > [data-i18n]');
                  const parentheses = summary.querySelector('.section-hint');
                  const hintText = parentheses.querySelector('[data-i18n]');
                  return [title, parentheses, hintText].map(n => getComputedStyle(n).fontSize);
                });
                const context = `${id}, ${lang}, ${theme}, ${width}px, open=${open}`;
                assert(Number.parseFloat(sizes[0]) > 0, context + ': title must have a visible font size');
                assert.equal(sizes[1], sizes[0], context + ': parentheses must match the title');
                assert.equal(sizes[2], sizes[0], context + ': translated hint text must match the title');
              }
            }
          }
        }
      }
    } finally { await f.close(); }
  });
  await test('exact localized example placeholders omit optional wording and type/hub accept custom text beyond suggestions', async () => {
    const f = await fixture({cds: []}), {page, state} = f;
    const examples = [
      ['en', 'e.g. Sergei Rachmaninoff', 'e.g. Piano concerto', 'e.g. Full silver hub', 'Piano concerto', 'Full silver hub'],
      ['ja', '例：ラフマニノフ', '例：ピアノ協奏曲', '例：全面銀色ハブ', 'ピアノ協奏曲', '全面銀色ハブ'],
      ['zh', '例如：拉赫玛尼诺夫', '例如：钢琴协奏曲', '例如：满银圈', '钢琴协奏曲', '满银圈']
    ];
    try {
      const staticPlaceholders = await page.evaluate(source => {
        const doc = new DOMParser().parseFromString(source, 'text/html');
        return ['composer', 'type', 'hub'].map(id => doc.getElementById(id).getAttribute('placeholder'));
      }, html);
      assert.deepEqual(staticPlaceholders, examples[0].slice(1, 4), 'static English HTML must match the translated examples');
      for (const [lang, composer, type, hub, typeSuggestion, hubSuggestion] of examples) {
        await page.locator('#open-add').click();
        await page.evaluate(lang => window.sectionQA.setLang(lang, false), lang);
        const placeholders = await page.locator('#composer, #type, #hub').evaluateAll(ns => ns.map(n => n.placeholder));
        assert.deepEqual(placeholders, [composer, type, hub], lang + ': exact examples');
        for (const placeholder of placeholders) assert(!/optional|任意|可选|选填|if known/i.test(placeholder), lang + ': optional wording');
        await page.locator('#more-details > summary').click();
        for (const id of ['type', 'hub']) {
          assert.deepEqual(await page.locator('#' + id).evaluate(n => [n.tagName, n.type, n.readOnly, n.disabled]),
            ['INPUT', 'text', false, false], lang + ': ' + id + ' must remain editable free text');
        }
        assert((await page.locator('#work-type-options option').evaluateAll(ns => ns.map(n => n.value))).includes(typeSuggestion));
        assert((await page.locator('#hub-options [role=option]').allTextContents()).includes(hubSuggestion));
        const customType = 'Hybrid work / 創作 / 混合 ' + lang, customHub = 'Mirror ring / 手工 ' + lang;
        await page.locator('#title').fill('Typography QA ' + lang);
        await page.locator('#type').fill(customType); await page.locator('#hub').fill(customHub);
        await save(page);
        const stored = state.doc.cds.find(cd => cd.title === 'Typography QA ' + lang);
        assert.equal(stored.type, customType); assert.equal(stored.hub, customHub);
        await openEdit(page, stored);
        assert.equal(await page.locator('#type').inputValue(), customType);
        assert.equal(await page.locator('#hub').inputValue(), customHub);
        await save(page);
      }
    } finally { await f.close(); }
  });
  await test('submit expands invalid duration fields while free-text recording/release years and technique save unchanged', async () => {
    const f = await fixture(), {page,state} = f;
    try {
      await openEdit(page);
      await page.locator('.t-len').evaluate(n => n.value = '2:99');
      await page.locator('#submit').click();
      assert.equal(await page.locator('#works-set').evaluate(n => n.open), true);
      assert.equal(await page.locator('.t-len').evaluate(n => document.activeElement === n), true);
      await page.locator('.t-len').fill('2:00');
      const values={recordingYear:'Before 1900; 1977–1984 / dates unknown / 未詳',releaseYear:'1995 (reissue 2007), circa',spars:'ADD/DDD – mixed analogue and digital'};
      await page.locator('#more-details').evaluate(n=>n.open=true);
      for(const [id,value] of Object.entries(values))await page.locator('#'+id).fill(value);
      await save(page);
      for(const [id,value] of Object.entries(values))assert.equal(state.doc.cds[0][id],value);
      await openEdit(page,state.doc.cds[0]);
      for(const [id,value] of Object.entries(values))assert.equal(await page.locator('#'+id).inputValue(),value);
      await save(page);
    } finally { await f.close(); }
  });
  await test('submit focus also expands nested work/performer details if a validator reports a custom-role field', async () => {
    const custom = {...cd, works: [{title: 'Work', performers: [{role: 'Other', name: 'Soloist'}], tracks: []}]};
    const f = await fixture(), {page} = f;
    try {
      await openEdit(page, custom);
      await page.evaluate(() => window.sectionQA.failOn('.w-perf-rows .perf-custom-name'));
      await page.locator('#submit').click();
      assert.equal(await page.locator('#works-set').evaluate(n => n.open), true);
      assert.equal(await page.locator('.w-details').evaluate(n => n.open), true);
      assert.equal(await page.locator('.w-perf-rows .perf-role-trigger').evaluate(n => n.getAttribute('aria-expanded') === 'true'), true);
      assert.equal(await page.locator('.w-perf-rows .perf-custom-name').evaluate(n => document.activeElement === n), true);
    } finally { await f.close(); }
  });
  await test('folded audio keeps native add/track assignment behavior and original IDs', async () => {
    const f = await fixture({native: true}), {page, state} = f;
    try {
      await openEdit(page);
      assert.equal(await page.locator('#form-audio-set').isHidden(), false);
      assert.equal(await page.locator('#form-audio-set').evaluate(n => n.open), false);
      await page.locator('#form-audio-set > summary').click();
      await page.locator('#form-audio-add').click();
      await page.locator('#form-audio-track-0').waitFor();
      assert.equal(await page.locator('#form-audio-track-0').inputValue(), '1');
      assert.equal(await page.locator('#form-audio-set').evaluate(n => n.open), true, 'audio redraw must preserve disclosure state');
      await save(page);
      assert.equal(state.doc.cds[0].audio[0].file, 'section-qa/movement.flac');
      assert.equal(state.doc.cds[0].audio[0].track, 1);
      assert.equal(state.commands.filter(x => x.command === 'add_audio').length, 1);
    } finally { await f.close(); }
  });
  await test('additional credits mode survives save/edit/manual extras edits and disappears when extras are empty', async () => {
    const imported = {...cd, works: [{title: 'Work', performersMode: 'additional', performers: [{role: 'Pianist', name: 'Extra soloist'}], tracks: []}]};
    const f = await fixture({cds: [imported]}), {page, state} = f;
    try {
      await openEdit(page, imported); await save(page);
      assert.equal(state.doc.cds[0].works[0].performersMode, 'additional');
      assert.deepEqual(state.doc.cds[0].works[0].performers, imported.works[0].performers);
      await page.reload(); await openEdit(page, state.doc.cds[0]);
      assert.equal(await page.locator('.work').getAttribute('data-performers-mode'), 'additional');
      await page.locator('#works-set').evaluate(n=>n.open=true); await page.locator('.w-details > summary').click();
      await page.locator('.w-perf-rows .perf-name').fill('Changed extra soloist'); await save(page);
      assert.equal(state.doc.cds[0].works[0].performersMode, 'additional');
      assert.deepEqual(state.doc.cds[0].works[0].performers, [{role: 'Pianist', name: 'Changed extra soloist'}]);
      await openEdit(page, state.doc.cds[0]);
      await page.locator('#works-set').evaluate(n=>n.open=true); await page.locator('.w-details > summary').click();
      await page.locator('.w-perf-rows .perf-name').fill(''); await save(page);
      const stored = state.doc.cds[0];
      assert.equal(stored.works[0].performers, undefined); assert.equal(stored.works[0].performersMode, undefined);
      assert.deepEqual(await page.evaluate(data => window.sectionQA.workMetadata(data, data.works[0]).performers, stored), cd.performers);
    } finally { await f.close(); }
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  console.log(`${results.filter(Boolean).length}/${results.length} form section checks passed`);
  if (results.includes(false)) process.exitCode = 1;
});
