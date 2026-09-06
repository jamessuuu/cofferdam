// The three real targets, and the harness that runs them.
//
// STANDARDS' house rule: a checker is not done until it has run against three
// real targets with the false positives removed. A durability checker's honest
// real targets are real durability contracts, so these are:
//
//   T1  the store on the real filesystem, killed by a real SIGKILL at every
//       op boundary, recovered from the real bytes left behind;
//   T2  SQLite through node:sqlite, in WAL mode, under two different
//       synchronous settings, killed the same way and judged by the same
//       checker;
//   T3  byte fidelity: the model's predicted image versus the image NTFS
//       actually produces for the same op stream. If T3 fails, every verdict
//       the enumerator has ever produced is fiction, so it runs first.
//
// Each target reports consistent / corrupt / unverifiable, and `unverifiable`
// here is load-bearing: a target that is not installed, or a platform that
// cannot issue a barrier, is not a pass.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RealDevice, readRealImage, writeRealImage, compareImages, modelImageAll, recoverFromDisk, scratchDir,
} from './realfs.js';
import { Store, recover } from '../store.js';
import { makeWorkload, runWorkload } from '../workload.js';
import { correctBuild, formatBuildFlags } from '../bugs.js';
import { prefixStates, validate, sameState, legalWindow } from '../spec.js';
import { describeOp, inflightAt, materialize } from '../device.js';
import { scheduleSpace, DEFAULT_BOUND } from '../enumerate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'child.js');

/** @param {string} dir */
function rmDir(dir) {
  // The OS can still hold a handle to a just-killed child's files; the temp
  // directory is disposable either way.
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* disposable */ }
}

/**
 * @typedef {object} TargetResult
 * @property {string} id
 * @property {string} title
 * @property {'consistent'|'corrupt'|'unverifiable'} verdict
 * @property {string} detail
 * @property {number} checked how many crash points were actually exercised
 * @property {number} corrupt
 * @property {string[]} notes measured observations, including removed false positives
 * @property {{checked:number, corrupt:number}} [killPhase] real process kills only
 * @property {{checked:number, corrupt:number, mismatches:number}} [imagePhase] modeled images on real files
 */

// ---------------------------------------------------------------------------
// T3 -- byte fidelity of the model against NTFS

/**
 * @param {number} seed
 * @param {import('../bugs.js').BuildFlags} [flags]
 * @returns {TargetResult}
 */
export function fidelityTarget(seed, flags = correctBuild()) {
  const dir = scratchDir();
  /** @type {string[]} */
  const notes = [];
  try {
    const workload = makeWorkload(seed);
    const device = new RealDevice(dir);
    const store = new Store(device, flags);
    store.format();
    for (const step of workload.steps) {
      if (step.kind === 'put') store.put(step.key, step.value);
      else if (step.kind === 'del') store.del(step.key);
      else store.checkpoint();
    }
    const model = runWorkload(workload, flags);
    if (model.device.ops.length !== device.ops.length) {
      return {
        id: 'T3', title: 'model bytes vs NTFS bytes', verdict: 'corrupt', checked: 1, corrupt: 1,
        detail: 'the real run issued ' + device.ops.length + ' operations and the modeled run ' +
          model.device.ops.length + '; they are not the same program',
        notes,
      };
    }
    for (const note of device.notes) notes.push(note);
    const real = readRealImage(dir);
    const predicted = modelImageAll(device.ops, device.ops.length);
    const diffs = compareImages(predicted, real);
    const bytes = [...real.values()].reduce((n, b) => n + b.length, 0);
    if (diffs.length > 0) {
      return {
        id: 'T3', title: 'model bytes vs NTFS bytes', verdict: 'corrupt', checked: device.ops.length,
        corrupt: diffs.length, detail: diffs.slice(0, 4).join('; '), notes,
      };
    }
    return {
      id: 'T3', title: 'model bytes vs NTFS bytes', verdict: 'consistent', checked: device.ops.length, corrupt: 0,
      detail: device.ops.length + ' real operations on ' + process.platform + ', ' + bytes +
        ' bytes across ' + real.size + ' files, byte-identical to the model',
      notes,
    };
  } finally {
    rmDir(dir);
  }
}

