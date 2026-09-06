#!/usr/bin/env node
// cofferdam command line.
//
// Every command exits non-zero on failure and prints a stated error rather than
// a stack trace. That is release-standard row R6, and it is the row a technical
// visitor discovers fastest -- usually by pointing the tool at the wrong file.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { BUGS, parseBuildFlags, formatBuildFlags, correctBuild } from './bugs.js';
import { makeWorkload } from './workload.js';
import { enumerate, replayOne, DEFAULT_BOUND } from './enumerate.js';
import { renderMatrix, renderFinding, renderSummary, renderTargets } from './report.js';
import { FIXTURES, CONTROL_SEEDS, MEASURED_ON, BOUND_SWEEP, BOUND_SEEDS, FEATURED } from './fixtures.js';
import { summarizeValue } from './workload.js';

/** Thrown for every condition a user can cause; never surfaces a stack trace. */
export class UserError extends Error {}

/** @type {(s: string) => void} */
let print = (s) => { process.stdout.write(s + '\n'); };

const USAGE = `cofferdam -- exhaustive crash-point enumeration for a write-ahead-logged store

  cofferdam demo                   one corrupt recovery, explained
  cofferdam enumerate [options]    visit every crash point of one workload
  cofferdam replay [options]       replay one crash point under one schedule
  cofferdam fixtures               the planted fixtures and the negative control
  cofferdam control [options]      the negative control on its own
  cofferdam targets [options]      the three real targets (spawns real processes)
  cofferdam bugs                   list the planted fixtures
  cofferdam verify <crashes.json>  re-run a committed report and compare

enumerate / replay options
  --seed <int>       which workload, default ${FEATURED.seed}
  --build <flags>    comma separated, see \`cofferdam bugs\`; default: correct
  --bound <int>      enumerate every subset of at most this many in-flight
                     writes; above it the space is sampled and the crash point
                     is reported unverifiable. Default ${DEFAULT_BOUND}
  --point <int>      replay only: which crash point
  --schedule <id>    replay only: which schedule, e.g. M0/D12/T12@1
  --json             machine-readable output

control / targets options
  --seeds <int>      control: how many seeds, default ${CONTROL_SEEDS}
  --seed <int>       targets: which workload, default 1
  --every <int>      targets: sample every Nth op boundary, default 1

exit codes
  0  ran, and the outcome was the expected one
  1  a bad argument, an unreadable or malformed input, or an unexpected outcome
`;

/**
 * @param {string[]} argv
 * @returns {{_: string[], [k: string]: any}}
 */
export function parseArgs(argv) {
  /** @type {any} */
  const out = { _: [] };
  const wantsValue = new Set(['seed', 'seeds', 'build', 'bound', 'point', 'schedule', 'every', 'tears']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const name = a.slice(2);
    if (name === 'json' || name === 'help' || name === 'targets') { out[name] = true; continue; }
    if (!wantsValue.has(name)) throw new UserError('unknown option "' + a + '"\n\n' + USAGE);
    const value = argv[++i];
    if (value === undefined) throw new UserError('option "' + a + '" needs a value');
    out[name] = value;
  }
  return out;
}

/**
 * @param {any} args
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function intOpt(args, name, fallback) {
  if (args[name] === undefined) return fallback;
  const raw = String(args[name]);
  if (!/^-?\d+$/.test(raw)) throw new UserError('--' + name + ' must be an integer, got "' + raw + '"');
  return Number(raw);
}

/** @param {any} args @returns {import('./bugs.js').BuildFlags} */
function buildOpt(args) {
  try {
    return parseBuildFlags(args.build === undefined ? undefined : String(args.build));
  } catch (err) {
    throw new UserError(/** @type {Error} */ (err).message);
  }
}

/** @param {any} args @returns {number} */
function boundOpt(args) {
  const bound = intOpt(args, 'bound', DEFAULT_BOUND);
  if (bound < 0) throw new UserError('--bound must be zero or more, got ' + bound);
  if (bound > 16) {
    throw new UserError(
      '--bound ' + bound + ' would enumerate 2^' + bound + ' schedules per crash point. The ' +
      'ceiling is 16; above that the run does not finish and pretending otherwise would waste ' +
      'your afternoon.'
    );
  }
  return bound;
}

