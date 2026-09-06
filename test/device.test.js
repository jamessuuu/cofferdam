// The crash model. If these are wrong, every verdict cofferdam produces is
// wrong in the same direction and nothing else in the suite would notice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Device, SECTOR, materialize, durableBefore, inflightAt, sectorsOf, describeOp } from '../src/device.js';
import { enc, dec } from '../src/store.js';

/** Four unwritten bytes read back as zeros, built rather than pasted so this file holds no NUL byte. */
const NUL4 = String.fromCharCode(0).repeat(4);

/** @param {number} n @param {number} b @returns {Uint8Array} */
function bytes(n, b) {
  return new Uint8Array(n).fill(b);
}

/** @param {Map<string,Uint8Array>} image @param {string} name @returns {string} */
function text(image, name) {
  const f = image.get(name);
  return f === undefined ? '<absent>' : dec(f);
}

test('an fsync makes earlier writes to that file durable, and nothing else', () => {
  const d = new Device();
  d.create('a');
  d.create('b');
  d.fsyncdir();
  d.write('a', 0, enc('AAAA'));
  d.write('b', 0, enc('BBBB'));
  d.fsync('a');
  const durable = durableBefore(d.ops, d.ops.length);
  assert.equal(durable[3], true, 'the write to a is covered by the fsync on a');
  assert.equal(durable[4], false, 'the write to b is not');
});

test('un-fsynced writes may land in any subset', () => {
  const d = new Device();
  d.create('a');
  d.fsyncdir();
  d.write('a', 0, enc('1111'));
  d.write('a', 4, enc('2222'));
  const flight = inflightAt(d.ops, d.ops.length);
  assert.deepEqual(flight.data, [2, 3]);
  assert.equal(text(materialize(d.ops, d.ops.length, { persist: [], tear: null, id: 'none' }), 'a'), '');
  assert.equal(text(materialize(d.ops, d.ops.length, { persist: [3], tear: null, id: 'second' }), 'a'), NUL4 + '2222');
  assert.equal(text(materialize(d.ops, d.ops.length, { persist: [2, 3], tear: null, id: 'both' }), 'a'), '11112222');
});

test('metadata lands as a prefix, because a journal commits in order', () => {
  const d = new Device();
  d.create('x');
  d.create('y');
  const flight = inflightAt(d.ops, d.ops.length);
  assert.deepEqual(flight.meta, [0, 1]);
  assert.deepEqual(flight.data, []);
});

test('a write to a file whose directory entry never landed is dropped, not an error', () => {
  const d = new Device();
  d.create('a');
  d.write('a', 0, enc('data'));
  // Persist the write but not the create: physically, blocks nothing references.
  const image = materialize(d.ops, d.ops.length, { persist: [1], tear: null, id: 'orphan' });
  assert.equal(image.has('a'), false);
});

test('a write larger than a sector tears at a sector boundary', () => {
  const d = new Device();
  d.create('a');
  d.fsyncdir();
  d.write('a', 0, bytes(SECTOR * 2 + 10, 0x41));
  assert.equal(sectorsOf(d.ops[2]), 3);
  const torn = materialize(d.ops, d.ops.length, { persist: [2], tear: { index: 2, sectors: 1 }, id: 't' });
  assert.equal(/** @type {Uint8Array} */ (torn.get('a')).length, SECTOR);
  const whole = materialize(d.ops, d.ops.length, { persist: [2], tear: null, id: 'w' });
  assert.equal(/** @type {Uint8Array} */ (whole.get('a')).length, SECTOR * 2 + 10);
});

test('a write beyond the end of a file zero-fills the gap, as NTFS does', () => {
  const d = new Device();
  d.create('a');
  d.write('a', 10, enc('XY'));
  d.fsync('a');
  const image = materialize(d.ops, d.ops.length, { persist: [0], tear: null, id: 'z' });
  const f = /** @type {Uint8Array} */ (image.get('a'));
  assert.equal(f.length, 12);
  assert.deepEqual([...f.subarray(0, 10)], new Array(10).fill(0));
});

test('rename moves the bytes and truncate keeps the prefix', () => {
  const d = new Device();
  d.create('a');
  d.write('a', 0, enc('abcdef'));
  d.fsync('a');
  d.rename('a', 'b');
  d.fsyncdir();
  d.truncate('b', 3);
  d.fsync('b');
  const image = materialize(d.ops, d.ops.length, { persist: [], tear: null, id: 'all-durable' });
  assert.equal(text(image, 'a'), '<absent>');
  assert.equal(text(image, 'b'), 'abc');
});

test('materialize is pure: same inputs, byte-identical output, and the ops are untouched', () => {
  const d = new Device();
  d.create('a');
  d.fsyncdir();
  d.write('a', 0, enc('hello'));
  const schedule = { persist: [2], tear: null, id: 'p' };
  const one = materialize(d.ops, d.ops.length, schedule);
  const two = materialize(d.ops, d.ops.length, schedule);
  assert.deepEqual([...(/** @type {Uint8Array} */ (one.get('a')))], [...(/** @type {Uint8Array} */ (two.get('a')))]);
  assert.equal(d.ops.length, 3, 'materialize must not append to the recording');
});

test('every op kind describes itself', () => {
  const d = new Device();
  d.create('a');
  d.write('a', 4, enc('zz'));
  d.truncate('a', 1);
  d.rename('a', 'b');
  d.unlink('b');
  d.fsync('b');
  d.fsyncdir();
  const described = d.ops.map(describeOp);
  assert.deepEqual(described, [
    'create a', 'write a @4 +2B', 'truncate a -> 1B', 'rename a -> b', 'unlink b', 'fsync b', 'fsync <dir>',
  ]);
});
