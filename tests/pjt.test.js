/* =====================================================================
   PJT test suite — v4.0.0
   ---------------------------------------------------------------------
   Everything in one file, on purpose: PJT is a single-file app, and a
   single-file test suite is one thing to copy onto a locked-down machine.

   Run:
       npm install jsdom
       node tests/pjt.test.js

   Optional but strongly recommended — point it at a real backup so the
   schema and privacy tests run against real data rather than fixtures:

       node tests/pjt.test.js /path/to/work-journal-backup-YYYY-MM-DD.json

   WHY THAT MATTERS: the AI-packet counters were once written against
   invented field names (prepNotes/revNotes/openItems instead of the real
   preparer/reviewer/scratch). Every fixture test passed, because the
   fixture shared the same wrong assumption. Only a real backup caught it.

   These drive real DOM events rather than calling functions directly —
   calling the function proves the function works; dispatching proves it
   is wired.
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP = process.env.PJT_APP || path.join(__dirname, '..', 'src', 'index.html');
const CORPUS = process.argv[2] || process.env.PJT_CORPUS || '';

if (!fs.existsSync(APP)) {
  console.error('Cannot find the app at ' + APP + '\nSet PJT_APP=/path/to/index.html');
  process.exit(2);
}
const html = fs.readFileSync(APP, 'utf8');

/* ---------- harness ---------------------------------------------------- */
let pass = 0, fail = 0;
const failures = [];
function t(name, cond) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); }
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
}
function group(name) { console.log('\n— ' + name + ' ' + '-'.repeat(Math.max(0, 58 - name.length))); }
const wait = ms => new Promise(r => setTimeout(r, ms));

/* A shared fake Tauri event bus. Tauri delivers an emit to EVERY webview
   including the sender, so this mimics that faithfully — it is what the
   self-echo guard exists to survive. */
function makeBus() {
  const subs = [];
  return {
    emitted: [],
    hook(){ const bus = this; return {
      emit(evt, payload){ bus.emitted.push({evt, payload});
        subs.slice().forEach(s => { if (s.evt === evt) s.fn({payload}); }); },
      listen(evt, fn){ subs.push({evt, fn}); return Promise.resolve(()=>{}); }
    };}
  };
}

function boot(opts) {
  opts = opts || {};
  const bus = opts.bus;
  return new JSDOM(html, {
    url: 'https://pjt.test/index.html' + (opts.hash || ''),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      if (opts.tauri !== false) {
        w.__TAURI__ = {
          event: bus ? bus.hook() : { emit(){}, listen(){ return Promise.resolve(()=>{}); } },
          webviewWindow: { WebviewWindow: function(){ this.once = ()=>{}; } }
        };
      }
      w.AudioContext = function(){ return {
        createOscillator: () => ({connect(){}, start(){}, stop(){}, frequency:{value:0}}),
        createGain: () => ({connect(){}, gain:{value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){}}}),
        destination:{}, currentTime:0, close(){} }; };
      w.document.execCommand = () => true;
      w.ClipboardItem = function(map){ this.map = map; w.__lastClip = map; };
      Object.defineProperty(w.navigator, 'clipboard', {
        configurable: true,
        value: {
          write: items => { w.__lastClip = items[0].map; return Promise.resolve(); },
          writeText: s => { w.__lastClip = {'text/plain': s}; return Promise.resolve(); }
        }
      });
    }
  });
}
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', {bubbles:true}));
const key   = (w, el, k, o) => el.dispatchEvent(new w.KeyboardEvent('keydown',
                Object.assign({key:k, bubbles:true, cancelable:true}, o||{})));

/* A fixture that uses the REAL schema. Kept deliberately sensitive-looking
   so the privacy assertions have something to fail on. */
const FIXTURE = {
  journal: { projects: [
    { id:'p1', name:'OXBINC Review 12-31-25', clientCode:'OXBINC', archived:false,
      notes:'Call Karen Whitfield at Oxbow re: 2.4M inventory writedown',
      sections:[
        {name:'B - Receivables', preparer:'confirmed with Wells Fargo', reviewer:'', scratch:'need AR aging from client'},
        {name:'D - Inventory',   preparer:'', reviewer:'reviewed 3/14', scratch:''}]},
    { id:'p2', name:'LEGCUS Compilation 5-31-26', clientCode:'LEGCUS', archived:true, notes:'',
      sections:[{name:'A - Cash', preparer:'tied to bank stmt', reviewer:'', scratch:''}]}
  ]},
  timecard: { days: { '2026-03-14': { dayStart:'8:00 AM', codes:[], win:[], entries:[
    {id:1, code:'A', stop:'10:30', desc:'Oxbow fieldwork'},
    {id:2, code:'B', stop:'12:00', desc:'Legacy compilation'}]}}}
};

