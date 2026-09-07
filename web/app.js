// The report page.
//
// It renders one committed run: no server, no network, no dataset at view time.
// data.js already holds every number, so the page cannot show anything that was
// not measured and written down. The lint gate enforces that by forbidding the
// three ways this file could reach out.
//
// The seed, the build and the crash point live in the URL, which makes a
// specific corruption a link somebody can send you.

/* global window, document, history, location, navigator, URLSearchParams */

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

  /** @param {number} n @returns {string} */
  function num(n) { return Number(n).toLocaleString('en-US'); }

  /** @param {any} parent @param {string} tag @param {string|null} cls @param {string} [text] @returns {any} */
  function add(parent, tag, cls, text) {
    var n = el(tag, cls, text);
    parent.appendChild(n);
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

  // The URL carries the selection, never a fragment. Writing "#enumerator" here
  // made the browser jump past the hero on every load, which threw away the
  // headline result the page exists to lead with.
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
  // enumerator, so it does not wait behind a click.
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

  // ------------------------------------------------------------ hero: chips

  function renderProvenance() {
    var box = $('provenance');
    var c = DATA.control;
    var t = DATA.targets || {};
    var chips = [
      ['workloads', num(c.seeds) + ' seeds'],
      ['build', 'correct'],
      ['reorder bound', '4'],
      ['platform', String(t.platform || DATA.platform)],
      ['node', String(t.node || DATA.node)],
      ['measured', String(DATA.measuredOn || DATA.generated)],
      ['command', 'node src/cli.js control'],
    ];
    chips.forEach(function (/** @type {string[]} */ pair) {
      var li = add(box, 'li', 'chip');
      add(li, 'b', null, pair[0]);
      add(li, 'span', null, pair[1]);
    });
  }

  // The negative control drawn as a field: one cell per workload, so the empty
  // half of the hero says the headline a second way with the project's own
  // data. It is only drawn when the data can actually support every cell:
  // `corrupt` counts crash points rather than workloads, so a non-zero count
  // cannot be attributed to particular cells, and a field that guessed would be
  // decoration pretending to be evidence.
  function renderField() {
    var c = DATA.control;
    var grid = $('field');
    var fig = grid.parentNode;
    if (c.corrupt !== 0 || c.unverifiable !== 0) {
      fig.style.display = 'none';
      return;
    }
    for (var i = 0; i < c.seeds; i++) add(grid, 'div', 'field__cell');
    var cap = $('field-cap');
    add(cap, 'b', null, num(c.seeds) + ' workloads');
    add(cap, 'span', null, ', one cell each — ' + num(c.crashPoints) + ' crash points and ' +
      num(c.schedules) + ' schedules between them. No cell is corrupt.');
  }

  function renderControl() {
    var c = DATA.control;
    var box = $('control');
    var rows = [
      [num(c.seeds), 'workloads of the correct build', false],
      [num(c.crashPoints), 'crash points enumerated', false],
      [num(c.schedules), 'crash schedules run', false],
      [num(c.corrupt), 'corrupt', c.corrupt === 0],
      [num(c.unverifiable), 'unverifiable', c.unverifiable === 0],
    ];
    rows.forEach(function (/** @type {any[]} */ row) {
      var d = add(box, 'div', 'readout');
      add(d, 'b', 'readout__n' + (row[2] ? ' is-ok' : ''), row[0]);
      add(d, 'span', 'readout__l', row[1]);
    });
  }

  // -------------------------------------------------------------- fixtures

  /** @param {any} card @param {any} f */
  function detectionBar(card, f) {
    var det = add(card, 'div', 'det');
    var row = add(det, 'div', 'det__row');
    add(row, 'span', 'det__n', f.seedsCorrupt + ' / ' + f.seedsTried);
    add(row, 'span', 'det__of', 'seeds reproduce it');
    add(row, 'span', 'det__pts', num(f.corruptPoints) + ' corrupt crash points');

    var track = add(det, 'div', 'track');
    var fill = add(track, 'i', null);
    fill.style.width = (100 * f.seedsCorrupt / f.seedsTried).toFixed(1) + '%';
    var tick = add(track, 'u', null);
    tick.style.left = (100 * f.floor / f.seedsTried).toFixed(1) + '%';

    add(det, 'div', 'det__floor',
      'floor ' + f.floor + '/' + f.seedsTried + '  ·  first reproducing seed ' + f.firstSeed);
  }

  function renderFixtures() {
    var box = $('fixture-cards');
    box.textContent = '';

    DATA.fixtures.forEach(function (/** @type {any} */ f) {
      /** @type {any} */
      var bug = null;
      DATA.bugs.forEach(function (/** @type {any} */ b) { if (b.id === f.id) bug = b; });

      var card = add(box, 'article', 'fx');
      var top = add(card, 'div', 'fx__top');
      add(top, 'span', 'fx__id', f.id);
      add(top, 'span', 'fx__breaks', 'breaks ' + (bug ? bug.breaks : 'store'));
      add(card, 'p', 'fx__title', f.title);
      detectionBar(card, f);

      var det = add(card, 'details', 'more');
      add(det, 'summary', null, 'The mechanism');
      var body = add(det, 'div', 'more__body');
      if (bug) add(body, 'p', null, bug.detail);
      add(body, 'p', null, f.note);
    });

    // The fifth fixture breaks the CHECKER. It gets its own full-width card,
    // because "the corrupt verdict is produced by the check and not by the
    // weather" is a different claim from the four above it.
    var s = DATA.sabotage;
    /** @type {any} */
    var checkerBug = null;
    DATA.bugs.forEach(function (/** @type {any} */ b) { if (b.breaks === 'checker') checkerBug = b; });

    var card2 = add(box, 'article', 'fx fx--checker');
    var top2 = add(card2, 'div', 'fx__top');
    add(top2, 'span', 'fx__id', checkerBug ? checkerBug.id : 'checker-accept-corrupt');
    add(top2, 'span', 'fx__breaks', 'breaks the checker');
    add(card2, 'p', 'fx__title',
      'The same enumeration over the same broken store, with the validator sabotaged to forgive a lost ' +
      'acknowledged write.');

    var sab = add(card2, 'div', 'sabotage');
    var pair = add(sab, 'div', 'sabotage__pair');
    add(pair, 'span', 'sabotage__n is-live', String(s.honest));
    add(pair, 'span', 'sabotage__arrow', '→');
    add(pair, 'span', 'sabotage__n is-dead', String(s.sabotaged));
    add(sab, 'span', 'sabotage__l', 'corrupt points found: honest → sabotaged');

    var pair2 = add(sab, 'div', 'sabotage__pair');
    add(pair2, 'span', 'sabotage__n is-live', String(s.targetedHonest));
    add(pair2, 'span', 'sabotage__arrow', '→');
    add(pair2, 'span', 'sabotage__n is-live', String(s.targetedSabotaged));
    add(sab, 'span', 'sabotage__l', 'targeted, not a blanket pass: an invented value is still caught');

    var det2 = add(card2, 'details', 'more');
    add(det2, 'summary', null, 'Why a checker needs its own failure path exercised');
    var body2 = add(det2, 'div', 'more__body');
    if (checkerBug) add(body2, 'p', null, checkerBug.detail);
    add(body2, 'p', null,
      'A checker whose failure path has never been exercised is decoration. With the flag on, the same ' +
      'enumeration reports ' + s.sabotaged + ' corruptions instead of ' + s.honest + ' — so the ' +
      DATA.control.corrupt + ' at the top of this page is a measurement, not a stuck needle.');
  }

  // ------------------------------------------------------------ enumerator

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
      var r = el('tr');
      r.appendChild(el('td', 'k', row.key));
      r.appendChild(el('td', null, row.value));
      node.appendChild(r);
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
      if (d.kind === 'missing') cell.textContent = d.expected + ' - gone';
      else if (d.kind === 'extra') cell.textContent = d.got + ' - should not exist';
      else {
        cell.appendChild(el('span', null, d.expected));
        cell.appendChild(el('span', 'arrow', '  →  '));
        cell.appendChild(el('span', null, d.got));
      }
      row.appendChild(cell);
      node.appendChild(row);
    });
  }

  // The per-view statistics were previously one sentence of prose under the
  // matrix. They are the shape of the run, so they get read as numbers.
  function renderViewStats() {
    var v = state.view;
    var box = $('viewstats');
    box.textContent = '';
    var rows = [
      [num(v.mutations), 'mutations', ''],
      [num(v.opCount), 'i/o operations', ''],
      [num(v.crashPoints), 'crash points', ''],
      [num(v.schedules), 'schedules', ''],
      [num(v.consistent), 'consistent', 'is-ok'],
      [num(v.corrupt), 'corrupt', v.corrupt > 0 ? 'is-bad' : ''],
      [num(v.unverifiable), 'unverifiable', v.unverifiable > 0 ? 'is-warn' : ''],
    ];
    rows.forEach(function (/** @type {string[]} */ row) {
      var d = add(box, 'div', null);
      add(d, 'b', row[2] || null, row[0]);
      add(d, 'span', null, row[1]);
    });
  }

  function renderVerdict() {
    var view = state.view;
    var p = view.points[state.point];
    var box = $('verdict');
    box.className = 'verdict ' + VERDICT_CLASS[p.v];
    $('verdict-word').textContent = VERDICT_WORD[p.v];

    var where = $('verdict-where');
    where.textContent = '';
    /** @param {string} k @param {string} val */
    function fact(k, val) {
      var s = add(where, 'span', null, k + ' ');
      add(s, 'b', null, val);
    }
    fact('crash point', p.i + ' of ' + (view.points.length - 1));
    fact('interrupting', p.op);
    fact('schedules here', String(p.s));
    fact('writes in flight', String(p.d));

    var f = p.f;
    var why = $('verdict-why');
    if (p.v === 'x' && f) {
      why.textContent = f.reason + ' ' + f.recoveryNote;
      $('expected-title').textContent =
        'Expected (after ' + f.nearestPrefix + ' mutations; ' + f.acked + ' acknowledged)';
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
      b.style.setProperty('--i', String(p.i));
      b.setAttribute('aria-label',
        'crash point ' + p.i + ': ' + VERDICT_WORD[p.v].toLowerCase() + ', interrupting ' + p.op);
      b.setAttribute('aria-pressed', p.i === state.point ? 'true' : 'false');
      b.title = 'crash point ' + p.i + ' - ' + VERDICT_WORD[p.v].toLowerCase() + '\n' + p.op;
      b.addEventListener('click', function () { select(p.i); });
      b.addEventListener('keydown', function (/** @type {any} */ ev) {
        var k = ev.key;
        var to = -1;
        if (k === 'ArrowRight' || k === 'ArrowDown') to = clampPoint(view, p.i + 1);
        else if (k === 'ArrowLeft' || k === 'ArrowUp') to = clampPoint(view, p.i - 1);
        else if (k === 'Home') to = 0;
        else if (k === 'End') to = view.points.length - 1;
        if (to < 0) return;
        ev.preventDefault();
        select(to);
        var next = grid.children[to];
        if (next) next.focus();
      });
      grid.appendChild(b);
    });
  }

  function renderViewPicker() {
    var sel = $('view');
    sel.textContent = '';
    DATA.views.forEach(function (/** @type {any} */ v) {
      var label = v.build === 'correct'
        ? 'seed ' + v.seed + '  ·  correct build  ·  no findings'
        : 'seed ' + v.seed + '  ·  ' + v.build + '  ·  ' + v.corrupt + ' corrupt / ' + v.crashPoints;
      var o = el('option', null, label);
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
    $('copy-replay').addEventListener('click', function () {
      var btn = $('copy-replay');
      var text = $('replay').textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = 'Copied';
          window.setTimeout(function () { btn.textContent = 'Copy'; }, 1400);
        });
      }
    });
  }

  // ----------------------------------------------------------------- bound

  function renderBounds() {
    var box = $('bounds');
    box.textContent = '';
    var max = 0;
    DATA.bounds.forEach(function (/** @type {any} */ b) {
      var total = b.consistent + b.corrupt + b.unverifiable;
      if (total > max) max = total;
    });
    DATA.bounds.forEach(function (/** @type {any} */ b) {
      var total = b.consistent + b.corrupt + b.unverifiable;
      var row = add(box, 'div', 'bound-row');
      var k = add(row, 'div', 'bound-row__k');
      add(k, 'span', null, 'bound ');
      add(k, 'b', null, String(b.bound));
      var stack = add(row, 'div', 'stack');
      stack.style.width = (100 * total / max).toFixed(1) + '%';
      // A label only goes inside a segment wide enough to hold it; a clipped
      // half-word is worse than no word. Narrow segments get an outside label.
      var cPct = 100 * b.consistent / total;
      var c = add(stack, 'i', 'seg-c');
      c.style.width = cPct.toFixed(2) + '%';
      c.title = num(b.consistent) + ' proven consistent';
      if (cPct >= 14) add(c, 'em', null, num(b.consistent) + ' proven');
      if (b.unverifiable > 0) {
        var uPct = 100 * b.unverifiable / total;
        var u = add(stack, 'i', 'seg-u');
        u.style.width = uPct.toFixed(2) + '%';
        u.title = num(b.unverifiable) + ' unverifiable';
        if (uPct >= 14) add(u, 'em', null, num(b.unverifiable) + ' unverifiable');
      }
      if (b.unverifiable > 0 && (100 * b.unverifiable / total) < 14) {
        add(row, 'span', 'bound-row__tail', num(b.unverifiable) + ' unverifiable');
      }
    });
    var first = DATA.bounds[0];
    var settled = null;
    DATA.bounds.forEach(function (/** @type {any} */ b) {
      if (settled === null && b.unverifiable === 0) settled = b.bound;
    });
    $('bounds-note').textContent =
      'Over 30 seeds of the correct build. By bound ' + settled + ' nothing is left unverifiable, and ' +
      'raising it further changes nothing — that flat tail is why the default bound of 4 enumerates ' +
      'the whole space rather than a slice.';
  }

  // --------------------------------------------------------------- targets

  function renderTargets() {
    var box = $('target-cards');
    box.textContent = '';
    if (!DATA.targets || !DATA.targets.results) {
      $('targets-note').textContent =
        'No target results are recorded in this report. Run: node src/cli.js targets';
      return;
    }
    DATA.targets.results.forEach(function (/** @type {any} */ r) {
      var card = add(box, 'article', 'tg');
      var top = add(card, 'div', 'tg__top');
      add(top, 'span', 'tg__id', r.id);
      var cls = r.verdict === 'consistent' ? 'ok' : r.verdict === 'corrupt' ? 'no' : 'maybe';
      add(top, 'span', 'tg__verdict ' + cls, r.verdict);
      add(card, 'h3', 'tg__title', r.title);

      var nums = add(card, 'div', 'tg__nums');
      /** @param {string} v @param {string} l @param {boolean} ok */
      function stat(v, l, ok) {
        var d = add(nums, 'div', 'tg__num');
        add(d, 'b', ok ? 'is-ok' : null, v);
        add(d, 'span', null, l);
      }
      stat(num(r.checked), 'crash points checked', false);
      stat(num(r.corrupt), 'corruptions', r.corrupt === 0);
      if (r.killPhase) stat(num(r.killPhase.checked), 'real SIGKILLs', false);
      if (r.imagePhase) stat(num(r.imagePhase.mismatches), 'model vs disk mismatches', r.imagePhase.mismatches === 0);

      add(card, 'p', 'tg__detail', r.detail);

      // The false-positive removal is a result about the harness's own honesty,
      // so it stays on the card. The rest are caveats: real, and not worth the
      // reader's first pass.
      var mark = 'FALSE POSITIVE REMOVED:';
      /** @type {string[]} */
      var caveats = [];
      r.notes.forEach(function (/** @type {string} */ n) {
        if (n.indexOf(mark) === 0) {
          var p = add(card, 'p', 'tg__note');
          add(p, 'strong', null, 'False positive removed.');
          add(p, 'span', null, ' ' + n.slice(mark.length).trim());
        } else {
          caveats.push(n);
        }
      });
      if (caveats.length > 0) {
        var d = add(card, 'details', 'more');
        add(d, 'summary', null, caveats.length === 1 ? 'One caveat' : caveats.length + ' caveats');
        var body = add(d, 'div', 'more__body');
        caveats.forEach(function (/** @type {string} */ n) { add(body, 'p', null, n); });
      }
    });
    $('targets-note').textContent =
      'The model is only worth trusting if it agrees with a real disk. A SIGKILL cannot lose the page ' +
      'cache, so a missing fsync is invisible to it and obvious to the enumerator — which is the whole ' +
      'argument for modelling the device. Measured on ' + DATA.targets.platform + ', Node ' +
      DATA.targets.node + ', seed ' + DATA.targets.seed + '.';
  }

  // ------------------------------------------------------------------- run

  function renderAll() {
    renderViewStats();
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

  // A shared deep link should land on the crash point it names; a bare visit
  // should land on the result.
  var arrivedDeep = new URLSearchParams(location.search).has('point');

  readUrl();
  renderProvenance();
  renderField();
  renderControl();
  renderViewPicker();
  renderFixtures();
  renderBounds();
  renderTargets();
  renderAll();
  writeUrl(true);
  if (arrivedDeep) $('enumerator').scrollIntoView();
  $('generated').textContent = ' Generated ' + DATA.generated + ' on ' + DATA.platform +
    ', Node ' + DATA.node + '.';
  window.addEventListener('popstate', function () { readUrl(); renderAll(); });
})();