/** @param {any} args @returns {number} */
function seedOpt(args, fallback = FEATURED.seed) {
  const seed = intOpt(args, 'seed', fallback);
  if (!Number.isSafeInteger(seed)) throw new UserError('--seed must be a safe integer, got ' + seed);
  return seed;
}

const MAX_REPORT_BYTES = 8 * 1024 * 1024;

/**
 * Read a committed crash report. Every way this can go wrong is a stated error.
 * @param {string} file
 * @returns {any}
 */
export function readReportFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e.code === 'ENOENT') throw new UserError('no such file: ' + file);
    if (e.code === 'EACCES' || e.code === 'EPERM') throw new UserError('cannot read (permission denied): ' + file);
    throw new UserError('cannot read ' + file + ': ' + e.message);
  }
  if (stat.isDirectory()) throw new UserError(file + ' is a directory, not a crash report');
  if (!stat.isFile()) throw new UserError(file + ' is not a regular file');
  if (stat.size === 0) throw new UserError(file + ' is empty; a crash report is a JSON object');
  if (stat.size > MAX_REPORT_BYTES) {
    throw new UserError(
      file + ' is ' + stat.size + ' bytes; the limit is ' + MAX_REPORT_BYTES + ' bytes (8 MiB). ' +
      'cofferdam parses the whole report into memory and a file this large is not one.'
    );
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new UserError('cannot read ' + file + ': ' + /** @type {Error} */ (err).message);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UserError(file + ' is not valid JSON: ' + /** @type {Error} */ (err).message);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UserError(file + ' is valid JSON but not a crash report: expected an object, got ' +
      (Array.isArray(parsed) ? 'an array' : typeof parsed));
  }
  if (!parsed.control || !Array.isArray(parsed.fixtures)) {
    throw new UserError(file + ' is not a cofferdam crash report: it has no "control" object and ' +
      '"fixtures" array. Generate one with: node tools/build-report.mjs');
  }
  return parsed;
}

// --------------------------------------------------------------------------
// the negative control and the fixture sweep, shared by several commands

/**
 * @param {number} seeds
 * @returns {{seeds:number, crashPoints:number, schedules:number, corrupt:number, unverifiable:number, ms:number}}
 */
