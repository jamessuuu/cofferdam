// The enumerator: bounded exhaustive crash-point enumeration.
//
// kedge, the sibling project, samples an enormous space randomly by seed.
// This does the opposite: it takes a small space and visits ALL of it, and
// says so out loud when the space stops being small.
//
// A CRASH POINT is an index into the recorded op stream: the machine lost power
// after ops[0..i-1] were issued and before ops[i]. There are opCount+1 of them
// and every one is visited.
//
// A CRASH SCHEDULE at a crash point says which of the in-flight (issued but not
// fsynced) operations actually reached the platter, and whether the last one to
// land was torn. Its space is:
//
//   metadata: prefixes of the in-flight metadata ops        (|M|+1 schedules)
//   data:     every subset of the in-flight data ops        (2^|D| schedules)
//   tearing:  at most one torn write, at every sector boundary inside it
//
// "At most one torn write" is the bound CrashMonkey/ACE use, and it is the same
// empirical bet: the published finding is that crash-consistency bugs
// overwhelmingly reproduce within three operations, so a space bounded this way
// is small enough to finish and large enough to catch things.
//
// When |D| exceeds the reorder bound the space is sampled instead of
// enumerated, and every point in that state whose sample found nothing is
// reported UNVERIFIABLE, not consistent. Finding a corruption is definitive
// evidence; finding none under an incomplete search is not evidence at all.

import { inflightAt, materialize, sectorsOf, describeOp } from './device.js';
import { recover } from './store.js';
import { prefixStates, validate } from './spec.js';
import { correctBuild, formatBuildFlags } from './bugs.js';
import { runWorkload, summarizeValue } from './workload.js';

/** Enumerate all subsets of at most this many in-flight data writes. */
export const DEFAULT_BOUND = 4;

/** Hard ceiling on schedules at one crash point, so a pathological point cannot hang the run. */
export const MAX_SCHEDULES_PER_POINT = 4096;

/**
 * @param {number[]} items
 * @returns {number[][]} every subset, smallest first, deterministic order
 */
function subsets(items) {
  /** @type {number[][]} */
  const out = [];
  for (let mask = 0; mask < 1 << items.length; mask++) {
    /** @type {number[]} */
    const pick = [];
    for (let b = 0; b < items.length; b++) if (mask & (1 << b)) pick.push(items[b]);
    out.push(pick);
  }
  out.sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));
  return out;
}

/**
 * When the subset space is too big to enumerate, take the schedules most likely
 * to expose a bug: nothing landed, everything landed, every prefix, every
 * suffix, every singleton. This is a SAMPLE and the caller must say so.
 * @param {number[]} items
 * @returns {number[][]}
 */
function sampleSubsets(items) {
  /** @type {Map<string, number[]>} */
  const seen = new Map();
  const add = (/** @type {number[]} */ s) => { seen.set(s.join(','), s); };
  add([]);
  add(items.slice());
  for (let n = 1; n < items.length; n++) { add(items.slice(0, n)); add(items.slice(n)); }
  for (const it of items) add([it]);
  return [...seen.values()];
}

/**
 * @param {import('./device.js').Schedule[]} into
 * @param {import('./device.js').Op[]} ops
 * @param {number[]} persist
 */
function withTears(into, ops, persist) {
  const id = 'D' + (persist.length ? persist.join('.') : '-');
  into.push({ persist, tear: null, id });
  for (const idx of persist) {
    const s = sectorsOf(ops[idx]);
    for (let k = 1; k < s; k++) {
      into.push({ persist, tear: { index: idx, sectors: k }, id: id + '/T' + idx + '@' + k });
    }
  }
}

/**
 * @typedef {object} ScheduleSpace
 * @property {import('./device.js').Schedule[]} schedules
 * @property {boolean} exhaustive
 * @property {string} reason empty when exhaustive
 */

/**
 * @param {import('./device.js').Op[]} ops
 * @param {{data:number[], meta:number[]}} inflight
 * @param {number} bound
 * @returns {ScheduleSpace}
 */
