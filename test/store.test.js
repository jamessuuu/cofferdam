// The store and its recovery, tested directly rather than only through the
// enumerator, so a recovery bug reports as a recovery bug.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Device, SECTOR, materialize } from '../src/device.js';
import { Store, recover, encodeRecord, encodeSnapshot, enc, LOG, SNAP } from '../src/store.js';
import { correctBuild, parseBuildFlags } from '../src/bugs.js';

/** @param {Device} d @returns {Map<string, Uint8Array>} everything landed */
function whole(d) {
  const persist = [];
  for (let i = 0; i < d.ops.length; i++) persist.push(i);
  return materialize(d.ops, d.ops.length, { persist, tear: null, id: 'all' });
}

test('a clean shutdown recovers exactly what was written', () => {
  const d = new Device();
  const s = new Store(d);
  s.format();
  s.put('a', 'one');
  s.put('b', 'two');
  s.del('a');
  s.put('c', 'three');
  const r = recover(whole(d));
  assert.equal(r.threw, null);
  assert.deepEqual([...r.state.entries()].sort(), [['b', 'two'], ['c', 'three']]);
  assert.equal(r.replayed, 4);
});

test('a checkpoint folds the log into a snapshot and recovery still agrees', () => {
  const d = new Device();
  const s = new Store(d);
  s.format();
  s.put('a', 'one');
  s.put('b', 'two');
  s.checkpoint();
  s.put('c', 'three');
  const r = recover(whole(d));
  assert.deepEqual([...r.state.entries()].sort(), [['a', 'one'], ['b', 'two'], ['c', 'three']]);
  assert.match(r.snapshot, /^applied/);
  assert.equal(r.replayed, 1, 'only the post-checkpoint record is replayed');
});

test('a torn record at the tail is discarded, not replayed', () => {
  const d = new Device();
  const s = new Store(d);
  s.format();
  s.put('a', 'one');
  s.put('b', 'x'.repeat(SECTOR + 40));
  // Land only the first sector of the second record.
  const writeOp = d.ops.findIndex((o, i) => o.k === 'write' && i > 2);
  const image = materialize(d.ops, d.ops.length, {
    persist: [0, 1, 2, 3, 4, 5].filter((i) => i < d.ops.length),
    tear: { index: writeOp, sectors: 1 }, id: 'torn',
  });
  const r = recover(image);
  assert.equal(r.state.has('b'), false, 'the torn record must not be applied');
  assert.match(r.stopped, /torn record|checksum|bad magic|end of log/);
});

test('a stale record left by an un-truncated log is refused by the sequence rule', () => {
  const d = new Device();
  const s = new Store(d);
  s.format();
  s.put('a', 'one');
  s.put('b', 'two');
  s.checkpoint();
  s.put('c', 'three');
  // A crash where the truncate never landed: the old records are still there
  // behind the new one.
  const truncateOp = d.ops.findIndex((o) => o.k === 'truncate');
  const persist = [];
  for (let i = 0; i < d.ops.length; i++) if (i !== truncateOp) persist.push(i);
  const r = recover(materialize(d.ops, d.ops.length, { persist, tear: null, id: 'no-truncate' }));
  assert.deepEqual([...r.state.entries()].sort(), [['a', 'one'], ['b', 'two'], ['c', 'three']]);
  assert.match(r.stopped, /sequence break|bad magic|end of log/);
});

test('an empty image recovers to an empty state rather than throwing', () => {
  const r = recover(new Map());
  assert.equal(r.threw, null);
  assert.equal(r.state.size, 0);
  assert.equal(r.snapshot, 'absent');
});

test('a snapshot of garbage is rejected and the log is still replayed', () => {
  const image = new Map();
  image.set(SNAP, enc('this is not a snapshot at all'));
  image.set(LOG, encodeRecord(1, 'k', 'v'));
  const r = recover(image);
  assert.match(r.snapshot, /rejected/);
  assert.deepEqual([...r.state.entries()], [['k', 'v']]);
});

test('recovery survives every truncation of a real log', () => {
  const d = new Device();
  const s = new Store(d);
  s.format();
  s.put('a', 'one');
  s.put('b', 'two');
  s.put('c', 'three');
  const log = /** @type {Uint8Array} */ (whole(d).get(LOG));
  for (let cut = 0; cut <= log.length; cut++) {
    const image = new Map([[LOG, log.subarray(0, cut)]]);
    const r = recover(image);
    assert.equal(r.threw, null, 'recovery threw at cut ' + cut);
    // Whatever it recovered must be a prefix of a/b/c.
    const keys = [...r.state.keys()].sort().join(',');
    assert.ok(['', 'a', 'a,b', 'a,b,c'].includes(keys), 'cut ' + cut + ' recovered ' + keys);
  }
});

test('the checksum covers the body, and the planted bug moves it to the header', () => {
  const good = encodeRecord(7, 'k', 'value');
  const bad = encodeRecord(7, 'k', 'value', parseBuildFlags('torn-record-accepted'));
  assert.notDeepEqual([...good.subarray(4, 8)], [...bad.subarray(4, 8)],
    'the two builds must not write the same checksum, or the fixture is not a format bug');
});

test('a snapshot round-trips through its own encoding', () => {
  const state = new Map([['k0', 'a'], ['k1', 'b'.repeat(900)]]);
  const image = new Map([[SNAP, encodeSnapshot(state, 42, correctBuild())]]);
  const r = recover(image);
  assert.deepEqual([...r.state.entries()].sort(), [...state.entries()].sort());
  assert.equal(r.lastSeq, 42);
});

test('a key or value beyond the field width is refused at encode time', () => {
  assert.throws(() => encodeRecord(1, 'k', 'v'.repeat(70000)), RangeError);
});
