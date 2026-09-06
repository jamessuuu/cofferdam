// The report page.
//
// It renders one committed run: no server, no fetch, no dataset, no build step
// at view time. data.js already holds every number, so the page cannot show
// anything that was not measured and written down.
//
// The seed, the build and the crash point live in the URL, which makes a
// specific corruption a link somebody can send you.

/* global window, document, history, location, URLSearchParams */

(function () {
  'use strict';

  /** The whole committed report, injected by data.js. @type {any} */
  var DATA = /** @type {any} */ (window).COFFERDAM;
  if (!DATA || !DATA.views || DATA.views.length === 0) {
    document.body.textContent = 'data.js is missing or empty. Regenerate it: node tools/build-report.mjs';
    return;
  }

  var VERDICT_WORD = { c: 'CONSISTENT', x: 'CORRUPT', u: 'UNVERIFIABLE' };
  var VERDICT_CLASS = { c: 'v-consistent', x: 'v-corrupt', u: 'v-unverifiable' };

  /** @type {{view: any, point: number}} */
  var state = { view: DATA.views[0], point: 0 };

  // Every id here is in index.html and the lint gate keeps the two together, so
  // the null branch would be dead code that only exists to satisfy a checker.
  /** @param {string} id @returns {any} */
  function $(id) { return document.getElementById(id); }

  /** @param {string} tag @param {string|null} [className] @param {string} [text] @returns {any} */
  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  /** @param {string|null} seed @param {string|null} build @returns {any} */
  function findView(seed, build) {
    for (var i = 0; i < DATA.views.length; i++) {
      var v = DATA.views[i];
      if (String(v.seed) === String(seed) && v.build === build) return v;
    }
    return null;
  }

  function readUrl() {
    var q = new URLSearchParams(location.search);
    var v = findView(q.get('seed'), q.get('build'));
    if (v) state.view = v;
    var p = parseInt(q.get('point') || '', 10);
    state.point = isNaN(p) ? firstInteresting(state.view) : clampPoint(state.view, p);
  }

  /** @param {boolean} replace */
  function writeUrl(replace) {
    var q = new URLSearchParams();
    q.set('seed', String(state.view.seed));
    q.set('build', state.view.build);
    q.set('point', String(state.point));
    var url = location.pathname + '?' + q.toString();
    if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  }

  /** @param {any} view @param {number} p @returns {number} */
  function clampPoint(view, p) {
    if (p < 0) return 0;
    if (p >= view.points.length) return view.points.length - 1;
    return p;
  }

  // Open on the first crash point that FAILED. The failure is the point of the
  // page, so it does not wait behind a click.
  /** @param {any} view @returns {number} */
  function firstInteresting(view) {
    for (var i = 0; i < view.points.length; i++) if (view.points[i].v === 'x') return i;
    for (var j = 0; j < view.points.length; j++) if (view.points[j].v === 'u') return j;
    return 0;
  }

  /** @param {any} view @param {number} from @param {string} kind @returns {number} */
  function nextOfKind(view, from, kind) {
    for (var i = 1; i <= view.points.length; i++) {
      var at = (from + i) % view.points.length;
      if (view.points[at].v === kind) return at;
    }
    return from;
  }

  // ---------------------------------------------------------------- rendering

  /** @param {any} node @param {any[]|null} rows */
  function renderStateTable(node, rows) {
    node.textContent = '';
    if (!rows || rows.length === 0) {
      var tr = el('tr');
      tr.appendChild(el('td', 'muted', '(empty)'));
      node.appendChild(tr);
      return;
    }
    rows.forEach(function (/** @type {any} */ row) {
      var tr = el('tr');
      tr.appendChild(el('td', 'k', row.key));
      tr.appendChild(el('td', null, row.value));
      node.appendChild(tr);
    });
  }

  /** @param {any} node @param {any[]|null} diff */
  function renderDiff(node, diff) {
    node.textContent = '';
    if (!diff || diff.length === 0) {
      var tr = el('tr');
      tr.appendChild(el('td', 'muted', '(no difference)'));
      node.appendChild(tr);
      return;
    }
    diff.forEach(function (/** @type {any} */ d) {
      var row = el('tr');
      row.appendChild(el('td', 'k d-' + d.kind, d.key));
      var cell = el('td', 'd-' + d.kind);
      if (d.kind === 'missing') cell.textContent = d.expected + ' — gone';
      else if (d.kind === 'extra') cell.textContent = d.got + ' — should not exist';
      else {
        cell.appendChild(el('span', null, d.expected));
        cell.appendChild(el('span', 'arrow', '  →  '));
        cell.appendChild(el('span', null, d.got));
      }
      row.appendChild(cell);
      node.appendChild(row);
    });
  }

  function renderVerdict() {
    var view = state.view;
    var p = view.points[state.point];
    var box = $('verdict');
    box.className = 'verdict ' + VERDICT_CLASS[p.v];
    $('verdict-word').textContent = VERDICT_WORD[p.v];
    $('verdict-where').textContent =
      'crash point ' + p.i + ' of ' + (view.points.length - 1) +
      '  ·  interrupting: ' + p.op +
      '  ·  ' + p.s + ' crash schedule' + (p.s === 1 ? '' : 's') + ' at this point' +
      '  ·  ' + p.d + ' write' + (p.d === 1 ? '' : 's') + ' in flight';

    var f = p.f;
    var why = $('verdict-why');
    if (p.v === 'x' && f) {
      why.textContent = f.reason + ' ' + f.recoveryNote;
      $('expected-title').textContent = 'Expected (state after ' + f.nearestPrefix + ' mutations; ' +
        f.acked + ' acknowledged)';
      renderStateTable($('expected'), f.expected);
      renderStateTable($('recovered'), f.got);
      renderDiff($('diff'), f.diff);
      $('replay').textContent = 'node src/cli.js replay --seed ' + view.seed +
        ' --build ' + view.build + ' --point ' + p.i + ' --schedule ' + f.schedule;
    } else {
      why.textContent = p.v === 'c'
        ? 'Every schedule at this crash point recovered to a state the API could have produced.'
        : (p.r || '');
      if (p.v === 'x') {
        why.textContent = p.r + '  (this crash point’s full diff is not carried in the report; ' +
          'the replay command below reproduces it.)';
      }
      $('expected-title').textContent = 'Expected';
      renderStateTable($('expected'), null);
      renderStateTable($('recovered'), null);
      renderDiff($('diff'), null);
      $('replay').textContent = 'node src/cli.js replay --seed ' + view.seed +
        ' --build ' + view.build + ' --point ' + p.i;
    }
  }

  function renderMatrix() {
    var view = state.view;
    var grid = $('matrix');
    grid.textContent = '';
    view.points.forEach(function (/** @type {any} */ p) {
      var b = el('button', 'cell ' + p.v + (p.i === state.point ? ' sel' : ''));
      b.type = 'button';
      b.setAttribute('aria-label', 'crash point ' + p.i + ': ' + VERDICT_WORD[p.v].toLowerCase() + ', ' + p.op);
      b.title = 'crash point ' + p.i + ' — ' + VERDICT_WORD[p.v].toLowerCase() + '\n' + p.op;
      b.addEventListener('click', function () { select(p.i); });
      grid.appendChild(b);
    });
    $('matrix-summary').textContent = view.crashPoints + ' crash points, ' + view.schedules +
      ' crash schedules, ' + view.corrupt + ' corrupt, ' + view.unverifiable + ' unverifiable';
    $('matrix-note').textContent =
      'seed ' + view.seed + ', build ' + view.build + ', reorder bound ' + view.bound + ': ' +
      view.mutations + ' mutations produced ' + view.opCount + ' I/O operations, and every boundary ' +
      'between two of them is a place the machine can lose power. Click a cell.';
  }

  function renderViewPicker() {
    var sel = $('view');
    sel.textContent = '';
    DATA.views.forEach(function (/** @type {any} */ v) {
      var o = el('option', null, 'seed ' + v.seed + '  ·  ' + v.build +
        '  ·  ' + v.corrupt + ' corrupt / ' + v.crashPoints);
      o.value = v.seed + '|' + v.build;
      sel.appendChild(o);
    });
    sel.value = state.view.seed + '|' + state.view.build;
    sel.addEventListener('change', function () {
      var parts = sel.value.split('|');
      var v = findView(parts[0], parts[1]);
      if (!v) return;
      state.view = v;
      state.point = firstInteresting(v);
      writeUrl(false);
      renderAll();
    });
    $('next-corrupt').addEventListener('click', function () {
      var kind = state.view.corrupt > 0 ? 'x' : (state.view.unverifiable > 0 ? 'u' : 'c');
      select(nextOfKind(state.view, state.point, kind));
    });
  }

  function renderControl() {
    var c = DATA.control;
    var box = $('control');
    box.textContent = '';
    [
      [String(c.seeds), 'workloads, correct build'],
      [String(c.crashPoints), 'crash points enumerated'],
      [String(c.schedules), 'crash schedules run'],
      [String(c.corrupt), 'corrupt'],
      [String(c.unverifiable), 'unverifiable'],
    ].forEach(function (/** @type {string[]} */ pair) {
      var s = el('div', 'stat');
      s.appendChild(el('span', 'n' + (pair[1] === 'corrupt' && c.corrupt === 0 ? ' ok' : ''), pair[0]));
      s.appendChild(el('span', 'l', pair[1]));
      box.appendChild(s);
    });
  }

  /** @param {any} table @param {string[]} cells */
  function headerRow(table, cells) {
    var tr = el('tr');
    cells.forEach(function (/** @type {string} */ c) { tr.appendChild(el('th', null, c)); });
    table.appendChild(tr);
  }

  function renderFixtures() {
    var t = $('fixtures');
    t.textContent = '';
    headerRow(t, ['fixture', 'breaks', 'seeds that fail', 'corrupt crash points', 'what goes wrong']);
    DATA.fixtures.forEach(function (/** @type {any} */ f) {
      /** @type {any} */
      var bug = null;
      DATA.bugs.forEach(function (/** @type {any} */ b) { if (b.id === f.id) bug = b; });
      var tr = el('tr');
      tr.appendChild(el('td', 'num', f.id));
      tr.appendChild(el('td', null, bug ? bug.breaks : 'store'));
      tr.appendChild(el('td', 'num' + (f.seedsCorrupt >= f.floor ? ' ok' : ' no'),
        f.seedsCorrupt + ' / ' + f.seedsTried));
      tr.appendChild(el('td', 'num', String(f.corruptPoints)));
      tr.appendChild(el('td', null, f.note));
      t.appendChild(tr);
    });
    var s = DATA.sabotage;
    var sabotageRow = el('tr');
    sabotageRow.appendChild(el('td', 'num', 'checker-accept-corrupt'));
    sabotageRow.appendChild(el('td', null, 'checker'));
    sabotageRow.appendChild(el('td', 'num ok', s.sabotaged === 0 ? 'fires' : 'DEAD'));
    sabotageRow.appendChild(el('td', 'num', s.honest + ' → ' + s.sabotaged));
    sabotageRow.appendChild(el('td', null,
      'The fifth fixture breaks the CHECKER instead of the store. With it on, the same enumeration ' +
      'over the same genuinely broken store reports ' + s.sabotaged + ' corrupt crash points instead of ' +
      s.honest + '. A checker whose failure path has never been exercised is decoration.'));
    t.appendChild(sabotageRow);
    $('sabotage-note').textContent =
      'And the sabotage is targeted rather than a blanket pass: it forgives a lost acknowledged write ' +
      'and nothing else, so an invented value is still caught (' + s.targetedHonest + ' → ' +
      s.targetedSabotaged + ' corrupt crash points).';
  }

  function renderBounds() {
    var t = $('bounds');
    t.textContent = '';
    headerRow(t, ['reorder bound', 'consistent', 'corrupt', 'unverifiable']);
    DATA.bounds.forEach(function (/** @type {any} */ b) {
      var tr = el('tr');
      tr.appendChild(el('td', 'num', String(b.bound)));
      tr.appendChild(el('td', 'num', String(b.consistent)));
      tr.appendChild(el('td', 'num' + (b.corrupt === 0 ? ' ok' : ' no'), String(b.corrupt)));
      tr.appendChild(el('td', 'num' + (b.unverifiable > 0 ? ' maybe' : ''), String(b.unverifiable)));
      t.appendChild(tr);
    });
  }

  function renderTargets() {
    var t = $('targets');
    t.textContent = '';
    if (!DATA.targets || !DATA.targets.results) {
      $('targets-note').textContent =
        'No target results are recorded in this report. Run: node src/cli.js targets';
      return;
    }
    headerRow(t, ['target', 'verdict', 'crash points', 'what happened']);
    DATA.targets.results.forEach(function (/** @type {any} */ r) {
      var tr = el('tr');
      tr.appendChild(el('td', 'num', r.id));
      var cls = r.verdict === 'consistent' ? 'ok' : r.verdict === 'corrupt' ? 'no' : 'maybe';
      tr.appendChild(el('td', 'num ' + cls, r.verdict));
      tr.appendChild(el('td', 'num', String(r.checked)));
      var last = el('td');
      last.appendChild(el('div', null, r.title + ' — ' + r.detail));
      r.notes.forEach(function (/** @type {string} */ n) { last.appendChild(el('div', 'muted', n)); });
      tr.appendChild(last);
      t.appendChild(tr);
    });
    $('targets-note').textContent =
      'Measured on ' + DATA.targets.platform + ', Node ' + DATA.targets.node + ', seed ' +
      DATA.targets.seed + '. The one thing a process kill cannot do is lose the operating ' +
      'system’s page cache, so a missing fsync is invisible to T1 and obvious to the ' +
      'enumerator. That gap is the argument for modelling the device at all.';
  }

  function renderAll() {
    renderVerdict();
    renderMatrix();
    $('view').value = state.view.seed + '|' + state.view.build;
  }

  /** @param {number} i */
  function select(i) {
    state.point = clampPoint(state.view, i);
    writeUrl(false);
    renderAll();
  }

  readUrl();
  renderViewPicker();
  renderControl();
  renderFixtures();
  renderBounds();
  renderTargets();
  renderAll();
  writeUrl(true);
  $('generated').textContent = 'Generated ' + DATA.generated + ' on ' + DATA.platform +
    ', Node ' + DATA.node + '.';
  window.addEventListener('popstate', function () { readUrl(); renderAll(); });
})();