export function runControl(seeds) {
  const started = process.hrtime.bigint();
  let crashPoints = 0, schedules = 0, corrupt = 0, unverifiable = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const r = enumerate({ workload: makeWorkload(seed), flags: correctBuild() });
    crashPoints += r.crashPoints;
    schedules += r.schedules;
    corrupt += r.corrupt;
    unverifiable += r.unverifiable;
  }
  return {
    seeds, crashPoints, schedules, corrupt, unverifiable,
    ms: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

/**
 * @param {import('./fixtures.js').Fixture} fixture
 * @returns {{id:string, seedsCorrupt:number, seedsTried:number, corruptPoints:number,
 *   floor:number, measured:number, ok:boolean, firstSeed:number|null}}
 */
export function runFixture(fixture) {
  const flags = parseBuildFlags(fixture.id);
  let seedsCorrupt = 0, corruptPoints = 0;
  /** @type {number|null} */
  let firstSeed = null;
  for (const seed of fixture.seeds) {
    const r = enumerate({ workload: makeWorkload(seed), flags, stopAtFirstCorruptSchedule: true });
    if (r.corrupt > 0) {
      seedsCorrupt++;
      corruptPoints += r.corrupt;
      if (firstSeed === null) firstSeed = seed;
    }
  }
  return {
    id: fixture.id, seedsCorrupt, seedsTried: fixture.seeds.length, corruptPoints,
    floor: fixture.floor, measured: fixture.measured, ok: seedsCorrupt >= fixture.floor, firstSeed,
  };
}

/** @returns {Array<{bound:number, consistent:number, corrupt:number, unverifiable:number}>} */
export function runBoundSweep() {
  return BOUND_SWEEP.map((bound) => {
    let consistent = 0, corrupt = 0, unverifiable = 0;
    for (let seed = 1; seed <= BOUND_SEEDS; seed++) {
      const r = enumerate({ workload: makeWorkload(seed), flags: correctBuild(), bound });
      consistent += r.consistent; corrupt += r.corrupt; unverifiable += r.unverifiable;
    }
    return { bound, consistent, corrupt, unverifiable };
  });
}

/**
 * The differential that makes the corrupt verdict load-bearing.
 * @returns {{honest:number, sabotaged:number, targetedHonest:number, targetedSabotaged:number}}
 */
export function runSabotage() {
  const lossy = parseBuildFlags('no-fsync-before-ack');
  const invented = parseBuildFlags('checksum-skipped');
  const seed = 1;
  const inventedSeed = 6;
  return {
    honest: enumerate({ workload: makeWorkload(seed), flags: lossy }).corrupt,
    sabotaged: enumerate({
      workload: makeWorkload(seed), flags: { ...lossy, checkerAcceptCorrupt: true },
    }).corrupt,
    targetedHonest: enumerate({ workload: makeWorkload(inventedSeed), flags: invented }).corrupt,
    targetedSabotaged: enumerate({
      workload: makeWorkload(inventedSeed), flags: { ...invented, checkerAcceptCorrupt: true },
    }).corrupt,
  };
}

// --------------------------------------------------------------------------
// commands

/** @param {any} args @returns {number} */
function cmdEnumerate(args) {
  const seed = seedOpt(args);
  const flags = buildOpt(args);
  const bound = boundOpt(args);
  const r = enumerate({ workload: makeWorkload(seed), flags, bound });
  if (args.json) {
    print(JSON.stringify({
      seed: r.seed, build: r.build, bound: r.bound, opCount: r.opCount, mutations: r.mutations,
      crashPoints: r.crashPoints, schedules: r.schedules, consistent: r.consistent,
      corrupt: r.corrupt, unverifiable: r.unverifiable, ms: r.ms,
      points: r.points.map((p) => ({ i: p.i, op: p.op, verdict: p.verdict, schedules: p.schedules })),
      firstFinding: r.firstFinding,
    }, null, 2));
    return 0;
  }
  print(renderSummary(r));
  print('');
  print(renderMatrix(r));
  if (r.firstFinding) {
    print('');
    print('first corrupt crash point');
    print(renderFinding(r.firstFinding));
    print('');
    print('  replay it:  node src/cli.js replay --seed ' + r.seed + ' --build ' + r.build +
      ' --point ' + r.firstFinding.crashPoint + ' --schedule ' + r.firstFinding.schedule);
  }
  const firstUnverifiable = r.points.find((p) => p.verdict === 'unverifiable');
  if (firstUnverifiable) {
    print('');
    print('first unverifiable crash point');
    print('  crash point ' + firstUnverifiable.i + ', interrupting: ' + firstUnverifiable.op);
    print('  ' + firstUnverifiable.reason);
  }
  return 0;
}

/** @param {any} args @returns {number} */
function cmdReplay(args) {
  const seed = seedOpt(args);
  const flags = buildOpt(args);
  const bound = boundOpt(args);
  if (args.point === undefined) throw new UserError('replay needs --point <int>');
  const crashPoint = intOpt(args, 'point', 0);
  let r;
  try {
    r = replayOne({
      workload: makeWorkload(seed), flags, crashPoint, bound,
      scheduleId: args.schedule === undefined ? undefined : String(args.schedule),
    });
  } catch (err) {
    if (err instanceof RangeError) throw new UserError(err.message);
    throw err;
  }
  const files = [...r.image.entries()].map(([name, b]) => name + ' ' + b.length + 'B').join(', ');
  if (args.json) {
    print(JSON.stringify({
      seed, build: formatBuildFlags(flags), crashPoint, schedule: r.schedule.id,
      op: r.op, verdict: r.verdict.verdict, reason: r.verdict.reason,
      image: [...r.image.entries()].map(([name, b]) => ({ name, bytes: b.length })),
      recovered: [...r.recovery.state.entries()].map(([k, v]) => ({ key: k, value: summarizeValue(v) })),
    }, null, 2));
    return r.verdict.verdict === 'corrupt' ? 1 : 0;
  }
  print('seed ' + seed + '  build ' + formatBuildFlags(flags) + '  crash point ' + crashPoint +
    ' of ' + r.ops.length);
  print('interrupting  ' + r.op);
  print('schedule      ' + r.schedule.id + '  (' + r.space.schedules.length + ' at this crash point' +
    (r.space.exhaustive ? ', all of them enumerated' : ', SAMPLED: ' + r.space.reason) + ')');
  print('disk image    ' + (files || '(no files)'));
  print('recovery      snapshot: ' + r.recovery.snapshot + '; log: replayed ' + r.recovery.replayed +
    ' record(s), stopped because ' + r.recovery.stopped);
  print('');
  print(r.verdict.verdict.toUpperCase() + ' -- ' + r.verdict.reason);
  if (r.verdict.verdict === 'corrupt') {
    print('');
    for (const d of r.verdict.diff) {
      if (d.kind === 'missing') print('  - ' + d.key.padEnd(6) + ' ' + summarizeValue(d.expected) + '  is gone');
      else if (d.kind === 'extra') print('  + ' + d.key.padEnd(6) + ' ' + summarizeValue(d.got) + '  should not exist');
      else print('  ~ ' + d.key.padEnd(6) + ' ' + summarizeValue(d.expected) + '  ->  ' + summarizeValue(d.got));
    }
    return 1;
  }
  return 0;
}

/** @returns {number} */
function cmdDemo() {
  const flags = parseBuildFlags(FEATURED.build);
  const r = enumerate({ workload: makeWorkload(FEATURED.seed), flags });
  if (!r.firstFinding) {
    process.stderr.write('cofferdam: the demo build stopped failing, which means a fixture has ' +
      'silently stopped firing. Run `cofferdam fixtures`.\n');
    return 1;
  }
  print('cofferdam demo -- a corrupt recovery, on purpose.');
  print('');
  print(renderSummary(r));
  print('');
  print(renderMatrix(r));
  print('');
  print('the first crash point that recovers to a state the API never produced');
  print(renderFinding(r.firstFinding));
  print('');
  print('Same workload, correct build:');
  const clean = enumerate({ workload: makeWorkload(FEATURED.seed), flags: correctBuild() });
  print('  ' + renderSummary(clean).split('\n')[1]);
  return 0;
}

/** @param {any} args @returns {number} */
function cmdFixtures(args) {
  const results = FIXTURES.map(runFixture);
  const sabotage = runSabotage();
  const control = runControl(intOpt(args, 'seeds', CONTROL_SEEDS));
  const sabotageOk = sabotage.honest > 0 && sabotage.sabotaged === 0 &&
    sabotage.targetedHonest > 0 && sabotage.targetedSabotaged > 0;
  if (args.json) {
    print(JSON.stringify({ fixtures: results, sabotage, sabotageOk, control }, null, 2));
    return results.every((r) => r.ok) && sabotageOk && control.corrupt === 0 ? 0 : 1;
  }
  print('Planted fixtures (recipes in src/fixtures.js, measured ' + MEASURED_ON + ')');
  for (const r of results) {
    print('  ' + (r.ok ? 'OK  ' : 'FAIL') + ' ' + r.id.padEnd(22) +
      r.seedsCorrupt + '/' + r.seedsTried + ' seeds corrupt (floor ' + r.floor + '), ' +
      r.corruptPoints + ' corrupt crash points');
  }
  print('  ' + (sabotageOk ? 'OK  ' : 'FAIL') + ' checker-accept-corrupt  ' +
    'the same enumeration reports ' + sabotage.honest + ' corrupt crash points honestly and ' +
    sabotage.sabotaged + ' with the checker sabotaged');
  print('       and the sabotage is targeted, not a blanket pass: an invented-value corruption ' +
    'still fires (' + sabotage.targetedHonest + ' -> ' + sabotage.targetedSabotaged + ')');
  print('');
  print('Negative control: ' + control.seeds + ' seeds of the correct build, ' +
    control.crashPoints + ' crash points, ' + control.schedules + ' crash schedules, ' +
    control.corrupt + ' corrupt, ' + control.unverifiable + ' unverifiable (' +
    Math.round(control.ms) + ' ms)');
  return results.every((r) => r.ok) && sabotageOk && control.corrupt === 0 ? 0 : 1;
}

/** @param {any} args @returns {number} */
function cmdControl(args) {
  const seeds = intOpt(args, 'seeds', CONTROL_SEEDS);
  if (seeds < 1) throw new UserError('--seeds must be at least 1, got ' + seeds);
  if (seeds > 100000) {
    throw new UserError('--seeds ' + seeds + ' is more than this is meant for; the ceiling is 100000');
  }
  const control = runControl(seeds);
  const sweep = runBoundSweep();
  if (args.json) { print(JSON.stringify({ control, sweep }, null, 2)); return control.corrupt === 0 ? 0 : 1; }
  print(control.seeds + ' seeds of the correct build');
  print('  ' + control.crashPoints + ' crash points');
  print('  ' + control.schedules + ' crash schedules');
  print('  ' + control.corrupt + ' corrupt');
  print('  ' + control.unverifiable + ' unverifiable');
  print('  ' + Math.round(control.ms) + ' ms');
  print('');
  print('What the reorder bound costs, over ' + BOUND_SEEDS + ' seeds of the correct build:');
  print('  bound  consistent  corrupt  unverifiable');
  for (const s of sweep) {
    print('  ' + String(s.bound).padStart(5) + String(s.consistent).padStart(12) +
      String(s.corrupt).padStart(9) + String(s.unverifiable).padStart(14));
  }
  return control.corrupt === 0 ? 0 : 1;
}

/** @param {any} args @returns {Promise<number>} */
async function cmdTargets(args) {
  const { runAllTargets } = await import('./targets/run.js');
  const seed = seedOpt(args, 1);
  const every = intOpt(args, 'every', 1);
  if (every < 1) throw new UserError('--every must be at least 1, got ' + every);
  const tears = intOpt(args, 'tears', 3);
  const { results, platform, node } = runAllTargets({ seed, every, tears });
  if (args.json) {
    print(JSON.stringify({ platform, node, seed, results }, null, 2));
  } else {
    print('Three real targets, run on ' + platform + ', Node ' + node + ', seed ' + seed);
    print('');
    print(renderTargets(results));
  }
  return results.some((r) => r.verdict === 'corrupt') ? 1 : 0;
}

/** @returns {number} */
function cmdBugs() {
  print('Planted fixtures. Every one lives in src/bugs.js.');
  print('');
  for (const b of BUGS) {
    print('  ' + b.id + '  [' + b.breaks + ']');
    print('    ' + b.title);
    for (const line of wrap(b.detail, 72)) print('      ' + line);
    print('');
  }
  print('Use with --build, comma separated: --build no-fsync-before-ack,checksum-skipped');
  return 0;
}

/** @param {string} text @param {number} width @returns {string[]} */
function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) { lines.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(line);
  return lines;
}