export function scheduleSpace(ops, inflight, bound) {
  const { data, meta } = inflight;
  let exhaustive = true;
  let reason = '';
  const dataSets = data.length <= bound ? subsets(data) : sampleSubsets(data);
  if (data.length > bound) {
    exhaustive = false;
    reason = 'reorder bound exceeded: ' + data.length + ' un-fsynced writes are in flight (2^' +
      data.length + ' orderings); the bound enumerates ' + bound + '. ' + dataSets.length +
      ' representative schedules were run instead.';
  }
  /** @type {import('./device.js').Schedule[]} */
  const schedules = [];
  for (let m = 0; m <= meta.length; m++) {
    const metaPrefix = meta.slice(0, m);
    for (const d of dataSets) {
      /** @type {import('./device.js').Schedule[]} */
      const local = [];
      withTears(local, ops, [...metaPrefix, ...d].sort((a, b) => a - b));
      for (const s of local) schedules.push({ ...s, id: 'M' + m + '/' + s.id });
    }
  }
  if (schedules.length > MAX_SCHEDULES_PER_POINT) {
    const kept = schedules.slice(0, MAX_SCHEDULES_PER_POINT);
    return {
      schedules: kept,
      exhaustive: false,
      reason: (reason ? reason + ' ' : '') + 'schedule ceiling hit: ' + schedules.length +
        ' schedules at this crash point, ' + MAX_SCHEDULES_PER_POINT + ' were run.',
    };
  }
  return { schedules, exhaustive, reason };
}

/**
 * @typedef {object} Finding
 * @property {number} crashPoint
 * @property {string} op the operation the crash interrupted
 * @property {string} schedule schedule id, replayable from the CLI
 * @property {string} reason
 * @property {number} acked mutations acknowledged before the crash
 * @property {number} issued mutations issued before the crash
 * @property {number} nearestPrefix the legal state the diff is taken against
 * @property {Array<{key:string, value:string}>} expected the minimum legal state
 * @property {Array<{key:string, value:string}>} got
 * @property {Array<{key:string, kind:string, expected:string|null, got:string|null}>} diff
 * @property {string} recoveryNote what recovery said it did
 */

/**
 * @typedef {object} PointResult
 * @property {number} i
 * @property {string} op
 * @property {'consistent'|'corrupt'|'unverifiable'} verdict
 * @property {string} reason
 * @property {number} schedules
 * @property {number} corruptSchedules
 * @property {number} inflightData
 * @property {number} inflightMeta
 * @property {Finding|null} finding
 */

/**
 * @param {Map<string,string>} state
 * @returns {Array<{key:string, value:string}>}
 */
function stateRows(state) {
  return [...state.keys()].sort().map((key) => ({
    key, value: summarizeValue(/** @type {string} */ (state.get(key))),
  }));
}

/**
 * @typedef {object} EnumerationResult
 * @property {number} seed
 * @property {string} build
 * @property {number} bound
 * @property {number} opCount
 * @property {number} mutations
 * @property {number} crashPoints
 * @property {number} schedules total schedules executed
 * @property {number} consistent
 * @property {number} corrupt
 * @property {number} unverifiable
 * @property {PointResult[]} points
 * @property {Finding|null} firstFinding
 * @property {number} ms
 */

/**
 * Visit every crash point of one workload.
 * @param {object} args
 * @param {import('./workload.js').Workload} args.workload
 * @param {import('./bugs.js').BuildFlags} [args.flags]
 * @param {number} [args.bound]
 * @param {boolean} [args.stopAtFirstCorruptSchedule] stop a POINT early once it is decided
 * @returns {EnumerationResult}
 */