/* ====================================================================== */
async function main() {

/* ---------- 1. boot + storage isolation -------------------------------- */
group('boot and window isolation');
{
  const bus = makeBus();
  const main = boot({bus}), pop = boot({bus, hash:'#bell'}), guide = boot({bus, hash:'#guide'});
  await wait(900);
  t('main window boots the app', main.window.eval("Object.keys(db).indexOf('journal')") >= 0);
  t('timer popout writes NO storage', pop.window.localStorage.length === 0);
  t('guide popout writes NO storage', guide.window.localStorage.length === 0);
  t('guide popout builds its shell', !!guide.window.document.getElementById('guideHostWin'));
  t('guide popout keeps the AI packet modal', !!guide.window.document.getElementById('aiPacketBg'));
  main.window.close(); pop.window.close(); guide.window.close();
}

/* ---------- 2. focus timer, two windows -------------------------------- */
group('focus timer — popout acts locally, both windows converge');
{
  const bus = makeBus();
  const main = boot({bus}), pop = boot({bus, hash:'#bell'});
  await wait(900);
  const mw = main.window, pw = pop.window, pd = pw.document;

  click(pw, pd.getElementById('bellStartBtn'));
  t('START acts locally in the popout', pw.eval('bell.running') === true);
  t('START label flips to Pause', pd.getElementById('bellStartBtn').textContent === 'Pause');
  t('START reaches the MAIN window', mw.eval('bell.running') === true);

  click(pw, pd.getElementById('bellStartBtn'));
  t('PAUSE acts locally', pw.eval('bell.running') === false);

  const dur = pd.getElementById('bellDur');
  dur.value = '45'; dur.dispatchEvent(new pw.Event('change', {bubbles:true}));
  t('custom minutes apply (45 → 2700s)', pw.eval('bell.total') === 2700);
  t('custom minutes reach the main window', mw.eval('bell.total') === 2700);

  dur.value = '12'; key(pw, dur, 'Enter');
  t('Enter commits a custom time (12 → 720s)', pw.eval('bell.total') === 720);

  click(pw, pd.getElementById('bellResetBtn'));
  t('RESET acts locally', pw.eval('bell.running') === false && pw.eval('bell.left') === pw.eval('bell.total'));
  t('RESET reaches the main window', mw.eval('bell.running') === false);

  click(mw, mw.document.getElementById('bellStartBtn'));
  t('main → popout still works', pw.eval('bell.running') === true);
  click(mw, mw.document.getElementById('bellResetBtn'));
  t('main RESET reaches the popout', pw.eval('bell.running') === false);

  t('every emit carries a source id (self-echo guard)',
    bus.emitted.length > 0 && bus.emitted.every(e => e.payload && e.payload._src));
  main.window.close(); pop.window.close();
}

/* ---------- 3. appbar / gear ------------------------------------------- */
group('appbar — the gear must never wrap');
{
  t('appbar is flex-wrap:nowrap', /\.appbar\{[^}]*flex-wrap:nowrap/.test(html));
  t('gear menu has an explicit z-index', /\.gear-menu\{[^}]*z-index:60/.test(html));
  t('gear menu caps its height', /\.gear-menu\{[^}]*max-height:72vh/.test(html));
}

/* ---------- 4. guide structure ----------------------------------------- */
group('guide — layout, doors, navigation, search');
{
  const d = boot({}); await wait(900);
  const w = d.window, doc = w.document;
  w.openGuide();
  const host = doc.getElementById('guideHostModal');
  const nav = host.querySelector('.gd-nav'), body = host.querySelector('.gd-body');

  t('no duplicate All-sections grid', !body.querySelector('.gd-toc'));
  t('home shows exactly 3 doors', body.querySelectorAll('.gd-door').length === 3);
  t('prose is width-capped', !!body.querySelector('.gd-measure'));
  t('sidebar has 5 group labels', nav.querySelectorAll('.gd-grp').length === 5);
  t('groups in the agreed order',
    [...nav.querySelectorAll('.gd-grp')].map(e=>e.textContent).join('|') ===
    'Getting started|Using PJT|Making it yours|Your data|Help');
  t('19 sections + home + search + back/fwd in the sidebar',
    nav.querySelectorAll('button').length === 19 + 2 + 2);
  t('first door names the quick start',
    /quick start guide/i.test(host.querySelector('.gd-door-t').textContent));

  // back / forward
  const [back, fwd] = nav.querySelectorAll('.gd-histbar button');
  t('back starts disabled', back.disabled);
  t('forward starts disabled', fwd.disabled);
  click(w, body.querySelectorAll('.gd-door')[2]);
  t('a door opens its link list', !!host.querySelector('.gd-body .gd-link'));
  click(w, host.querySelectorAll('.gd-body .gd-link')[0]);
  t('a link jumps into a section', /FAQ/.test(host.querySelector('.gd-body h3').textContent));
  click(w, back);
  t('Back returns to the door', /Something/.test(host.querySelector('.gd-body h3').textContent));
  click(w, fwd);
  t('Forward returns to the section', /FAQ/.test(host.querySelector('.gd-body h3').textContent));

  // search
  const inp = host.querySelector('.gd-top input');
  t('search placeholder is not a syntax lecture', inp.placeholder === 'Search the guide');
  inp.value = 'gist AND token'; key(w, inp, 'Enter');
  t('boolean search returns hits', host.querySelectorAll('.gd-hit').length > 0);
  inp.value = '"recovery key"'; key(w, inp, 'Enter');
  t('phrase search returns hits', host.querySelectorAll('.gd-hit').length > 0);
  inp.value = 'backup -browser'; key(w, inp, 'Enter');
  t('exclusion search returns hits', host.querySelectorAll('.gd-hit').length > 0);

  // stale content
  const src = doc.getElementById('guideSource').textContent;
  t('stale "Tap any heading" is gone', src.indexOf('Tap any heading') < 0);
  t('no editorialising about a "scary" warning', !/scary/i.test(src));
  t('macOS install guidance present', /damaged/.test(src) && /xattr/.test(src));
  t('Releases is the documented download', /Releases/.test(src));
  t('no promise of unbuilt encrypted sync', !/encrypting it needs a shared key/i.test(src));
  t('accurate plaintext-sync warning retained', /readable JSON/i.test(src));
  d.window.close();
}

/* ---------- 5. AI help packet ------------------------------------------ */
group('AI help packet — privacy is the feature');
{
  const d = boot({}); await wait(900);
  const w = d.window, doc = w.document;
  w.eval('db = mergeDefaults(' + JSON.stringify(FIXTURE) + ');');

  const packet = w.eval('aiPacketText()');
  const forbidden = ['OXBINC','LEGCUS','Oxbow','Karen','Whitfield','Wells Fargo','Receivables',
                     'Inventory','AR aging','fieldwork','tied to bank stmt','12-31-25','2026-03-14','2.4M','PJT1-'];
  const leaks = forbidden.filter(x => packet.indexOf(x) >= 0);
  t('packet leaks NOTHING sensitive' + (leaks.length ? ' — LEAKED: ' + leaks.join(', ') : ''), leaks.length === 0);

  t('reports project count', /Projects: 2 \(1 archived\)/.test(packet));
  t('reports section count', /sections across all projects: 3/.test(packet));
  t('reports non-empty notes', /Non-empty note fields: 5/.test(packet));
  t('reports time entries', /Time entries: 2/.test(packet));
  t('reports a real version, not "unknown"', /PJT version: \d+\.\d+\.\d+/.test(packet));
  t('reports browser vs desktop', /Running as: /.test(packet));
  t('tells the AI to ask before destructive advice', /export a backup first/.test(packet));
  t('explains the one-file architecture', /ONE HTML file/.test(packet));
  t('includes the public repo URL', /github\.com\/projectjournalandtimecard-PJT/.test(packet));
  t('has a slot for the user problem', /## My problem/.test(packet));

  const ta = doc.getElementById('aiPacketText');
  t('preview starts empty', ta.value === '');
  t('preview is readonly', ta.hasAttribute('readonly'));
  w.aiPacketOpen();
  t('opening fills the preview', ta.value.length > 800);
  t('opening shows the modal', doc.getElementById('aiPacketBg').classList.contains('open'));

  // the popped-out guide has no db — it must be handed a counts-only context
  const param = w.eval('guideCtxParam()');
  const raw = Buffer.from(param, 'base64').toString('utf8');
  t('guide context carries counts', /"projects":2/.test(raw));
  t('guide context leaks no names', !forbidden.some(x => raw.indexOf(x) >= 0));
  const pop = boot({hash:'#guide|' + param}); await wait(800);
  const pk = pop.window.eval('aiPacketText()');
  t('POPOUT packet reports the real version', /PJT version: \d+\.\d+\.\d+/.test(pk) && !/unknown/.test(pk));
  t('POPOUT packet reports 2 projects, not 0', /Projects: 2 \(1 archived\)/.test(pk));
  t('POPOUT packet leaks nothing', !forbidden.some(x => pk.indexOf(x) >= 0));
  d.window.close(); pop.window.close();
}

/* ---------- 6. keyboard shortcuts -------------------------------------- */
group('keyboard shortcuts — never fire while typing');
{
  const d = boot({}); await wait(900);
  const w = d.window, doc = w.document;
  w.eval('db = mergeDefaults(' + JSON.stringify(FIXTURE) + '); renderJournal();');

  w.eval("switchMain('journal')");
  key(w, doc, '2', {ctrlKey:true});
  t('Ctrl+2 → Time Card', doc.getElementById('main-timecard').classList.contains('active'));
  key(w, doc, '1', {ctrlKey:true});
  t('Ctrl+1 → Project Journal', doc.getElementById('main-journal').classList.contains('active'));
  key(w, doc, '?');
  t('? opens the shortcuts list', doc.getElementById('shortcutsBg').classList.contains('open'));
  w.closeModal('shortcutsBg');
  key(w, doc, 'g');
  t('G opens the guide', doc.getElementById('guideModalBg').classList.contains('open'));
  w.closeModal('guideModalBg');

  // THE one that matters — a letter must never fire mid-note
  const box = doc.getElementById('searchBox'); box.focus();
  const wasOpen = doc.getElementById('guideModalBg').classList.contains('open');
  key(w, box, 'g');
  t('typing "g" in an input does NOT open the guide',
    doc.getElementById('guideModalBg').classList.contains('open') === wasOpen);
  const note = doc.querySelector('[contenteditable]');
  if (note) { note.focus(); key(w, note, 't');
    t('typing "t" in a note does NOT start the timer', w.eval('bell.running') === false); }
  else t('contenteditable guard (no note field rendered)', true);
  d.window.close();
}

/* ---------- 7. per-project colour -------------------------------------- */
group('per-project colour');
{
  const d = boot({}); await wait(900);
  const w = d.window, doc = w.document;
  w.eval('db = mergeDefaults(' + JSON.stringify(FIXTURE) + '); renderJournal();');

  t('picker renders 8 swatches + clear', doc.querySelectorAll('#pcolorRow .pcolor-sw').length === 9);
  w.eval("setProjColor('#16a34a')");
  t('colour saves onto the project', /#16a34a/i.test(w.eval('String(currentProject().color)')));
  t('title dot appears', doc.getElementById('projTitleDot').style.display === 'inline-block');
  w.eval('renderRecent()');
  t('recent card gets a colour stripe',
    [...doc.querySelectorAll('.recent-project')].some(e => e.style.borderLeftColor));
  w.eval("setProjColor('')");
  t('clearing removes the field entirely', w.eval('String(currentProject().color)') === 'undefined');
  w.eval("currentProject().color='javascript:alert(1)'; renderJournal();");
  t('an invalid colour value is rejected', doc.getElementById('projTitleDot').style.display === 'none');
  w.eval('delete currentProject().color;');

  // the stripe rule must come AFTER the base rule, or `border:` shorthand flattens it
  const base = html.indexOf('.recent-project{padding:9px;border:1px solid');
  const over = html.indexOf('.recent-project{border-left:7px solid transparent');
  t('the 7px stripe rule wins the cascade', base >= 0 && over > base);
  d.window.close();
}

/* ---------- 8. formatted copy ------------------------------------------ */
group('copy previews render markdown, clipboard carries both flavours');
{
  const d = boot({}); await wait(900);
  const w = d.window, doc = w.document;
  w.eval('db = mergeDefaults(' + JSON.stringify(FIXTURE) + ');');
  w.eval("currentProject().sections[0].scratch='**Confirm AR aging** with client\\n- <span style=\"color:#c00\">urgent</span>\\n- *follow up* Friday'; renderJournal();");
  w.eval('copyOpenItems()');

  const prev = doc.getElementById('copyText');
  t('preview opens', doc.getElementById('copyModalBg').classList.contains('open'));
  t('bold renders as bold, not asterisks', /<(b|strong)>/i.test(prev.innerHTML) && prev.textContent.indexOf('**') < 0);
  t('italic renders', /<(i|em)>/i.test(prev.innerHTML));
  t('red survives', /#c00|rgb\(204/i.test(prev.innerHTML));
  t('preview matches the note editor exactly',
    prev.innerHTML.indexOf(w.eval('mdToHtml(currentProject().sections[0].scratch)')) >= 0);

  const plain = w.eval('copyBuffer');
  t('plain flavour strips markdown markers', plain.indexOf('**') < 0);
  t('plain flavour keeps the words', /Confirm AR aging/.test(plain));
  t('plain flavour has no HTML tags', !/<span|<b>/i.test(plain));

  w.eval('doCopy()'); await wait(120);
  t('clipboard got text/html', !!(w.__lastClip && w.__lastClip['text/html']));
  t('clipboard got text/plain', !!(w.__lastClip && w.__lastClip['text/plain']));
  w.eval("showCopy('Month Report','plain only')");
  t('plain-only previews still work', doc.getElementById('copyText').textContent === 'plain only');
  d.window.close();
}

/* ---------- 9. scratch sheet ↔ spreadsheet ------------------------------ */
group('scratch sheet — selection, Excel copy, Excel paste');
{
  const d = boot({}); await wait(900);
  const w = d.window;
  w.scratchToggle(true);
  w.eval("_scMem={A1:'10',B1:'20',C1:'=A1+B1',A2:'1.5',B2:'2.5',C2:'=SUM(A2:B2)'}; scPersist(); scRecalc();");

  w.scSelSet(1,0,2,2);
  t('a range registers', w.eval('scSelIsRange()') === true);
  t('selected cells are highlighted', d.window.document.querySelectorAll('td.sc-sel').length === 6);
  const grid = JSON.parse(w.eval('JSON.stringify(scSelGrid())'));
  t('grid reads 2×3', grid.length === 2 && grid[0].length === 3);
  t('formulas copy as VALUES not formulas', grid[0][2] === '30' && grid[0][2].indexOf('=') < 0);
  t('SUM resolves', grid[1][2] === '4');

  // numbers must NOT carry the accounting face — "1,234,567.50" pastes as TEXT
  w.eval("_scMem.A5='1234567.5'; scRecalc();");
  t('large numbers copy WITHOUT thousands commas',
    w.eval('scValueText("A5", new Set(), new Map())') === '1234567.5');
  t('the sheet still DISPLAYS the accounting face',
    /1,234,567\.50/.test(w.eval('scDisplay("A5", new Set(), new Map()).text')));
  w.eval("_scMem.A6='not a number'; scRecalc();");
  t('text cells copy verbatim', w.eval('scValueText("A6", new Set(), new Map())') === 'not a number');
  w.eval("_scMem.A7='=1/0'; scRecalc();");
  t('error cells copy their token', /#/.test(w.eval('scValueText("A7", new Set(), new Map())')));
  w.eval("delete _scMem.A5; delete _scMem.A6; delete _scMem.A7; scRecalc();");

  w.scSelSet(1,0,2,2); w.scCopySelection(); await wait(80);
  t('clipboard got TSV', !!(w.__lastClip && w.__lastClip['text/plain']));
  t('clipboard got an HTML table', !!(w.__lastClip && w.__lastClip['text/html']));

  w.eval('_scMem={}; scRecalc();');
  t('multi-cell paste is accepted', w.eval('scPasteGrid("5\\t6\\t7\\n8\\t9\\t10","B2")') === true);
  t('paste lands at the anchor', w.eval("scRaw('B2')") === '5');
  t('paste fills across', w.eval("scRaw('D2')") === '7');
  t('paste fills down', w.eval("scRaw('B3')") === '8');
  t('paste selects what it wrote', w.eval('JSON.stringify(scSelBox())') === '{"r0":2,"r1":3,"c0":1,"c1":3}');
  t('a single value is NOT treated as a grid', w.eval('scPasteGrid("42","A1")') === false);

  w.eval('_scMem={}; scRecalc();');
  w.eval("scPasteGrid('\"a\\tb\"\\tc\\nd\\te','A1')");
  t('a quoted tab stays in one cell', w.eval("scRaw('A1')") === 'a\tb' && w.eval("scRaw('B1')") === 'c');

  w.eval('_scMem={}; scRecalc();');
  w.eval('scPasteGrid("1\\t2\\t3","G1")');
  t('paste clips at column H without wrapping',
    w.eval("scRaw('G1')") === '1' && w.eval("scRaw('H1')") === '2' && w.eval("scRaw('A2')") === '');

  t('the scratch sheet never enters db', w.eval("String(db.scratch)") === 'undefined');
  t('the scratch sheet lives in sessionStorage only', w.sessionStorage.getItem('pjt_scratch') !== null);
  d.window.close();
}

/* ---------- 10. data safety -------------------------------------------- */
group('data safety');
{
  t('import REPLACE takes a safety backup first', /mode==='replace' && FS_ENABLED\)\{ try\{ await backupNow\(\)/.test(html));
  t('a failed browser write surfaces instead of showing "Saved"', /SAVE FAILED/.test(html));
  t('exports strip team credentials', /delete c\.sync|c\.sync\s*=/.test(html));
}

/* ---------- 11. real-data corpus (the one that catches schema drift) ---- */
group('real backup corpus' + (CORPUS ? '' : ' — SKIPPED, pass a backup path to enable'));
if (CORPUS && fs.existsSync(CORPUS)) {
  const backup = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  const d = boot({}); await wait(900);
  const w = d.window;
  w.eval('db = mergeDefaults(' + JSON.stringify(backup) + ');');

  const projects = JSON.parse(w.eval('JSON.stringify(db.journal.projects)'));
  const notes = [];
  projects.forEach(p => { if (p.notes) notes.push(p.notes);
    (p.sections||[]).forEach(s => ['preparer','reviewer','scratch'].forEach(f => { if (s[f]) notes.push(s[f]); })); });
  t('corpus loaded (' + notes.length + ' note strings, ' + projects.length + ' projects)', notes.length > 0);

  let bad = 0;
  notes.forEach(n => {
    const el = w.document.createElement('div');
    el.innerHTML = w.eval('mdToHtml(' + JSON.stringify(n) + ')');
    const back = w.mdGet(el);
    const norm = x => String(x).replace(/\s+/g, ' ').trim();
    if (norm(back) !== norm(n)) bad++;
  });
  t('markdown round-trips on every real note (' + (notes.length - bad) + '/' + notes.length + ')', bad === 0);

  // independent count — deliberately computed here, not by the app
  const expect = {
    projects: projects.length,
    archived: projects.filter(p => p.archived).length,
    sections: projects.reduce((a,p) => a + (p.sections||[]).length, 0),
    notes: notes.length,
    days: Object.keys(backup.timecard ? backup.timecard.days || {} : {}).length,
    entries: Object.values(backup.timecard ? backup.timecard.days || {} : {})
               .reduce((a,dd) => a + ((dd.entries||[]).length), 0)
  };
  const packet = w.eval('aiPacketText()');
  t('packet project count matches an independent count',
    new RegExp('Projects: ' + expect.projects + ' \\(' + expect.archived + ' archived\\)').test(packet));
  t('packet section count matches (' + expect.sections + ')',
    new RegExp('sections across all projects: ' + expect.sections).test(packet));
  t('packet note count matches (' + expect.notes + ')',
    new RegExp('Non-empty note fields: ' + expect.notes).test(packet));
  t('packet day count matches (' + expect.days + ')',
    new RegExp('Days with time logged: ' + expect.days).test(packet));
  t('packet entry count matches (' + expect.entries + ')',
    new RegExp('Time entries: ' + expect.entries).test(packet));

  const names = new Set();
  projects.forEach(p => { if (p.name) names.add(p.name); if (p.clientCode) names.add(p.clientCode);
    (p.sections||[]).forEach(s => { if (s.name) names.add(s.name); }); });
  const leaked = [...names].filter(n => n && n.length > 3 && packet.indexOf(n) >= 0);
  t('packet leaks no REAL project/client/section name' + (leaked.length ? ' — LEAKED: ' + leaked.slice(0,5).join(', ') : ''),
    leaked.length === 0);
  const noteLeak = notes.filter(n => {
    const frag = String(n).replace(/[*_#`]/g, '').trim().slice(0, 25);
    return frag.length > 12 && packet.indexOf(frag) >= 0; });
  t('packet leaks no REAL note text', noteLeak.length === 0);
  d.window.close();
} else if (CORPUS) {
  console.log('  !!   corpus path given but not found: ' + CORPUS);
}

/* ---------- done -------------------------------------------------------- */
console.log('\n' + '='.repeat(64));
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
if (!CORPUS) console.log('\nNOTE: run with a real backup path to enable the corpus tests —\n  node tests/pjt.test.js /path/to/work-journal-backup-YYYY-MM-DD.json');
process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