/** @param {any} args @returns {number} */
function cmdVerify(args) {
  const file = args._[1];
  if (!file) throw new UserError('verify needs a file: cofferdam verify <crashes.json>');
  const report = readReportFile(file);
  /** @type {Array<{section:string, status:'match'|'mismatch'|'unverified', detail:string}>} */
  const rows = [];

  const control = runControl(report.control.seeds);
  const controlSame = control.crashPoints === report.control.crashPoints &&
    control.schedules === report.control.schedules &&
    control.corrupt === report.control.corrupt &&
    control.unverifiable === report.control.unverifiable;
  rows.push({
    section: 'negative control',
    status: controlSame ? 'match' : 'mismatch',
    detail: controlSame
      ? control.crashPoints + ' crash points, ' + control.schedules + ' schedules, ' +
        control.corrupt + ' corrupt, ' + control.unverifiable + ' unverifiable'
      : 'recorded ' + report.control.crashPoints + '/' + report.control.schedules + '/' +
        report.control.corrupt + '/' + report.control.unverifiable + ', got ' +
        control.crashPoints + '/' + control.schedules + '/' + control.corrupt + '/' + control.unverifiable,
  });

  for (const recorded of report.fixtures) {
    const fixture = FIXTURES.find((f) => f.id === recorded.id);
    if (!fixture) {
      rows.push({
        section: recorded.id, status: 'unverified',
        detail: 'the report names a fixture this build does not have',
      });
      continue;
    }
    const got = runFixture(fixture);
    const same = got.seedsCorrupt === recorded.seedsCorrupt && got.corruptPoints === recorded.corruptPoints;
    rows.push({
      section: recorded.id,
      status: same ? 'match' : 'mismatch',
      detail: same
        ? got.seedsCorrupt + '/' + got.seedsTried + ' seeds, ' + got.corruptPoints + ' corrupt crash points'
        : 'recorded ' + recorded.seedsCorrupt + ' seeds / ' + recorded.corruptPoints +
          ' points, got ' + got.seedsCorrupt + ' / ' + got.corruptPoints,
    });
  }

  rows.push({
    section: 'real targets',
    status: 'unverified',
    detail: Array.isArray(report.targets?.results) && report.targets.results.length > 0
      ? report.targets.results.length + ' target results recorded on ' +
        (report.targets.platform ?? 'an unrecorded platform') + ', Node ' +
        (report.targets.node ?? '?') + '; they spawn real processes and were not re-run here. ' +
        'Run `cofferdam targets`.'
      : 'the report records no target results',
  });

  if (args.json) {
    print(JSON.stringify({ file, rows }, null, 2));
  } else {
    print('verifying ' + file + ' (generated ' + (report.generated ?? 'at an unrecorded time') + ')');
    print('');
    for (const r of rows) print('  ' + r.status.toUpperCase().padEnd(11) + r.section.padEnd(24) + r.detail);
    print('');
    const bad = rows.filter((r) => r.status === 'mismatch').length;
    const unver = rows.filter((r) => r.status === 'unverified').length;
    print(bad === 0
      ? 'every re-runnable number in the report reproduced (' + unver + ' section(s) not re-run)'
      : bad + ' section(s) no longer reproduce');
  }
  return rows.some((r) => r.status === 'mismatch') ? 1 : 0;
}