// ---------------------------------------------------------------------------
// T1 -- the store on a real filesystem, killed for real

/**
 * @param {object} opts
 * @param {number} opts.seed
 * @param {import('../bugs.js').BuildFlags} [opts.flags]
 * @param {number} [opts.every] sample every Nth op boundary (1 = every one)
 * @returns {TargetResult}
 */
export function realFsTarget({ seed, flags = correctBuild(), every = 1 }) {
  const workload = makeWorkload(seed);
  const model = runWorkload(workload, flags);
  const ops = model.device.ops;
  const prefixes = prefixStates(model.store.mutations);
  /** @type {string[]} */
  const notes = [];
  let checked = 0;
  let corrupt = 0;
  let killed = 0;
  /** @type {string|null} */
  let firstBad = null;

  for (let k = 0; k <= ops.length; k += every) {
    const dir = scratchDir();
    try {
      const r = spawnSync(process.execPath, [
        CHILD, '--target', 'realfs', '--dir', dir, '--seed', String(seed),
        '--build', formatBuildFlags(flags), '--crash-at', String(k),
      ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      const survived = fs.existsSync(path.join(dir, 'survived'));
      if (k < ops.length && survived) {
        notes.push('crash point ' + k + ': the child was not killed (exit ' + r.status + ')');
      } else if (k < ops.length) {
        killed++;
      }
      const recovery = recoverFromDisk(dir, flags);
      const verdict = validate({ mutations: model.store.mutations, prefixes, crashPoint: k, recovery, flags });
      checked++;
      if (verdict.verdict === 'corrupt') {
        corrupt++;
        if (firstBad === null) {
          firstBad = 'crash point ' + k + ' (' + (k < ops.length ? describeOp(ops[k]) : 'end') + '): ' + verdict.reason;
        }
      }
    } finally {
      rmDir(dir);
    }
  }
  const killPhase = { checked, corrupt };
  notes.push(
    killed + ' of ' + checked + ' runs died to a real SIGKILL mid-workload; the survivors are the ' +
    'crash points at or past the end of the op stream'
  );

  // A process kill cannot reach an un-fsynced state, so the second half of this
  // target writes the enumerator's own crash images to real files and recovers
  // through real file I/O. Every verdict must match the one the in-memory
  // enumeration produced; a disagreement would mean the enumerator's verdicts
  // depend on how the bytes were held rather than on what they are.
  const dir2 = scratchDir();
  let imageChecked = 0;
  let mismatches = 0;
  try {
    for (let k = 0; k <= ops.length; k += every) {
      const space = scheduleSpace(ops, inflightAt(ops, k), DEFAULT_BOUND);
      for (const sched of space.schedules) {
        const image = materialize(ops, k, sched);
        writeRealImage(dir2, image);
        const onDisk = validate({
          mutations: model.store.mutations, prefixes, crashPoint: k,
          recovery: recoverFromDisk(dir2, flags), flags,
        });
        const inMemory = validate({
          mutations: model.store.mutations, prefixes, crashPoint: k,
          recovery: recover(image, flags), flags,
        });
        imageChecked++;
        if (onDisk.verdict !== inMemory.verdict) {
          mismatches++;
          if (firstBad === null) {
            firstBad = 'crash point ' + k + ' schedule ' + sched.id + ': in memory "' +
              inMemory.verdict + '", from real files "' + onDisk.verdict + '"';
          }
        }
        if (onDisk.verdict === 'corrupt') corrupt++;
      }
    }
  } finally {
    rmDir(dir2);
  }
  const imagePhase = { checked: imageChecked, corrupt: corrupt - killPhase.corrupt, mismatches };
  checked += imageChecked;
  notes.push(
    imageChecked + ' modeled crash images were written to real files and recovered through real ' +
    'file I/O; ' + mismatches + ' disagreed with the in-memory verdict'
  );

  return {
    id: 'T1', title: 'the store on the real filesystem, killed by SIGKILL',
    killPhase, imagePhase,
    verdict: corrupt > 0 ? 'corrupt' : 'consistent',
    checked, corrupt,
    detail: corrupt > 0
      ? firstBad ?? ''
      : checked + ' real crash points and images on ' + process.platform + ', every recovery a legal state',
    notes,
  };
}

// ---------------------------------------------------------------------------
// T2 -- SQLite

/** @returns {boolean} */
export function sqliteAvailable() {
  try {
    return Boolean(process.getBuiltinModule('node:sqlite'));
  } catch {
    return false;
  }
}

/** Every file SQLite may leave behind, so a crash image can be restored exactly. */
const SQLITE_FILES = ['kv.db', 'kv.db-wal', 'kv.db-shm'];

/**
 * Opening a database RECOVERS it, and can checkpoint and truncate the WAL. So
 * each crash image has to be captured once and restored before every variant,
 * or the second variant is not a crash image at all -- it is the first
 * variant's recovered database with a hole punched in it.
 * @param {string} dir
 * @returns {Map<string, Uint8Array|null>}
 */
function snapshotSqlite(dir) {
  /** @type {Map<string, Uint8Array|null>} */
  const snap = new Map();
  for (const name of SQLITE_FILES) {
    const full = path.join(dir, name);
    snap.set(name, fs.existsSync(full) ? new Uint8Array(fs.readFileSync(full)) : null);
  }
  return snap;
}

/**
 * @param {string} dir
 * @param {Map<string, Uint8Array|null>} snap
 * @param {number|null} walCut truncate the WAL to this many bytes
 */
function restoreSqlite(dir, snap, walCut) {
  for (const name of SQLITE_FILES) {
    const full = path.join(dir, name);
    const bytes = snap.get(name);
    if (bytes === null || bytes === undefined) { fs.rmSync(full, { force: true }); continue; }
    fs.writeFileSync(full, name === 'kv.db-wal' && walCut !== null ? bytes.subarray(0, walCut) : bytes);
  }
}

/**
 * @param {string} dir
 * @returns {Map<string,string>|{error:string}}
 */
function readSqliteState(dir) {
  try {
    const mod = process.getBuiltinModule('node:sqlite');
    const db = new mod.DatabaseSync(path.join(dir, 'kv.db'));
    try {
      const rows = /** @type {Array<{k:string, v:string}>} */ (
        db.prepare('SELECT k, v FROM kv').all()
      );
      /** @type {Map<string,string>} */
      const state = new Map();
      for (const row of rows) state.set(row.k, row.v);
      return state;
    } finally {
      db.close();
    }
  } catch (err) {
    const message = /** @type {Error} */ (err).message;
    // FALSE POSITIVE, removed after the first real run: cutting the write-ahead
    // log below the frame that created the table leaves a database with no
    // table at all. That is not a refusal to open -- it is the state after zero
    // mutations, and it is exactly what losing the first transaction looks
    // like. Every other SQLite error is still treated as a failure to recover.
    if (/no such table/i.test(message)) return new Map();
    return { error: message };
  }
}

/**
 * @param {object} opts
 * @param {number} opts.seed
 * @param {'FULL'|'OFF'} [opts.sync]
 * @param {number} [opts.tears] WAL truncation offsets to try per crash point (OFF only)
 * @returns {TargetResult}
 */
export function sqliteTarget({ seed, sync = 'FULL', tears = 0 }) {
  const id = 'T2/' + sync;
  const title = 'node:sqlite, WAL journal, synchronous=' + sync;
  if (!sqliteAvailable()) {
    return {
      id, title, verdict: 'unverifiable', checked: 0, corrupt: 0,
      detail: 'node:sqlite is not present in this Node build (' + process.version +
        '), so this target could not be run',
      notes: [],
    };
  }
  const workload = makeWorkload(seed);
  const mutations = workload.steps.filter((s) => s.kind !== 'checkpoint');
  /** @type {Map<string,string>[]} */
  const prefixes = [new Map()];
  {
    /** @type {Map<string,string>} */
    let cur = new Map();
    for (const m of mutations) {
      cur = new Map(cur);
      if (m.kind === 'del') cur.delete(m.key); else cur.set(m.key, m.value);
      prefixes.push(cur);
    }
  }

  /** @type {string[]} */
  const notes = [];
  let checked = 0;
  let corrupt = 0;
  let integrityViolations = 0;
  let durabilityLosses = 0;
  /** @type {string|null} */
  let firstBad = null;

  for (let k = 0; k <= mutations.length; k++) {
    const dir = scratchDir();
    try {
      spawnSync(process.execPath, [
        CHILD, '--target', 'sqlite', '--dir', dir, '--seed', String(seed),
        '--sync', sync, '--crash-at', String(k),
      ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });

      const snap = snapshotSqlite(dir);
      /** @type {Array<{label:string, cut:number|null}>} */
      const images = [{ label: 'as killed', cut: null }];
      const walBytes = snap.get('kv.db-wal');
      if (tears > 0 && walBytes) {
        const size = walBytes.length;
        for (let t = 1; t <= tears; t++) {
          const cut = Math.floor((size * t) / (tears + 1));
          if (cut > 0 && cut < size) images.push({ label: 'wal cut at ' + cut + '/' + size, cut });
        }
      }

      for (const img of images) {
        restoreSqlite(dir, snap, img.cut);
        const state = readSqliteState(dir);
        checked++;
        if (!(state instanceof Map)) {
          corrupt++;
          if (firstBad === null) {
            firstBad = 'crash point ' + k + ' (' + img.label + '): sqlite refused to open: ' + state.error;
          }
          continue;
        }
        let matched = -1;
        for (let t = 0; t <= k; t++) if (sameState(state, prefixes[t])) { matched = t; break; }
        if (matched === -1) {
          integrityViolations++;
          corrupt++;
          if (firstBad === null) {
            firstBad = 'crash point ' + k + ' (' + img.label +
              '): recovered a state matching no prefix of the workload';
          }
        } else if (matched < k) {
          durabilityLosses++;
        }
      }
    } finally {
      rmDir(dir);
    }
  }

  if (sync === 'FULL') {
    if (durabilityLosses > 0) {
      corrupt += durabilityLosses;
      if (firstBad === null) firstBad = durabilityLosses + ' recoveries lost a committed transaction';
    }
    notes.push('the full contract was checked: every committed transaction present, and no state outside the workload');
  } else {
    notes.push(
      'FALSE POSITIVE REMOVED: at synchronous=OFF, SQLite does not promise that a committed ' +
      'transaction survives power loss, so ' + durabilityLosses + ' "lost commit" reports here are the ' +
      'documented contract and not defects. Only the integrity half of the specification is applied ' +
      'to this configuration.'
    );
  }
  return {
    id, title,
    verdict: corrupt > 0 ? 'corrupt' : 'consistent',
    checked, corrupt,
    detail: corrupt > 0
      ? firstBad ?? ''
      : checked + ' real crash images, ' + integrityViolations +
        ' integrity violations, every recovery a prefix of the workload',
    notes,
  };
}

/**
 * @param {object} [opts]
 * @param {number} [opts.seed]
 * @param {number} [opts.every]
 * @param {number} [opts.tears]
 * @returns {{results: TargetResult[], platform: string, node: string}}
 */
export function runAllTargets(opts = {}) {
  const seed = opts.seed ?? 1;
  const results = [
    fidelityTarget(seed),
    realFsTarget({ seed, every: opts.every ?? 1 }),
    sqliteTarget({ seed, sync: 'FULL' }),
    sqliteTarget({ seed, sync: 'OFF', tears: opts.tears ?? 3 }),
  ];
  return { results, platform: process.platform, node: process.version };
}

/**
 * The measurement that justifies the modeled device: run the SAME broken build
 * against the real filesystem with real process kills, and show that the bug
 * the enumerator finds is invisible there.
 * @param {object} opts
 * @param {number} opts.seed
 * @param {import('../bugs.js').BuildFlags} opts.flags
 * @param {number} [opts.every]
 */
export function realFsBlindSpot({ seed, flags, every = 1 }) {
  const real = realFsTarget({ seed, flags, every });
  const workload = makeWorkload(seed);
  const model = runWorkload(workload, flags);
  const window = legalWindow(model.store.mutations, model.device.ops.length);
  return {
    real,
    kill: real.killPhase ?? { checked: 0, corrupt: 0 },
    image: real.imagePhase ?? { checked: 0, corrupt: 0, mismatches: 0 },
    acknowledged: window.acked,
    opCount: model.device.ops.length,
  };
}
