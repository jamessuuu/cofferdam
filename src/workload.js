// Deterministic workloads.
//
// A seed picks the workload. It does NOT pick the crash schedule: the schedules
// are a total enumeration indexed by integers, which is the whole difference
// between this project and a fuzzer. Nothing below the CLI reads a clock, calls
// Math.random, or sets a timer, and test/determinism.test.js fails the build if
// one appears.
//
// Some values are deliberately larger than a sector. A write that fits in one
// sector cannot tear, so a workload of short values would enumerate a torn-write
// space that is empty and then report that nothing was found there.

import { Device, SECTOR } from './device.js';
import { Store, enc } from './store.js';
import { correctBuild } from './bugs.js';
import { crc32 } from './crc32.js';

/** Value widths in bytes: two below a sector, two across sector boundaries. */
const WIDTHS = [4, 8, 4, SECTOR + 48, 6, 2 * SECTOR + 176, 4, SECTOR - 24];

/**
 * sfc32. Small, fast, and — the only property that matters here — identical on
 * every machine, because it is integer arithmetic with no floating point.
 * @param {number} seed
 * @returns {() => number} uniform 32-bit unsigned integers
 */
export function rng(seed) {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  let b = (seed ^ 0x243f6a88) >>> 0;
  let c = (seed ^ 0xb7e15162) >>> 0;
  let d = 1;
  const step = () => {
    const t = (a + b) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    d = (d + 0x9e3779b9) >>> 0;
    return (t + d) >>> 0;
  };
  for (let i = 0; i < 12; i++) step();
  return step;
}

/**
 * @param {string} label
 * @param {number} width
 * @returns {string}
 */
export function makeValue(label, width) {
  if (width <= label.length + 1) return label;
  return label + '#' + 'x'.repeat(width - label.length - 1);
}

/**
 * Values can be kilobytes, so reports show the label and the size rather than
 * the filler -- plus a checksum of the WHOLE value, because a torn write leaves
 * a value with the right label and the right length and the wrong bytes. A
 * summary that hid that would turn a real corruption into a diff of two
 * identical-looking strings.
 * @param {string|null} v
 * @returns {string}
 */
export function summarizeValue(v) {
  if (v === null) return '<deleted>';
  const hash = v.indexOf('#');
  const label = hash === -1 ? v : v.slice(0, hash);
  const printable = /^[\x20-\x7e]*$/.test(label) && label.length > 0 ? label : '<unprintable>';
  const sum = crc32(enc(v)).toString(16).padStart(8, '0');
  return printable + ' (' + v.length + 'B, ' + sum + ')';
}

/** @typedef {{kind:'put', key:string, value:string}|{kind:'del', key:string}|{kind:'checkpoint'}} Step */

/**
 * @typedef {object} Workload
 * @property {number} seed
 * @property {Step[]} steps
 * @property {number} mutations
 * @property {number} keys
 */

/**
 * @param {number} seed
 * @param {object} [opts]
 * @param {number} [opts.mutations] how many put/del calls
 * @param {number} [opts.keys] key-space size
 * @param {number} [opts.checkpointEvery] a checkpoint after every N mutations
 * @returns {Workload}
 */
export function makeWorkload(seed, opts = {}) {
  const mutations = opts.mutations ?? 24;
  const keys = opts.keys ?? 4;
  const checkpointEvery = opts.checkpointEvery ?? 9;
  if (!Number.isInteger(seed)) throw new TypeError('seed must be an integer');
  if (mutations < 1) throw new RangeError('a workload needs at least one mutation');
  if (keys < 1) throw new RangeError('a workload needs at least one key');
  const next = rng(seed);
  /** @type {Step[]} */
  const steps = [];
  /** @type {Set<string>} */
  const live = new Set();
  for (let i = 0; i < mutations; i++) {
    const key = 'k' + (next() % keys);
    // Delete only a key that exists, so a workload does not spend its budget on
    // no-ops that never reach the log in an interesting way.
    const wantDelete = next() % 5 === 0 && live.has(key);
    if (wantDelete) {
      steps.push({ kind: 'del', key });
      live.delete(key);
    } else {
      const width = WIDTHS[next() % WIDTHS.length];
      steps.push({ kind: 'put', key, value: makeValue('v' + (i + 1), width) });
      live.add(key);
    }
    if (checkpointEvery > 0 && (i + 1) % checkpointEvery === 0 && i + 1 < mutations) {
      steps.push({ kind: 'checkpoint' });
    }
  }
  return { seed, steps, mutations, keys };
}

/**
 * Run a workload against a fresh modeled device and return both, so the caller
 * can enumerate crash points over the recorded op stream.
 * @param {Workload} workload
 * @param {import('./bugs.js').BuildFlags} [flags]
 * @returns {{device: Device, store: Store}}
 */
export function runWorkload(workload, flags = correctBuild()) {
  const device = new Device();
  const store = new Store(device, flags);
  store.format();
  for (const step of workload.steps) {
    if (step.kind === 'put') store.put(step.key, step.value);
    else if (step.kind === 'del') store.del(step.key);
    else store.checkpoint();
  }
  return { device, store };
}