/**
 * @param {string[]} argv
 * @param {(s:string)=>void} [out]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, out) {
  if (out) print = out;
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UserError) { process.stderr.write('cofferdam: ' + err.message + '\n'); return 1; }
    throw err;
  }
  const cmd = args._[0];
  if (!cmd || args.help || cmd === 'help') {
    print(USAGE);
    return cmd || args.help ? 0 : 1;
  }
  try {
    switch (cmd) {
      case 'demo': return cmdDemo();
      case 'enumerate': return cmdEnumerate(args);
      case 'replay': return cmdReplay(args);
      case 'fixtures': return cmdFixtures(args);
      case 'control': return cmdControl(args);
      case 'targets': return await cmdTargets(args);
      case 'bugs': return cmdBugs();
      case 'verify': return cmdVerify(args);
      default:
        process.stderr.write('cofferdam: unknown command "' + cmd + '"\n\n' + USAGE + '\n');
        return 1;
    }
  } catch (err) {
    if (err instanceof UserError) { process.stderr.write('cofferdam: ' + err.message + '\n'); return 1; }
    if (err instanceof RangeError || err instanceof TypeError) {
      // Input-shaped failures from the library layer: state them, do not dump a
      // stack at someone who mistyped a flag.
      process.stderr.write('cofferdam: ' + /** @type {Error} */ (err).message + '\n');
      return 1;
    }
    throw err;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
