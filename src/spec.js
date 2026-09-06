// The specification a recovered state is judged against, and the validator that
// judges it. This file is the checker; everything else is the thing being
// checked.
//
// cofferdam's durability contract, in one sentence: recovery yields the state
// after some PREFIX of the issued mutations, and that prefix includes every
// mutation the API acknowledged before the crash.
//
// That is checkable because the writer is single-threaded and synchronous, so
// at any crash point at most one mutation is in flight. The legal answers are
// therefore exactly two: the state after the last acknowledged mutation, and
// (only while one is in flight) the state after that one as well. Anything else
// is a state the API could not have produced.
//
// Three outcomes, never two:
//   consistent    the recovered state is one of the legal states
//   corrupt       it is not, and here is the diff
//   unverifiable  no verdict was reached, and here is why
//
// The third is not politeness. The enumerator bounds the reordering space, and
// a crash point whose space was sampled rather than enumerated has NOT been
// shown to be safe. Reporting that as a pass would be the exact lie this
// project exists to refuse.

import { correctBuild } from './bugs.js';

/**
 * Every prefix state of a workload, so the validator does not rebuild them once
 * per schedule.
 * @param {import('./store.js').Mutation[]} mutations
 * @returns {Map<string,string>[]} index t is the state after mutations[0..t-1]
 */
export function prefixStates(mutations) {
  /** @type {Map<string,string>[]} */
  const out = [new Map()];
  /** @type {Map<string,string>} */
  let cur = new Map();
  for (const m of mutations) {
    cur = new Map(cur);
    if (m.value === null) cur.delete(m.key); else cur.set(m.key, m.value);
    out.push(cur);
  }
  return out;
}

/**
 * The window of mutation counts that recovery is allowed to land on.
 * @param {import('./store.js').Mutation[]} mutations
 * @param {number} crashPoint op-stream index the crash happened at
 * @returns {{acked:number, issued:number}}
 */
export function legalWindow(mutations, crashPoint) {
  let acked = 0;
  let issued = 0;
  for (const m of mutations) {
    if (m.ackedAtOp <= crashPoint) acked++;
    if (m.issuedAtOp < crashPoint) issued++;
  }
  return { acked, issued };
}

/**
 * @param {Map<string,string>} a
 * @param {Map<string,string>} b
 * @returns {boolean}
 */
export function sameState(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * @typedef {object} DiffEntry
 * @property {string} key
 * @property {'missing'|'extra'|'wrong'} kind
 * @property {string|null} expected
 * @property {string|null} got
 */

/**
 * @param {Map<string,string>} expected
 * @param {Map<string,string>} got
 * @returns {DiffEntry[]}
 */
export function diffState(expected, got) {
  /** @type {DiffEntry[]} */
  const out = [];
  const keys = new Set([...expected.keys(), ...got.keys()]);
  for (const key of [...keys].sort()) {
    const e = expected.has(key) ? /** @type {string} */ (expected.get(key)) : null;
    const g = got.has(key) ? /** @type {string} */ (got.get(key)) : null;
    if (e === g) continue;
    if (e === null) out.push({ key, kind: 'extra', expected: null, got: g });
    else if (g === null) out.push({ key, kind: 'missing', expected: e, got: null });
    else out.push({ key, kind: 'wrong', expected: e, got: g });
  }
  return out;
}

/**
 * @typedef {object} Verdict
 * @property {'consistent'|'corrupt'} verdict
 * @property {string} reason
 * @property {number|null} matchedPrefix which legal prefix the state equals
 * @property {{acked:number, issued:number}} window
 * @property {number} nearestPrefix the legal prefix used for the diff
 * @property {DiffEntry[]} diff
 * @property {boolean} sabotaged true when the sabotaged checker changed the answer
 */

/**
 * Judge one recovered state.
 * @param {object} args
 * @param {import('./store.js').Mutation[]} args.mutations
 * @param {Map<string,string>[]} args.prefixes from prefixStates()
 * @param {number} args.crashPoint
 * @param {import('./store.js').Recovery} args.recovery
 * @param {import('./bugs.js').BuildFlags} [args.flags]
 * @returns {Verdict}
 */
export function validate({ mutations, prefixes, crashPoint, recovery, flags = correctBuild() }) {
  const window = legalWindow(mutations, crashPoint);
  const base = {
    window, matchedPrefix: /** @type {number|null} */ (null),
    nearestPrefix: window.acked, diff: /** @type {DiffEntry[]} */ ([]), sabotaged: false,
  };

  if (recovery.threw !== null) {
    return {
      ...base, verdict: 'corrupt',
      reason: 'recovery threw instead of recovering: ' + recovery.threw,
      diff: diffState(prefixes[window.acked], recovery.state),
    };
  }

  for (let t = window.acked; t <= window.issued; t++) {
    if (sameState(recovery.state, prefixes[t])) {
      return {
        ...base, verdict: 'consistent', matchedPrefix: t,
        reason: 'state after ' + t + ' of ' + mutations.length + ' mutations',
      };
    }
  }

  // Not a legal state. Is it a legal state of the WRONG LENGTH -- i.e. did the
  // store lose writes it had already acknowledged? That is the branch the
  // sabotaged checker forgives, and the only one.
  let lostAcked = -1;
  for (let t = 0; t < window.acked; t++) {
    if (sameState(recovery.state, prefixes[t])) { lostAcked = t; break; }
  }
  if (lostAcked >= 0 && flags.checkerAcceptCorrupt) {
    return {
      ...base, verdict: 'consistent', matchedPrefix: lostAcked, sabotaged: true,
      reason: 'SABOTAGED: accepted a recovery missing ' + (window.acked - lostAcked) + ' acknowledged mutation(s)',
    };
  }

  // Diff against the CLOSEST legal state, not simply the earliest one: a value
  // whose bytes are wrong should read as one wrong value, not as the whole
  // workload having been replayed differently.
  let nearestPrefix = window.acked;
  let diff = diffState(prefixes[window.acked], recovery.state);
  for (let t = window.acked + 1; t <= window.issued; t++) {
    const d = diffState(prefixes[t], recovery.state);
    // Ties go to the LATER prefix on purpose. A torn value differs from the
    // legal state either way; comparing against the more advanced one shows it
    // as one value with the wrong bytes instead of as a phantom write.
    if (d.length <= diff.length) { diff = d; nearestPrefix = t; }
  }
  const reason = lostAcked >= 0
    ? 'lost ' + (window.acked - lostAcked) + ' acknowledged mutation(s): recovered the state after ' +
      lostAcked + ' but ' + window.acked + ' had been acknowledged'
    : 'recovered a state the API never produced: it matches no prefix of the workload';
  return { ...base, verdict: 'corrupt', reason, nearestPrefix, diff };
}