export function enumerate({
  workload, flags = correctBuild(), bound = DEFAULT_BOUND, stopAtFirstCorruptSchedule = false,
}) {
  if (!Number.isInteger(bound) || bound < 0) throw new RangeError('bound must be a non-negative integer');
  const started = process.hrtime.bigint();
  const { device, store } = runWorkload(workload, flags);
  const ops = device.ops;
  const prefixes = prefixStates(store.mutations);
  /** @type {PointResult[]} */
  const points = [];
  let consistent = 0, corrupt = 0, unverifiable = 0, schedules = 0;
  /** @type {Finding|null} */
  let firstFinding = null;

  for (let i = 0; i <= ops.length; i++) {
    const inflight = inflightAt(ops, i);
    const space = scheduleSpace(ops, inflight, bound);
    let corruptSchedules = 0;
    /** @type {Finding|null} */
    let finding = null;
    for (const sched of space.schedules) {
      const image = materialize(ops, i, sched);
      const rec = recover(image, flags);
      const v = validate({ mutations: store.mutations, prefixes, crashPoint: i, recovery: rec, flags });
      schedules++;
      if (v.verdict === 'corrupt') {
        corruptSchedules++;
        if (finding === null) {
          finding = {
            crashPoint: i,
            op: i < ops.length ? describeOp(ops[i]) : '<the workload finished>',
            schedule: sched.id,
            reason: v.reason,
            acked: v.window.acked,
            issued: v.window.issued,
            nearestPrefix: v.nearestPrefix,
            expected: stateRows(prefixes[v.nearestPrefix]),
            got: stateRows(rec.state),
            diff: v.diff.map((d) => ({
              key: d.key, kind: d.kind,
              expected: d.expected === null ? null : summarizeValue(d.expected),
              got: d.got === null ? null : summarizeValue(d.got),
            })),
            recoveryNote: 'snapshot: ' + rec.snapshot + '; log: replayed ' + rec.replayed +
              ' record(s), stopped because ' + rec.stopped,
          };
        }
        if (stopAtFirstCorruptSchedule) break;
      }
    }
    /** @type {'consistent'|'corrupt'|'unverifiable'} */
    let verdict;
    let reason;
    if (corruptSchedules > 0) {
      verdict = 'corrupt';
      reason = /** @type {Finding} */ (finding).reason;
      corrupt++;
    } else if (space.exhaustive) {
      verdict = 'consistent';
      reason = 'every schedule at this crash point recovers to a legal state';
      consistent++;
    } else {
      verdict = 'unverifiable';
      reason = space.reason;
      unverifiable++;
    }
    if (finding !== null && firstFinding === null) firstFinding = finding;
    points.push({
      i,
      op: i < ops.length ? describeOp(ops[i]) : '<the workload finished>',
      verdict, reason,
      schedules: space.schedules.length,
      corruptSchedules,
      inflightData: inflight.data.length,
      inflightMeta: inflight.meta.length,
      finding,
    });
  }

  return {
    seed: workload.seed,
    build: formatBuildFlags(flags),
    bound,
    opCount: ops.length,
    mutations: store.mutations.length,
    crashPoints: points.length,
    schedules, consistent, corrupt, unverifiable,
    points, firstFinding,
    ms: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

/**
 * Replay exactly one cell of the matrix: one crash point, one schedule.
 * This is what the report page's per-cell command runs.
 * @param {object} args
 * @param {import('./workload.js').Workload} args.workload
 * @param {import('./bugs.js').BuildFlags} [args.flags]
 * @param {number} args.crashPoint
 * @param {string} [args.scheduleId] defaults to the first schedule at that point
 * @param {number} [args.bound]
 */
export function replayOne({ workload, flags = correctBuild(), crashPoint, scheduleId, bound = DEFAULT_BOUND }) {
  const { device, store } = runWorkload(workload, flags);
  const ops = device.ops;
  if (!Number.isInteger(crashPoint) || crashPoint < 0 || crashPoint > ops.length) {
    throw new RangeError(
      'crash point ' + crashPoint + ' is out of range; this workload has ' + (ops.length + 1) +
      ' crash points (0..' + ops.length + ')'
    );
  }
  const space = scheduleSpace(ops, inflightAt(ops, crashPoint), bound);
  const sched = scheduleId === undefined
    ? space.schedules[0]
    : space.schedules.find((s) => s.id === scheduleId);
  if (!sched) {
    throw new RangeError(
      'no schedule "' + scheduleId + '" at crash point ' + crashPoint + '; there are ' +
      space.schedules.length + ' (first: ' + space.schedules[0].id + ')'
    );
  }
  const image = materialize(ops, crashPoint, sched);
  const recovery = recover(image, flags);
  const prefixes = prefixStates(store.mutations);
  const verdict = validate({ mutations: store.mutations, prefixes, crashPoint, recovery, flags });
  return {
    ops, store, schedule: sched, image, recovery, verdict, space,
    op: crashPoint < ops.length ? describeOp(ops[crashPoint]) : '<the workload finished>',
    expected: prefixes[verdict.window.acked],
  };
}
