#!/usr/bin/env node
// Generates the two committed artifacts: crashes.json (the report a stranger
// can re-run with `cofferdam verify`) and web/data.js (the same numbers, as one
// classic script, so the report page opens from file:// with no server and no
// fetch).
//
//   node tools/build-report.mjs            regenerate both
//   node tools/build-report.mjs --targets  also re-run the three real targets
//   node tools/build-report.mjs --check    fail if the committed files are stale
//
// --check compares the DETERMINISTIC sections only. The target results and the
// generation timestamp depend on the machine, so they are reported as not
// re-run rather than silently treated as fresh. Three outcomes, here too.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeWorkload } from '../src/workload.js';
import { enumerate } from '../src/enumerate.js';
import { parseBuildFlags, correctBuild, BUGS } from '../src/bugs.js';
import { FIXTURES, CONTROL_SEEDS, MEASURED_ON, FEATURED } from '../src/fixtures.js';
import { runControl, runFixture, runBoundSweep, runSabotage } from '../src/cli.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const JSON_FILE = path.join(ROOT, 'crashes.json');
const DATA_FILE = path.join(ROOT, 'web', 'data.js');

/** Which enumerations the report page can show. The first one is the default view. */
const VIEWS = [
  { seed: FEATURED.seed, build: FEATURED.build },
  { seed: 6, build: 'checksum-skipped' },
  { seed: FEATURED.seed, build: 'no-fsync-before-ack' },
  { seed: FEATURED.seed, build: 'torn-record-accepted' },
  { seed: FEATURED.seed, build: 'correct' },
];

/** Findings carried per view, so the page stays small enough to open instantly. */
const MAX_FINDINGS = 64;

/** @param {{seed:number, build:string}} view */
function buildMatrix(view) {
  const flags = view.build === 'correct' ? correctBuild() : parseBuildFlags(view.build);
  const r = enumerate({ workload: makeWorkload(view.seed), flags });
  let carried = 0;
  return {
    seed: view.seed,
    build: view.build,
    bound: r.bound,
    opCount: r.opCount,
    mutations: r.mutations,
    crashPoints: r.crashPoints,
    schedules: r.schedules,
    consistent: r.consistent,
    corrupt: r.corrupt,
    unverifiable: r.unverifiable,
    firstFinding: r.firstFinding,
    points: r.points.map((p) => {
      const row = {
        i: p.i,
        op: p.op,
        v: p.verdict === 'consistent' ? 'c' : p.verdict === 'corrupt' ? 'x' : 'u',
        s: p.schedules,
        cs: p.corruptSchedules,
        d: p.inflightData,
        m: p.inflightMeta,
        r: p.verdict === 'consistent' ? '' : p.reason,
      };
      if (p.finding && carried < MAX_FINDINGS) { carried++; return { ...row, f: p.finding }; }
      return row;
    }),
  };
}

/** @returns {object} everything that is a pure function of the source */
function deterministicSections() {
  const control = runControl(CONTROL_SEEDS);
  return {
    measuredOn: MEASURED_ON,
    control: {
      seeds: control.seeds, crashPoints: control.crashPoints, schedules: control.schedules,
      corrupt: control.corrupt, unverifiable: control.unverifiable,
    },
    fixtures: FIXTURES.map((f) => {
      const r = runFixture(f);
      return {
        id: f.id, title: f.title, note: f.note,
        seedsTried: r.seedsTried, seedsCorrupt: r.seedsCorrupt, corruptPoints: r.corruptPoints,
        floor: r.floor, firstSeed: r.firstSeed,
      };
    }),
    sabotage: runSabotage(),
    bounds: runBoundSweep(),
    bugs: BUGS,
    views: VIEWS.map(buildMatrix),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const withTargets = argv.includes('--targets');

  const fresh = deterministicSections();

  if (check) {
    if (!fs.existsSync(JSON_FILE) || !fs.existsSync(DATA_FILE)) {
      process.stderr.write('build-report: crashes.json or web/data.js is missing. Run: node tools/build-report.mjs\n');
      return 1;
    }
    const committed = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    /** @type {string[]} */
    const stale = [];
    for (const key of Object.keys(fresh)) {
      const a = JSON.stringify(/** @type {any} */ (fresh)[key]);
      const b = JSON.stringify(committed[key]);
      if (a !== b) stale.push(key);
    }
    const expectedData = renderData(committed);
    const actualData = fs.readFileSync(DATA_FILE, 'utf8').replace(/\r\n/g, '\n');
    if (expectedData !== actualData) stale.push('web/data.js does not match crashes.json');
    if (stale.length > 0) {
      process.stderr.write('build-report: stale sections: ' + stale.join(', ') +
        '\n  regenerate with: node tools/build-report.mjs\n');
      return 1;
    }
    process.stdout.write('build-report: crashes.json and web/data.js are current' +
      (committed.targets ? '' : ' (no target results recorded)') +
      '; the target section and the timestamp were not re-run\n');
    return 0;
  }

  let targets = null;
  if (withTargets) {
    const { runAllTargets } = await import('../src/targets/run.js');
    const run = runAllTargets({ seed: 1, every: 1, tears: 3 });
    targets = { platform: run.platform, node: run.node, seed: 1, results: run.results };
  } else if (fs.existsSync(JSON_FILE)) {
    targets = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')).targets ?? null;
  }

  const report = {
    generated: new Date().toISOString().slice(0, 10),
    node: process.version,
    platform: process.platform,
    ...fresh,
    targets,
  };
  fs.writeFileSync(JSON_FILE, JSON.stringify(report, null, 1) + '\n');
  fs.writeFileSync(DATA_FILE, renderData(report));
  const size = fs.statSync(DATA_FILE).size;
  process.stdout.write(
    'build-report: crashes.json (' + fs.statSync(JSON_FILE).size + ' B) and web/data.js (' + size + ' B)\n' +
    '  control ' + report.control.crashPoints + ' crash points, ' + report.control.corrupt + ' corrupt\n' +
    '  ' + report.views.length + ' views, targets ' + (targets ? 'recorded' : 'ABSENT (run with --targets)') + '\n'
  );
  return 0;
}

/** @param {object} report @returns {string} */
function renderData(report) {
  return '// Generated by tools/build-report.mjs. Do not edit.\n' +
    '// The report page is static: no server, no fetch, no dataset. This file IS the data.\n' +
    'window.COFFERDAM = ' + JSON.stringify(report) + ';\n';
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; });
}
