// The checker's own contract: what a legal recovered state is, and that all
// three outcomes are reachable rather than two plus a comment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Device } from '../src/device.js';
import { Store, recover } from '../src/store.js';
import { prefixStates, legalWindow, sameState, diffState, validate } from '../src/spec.js';
import { correctBuild } from '../src/bugs.js';

/** @returns {{store: Store, device: Device}} */
function threeWrites() {
  const device = new Device();
  const store = new Store(device);
  store.format();
  store.put('a', 'one');
  store.put('b', 'two');
  store.put('c', 'three');
  return { store, device };
}

test('prefix states are the states the API can have produced', () => {
  const { store } = threeWrites();
  const prefixes = prefixStates(store.mutations);
  assert.equal(prefixes.length, 4);
  assert.equal(prefixes[0].size, 0);
  assert.deepEqual([...prefixes[2].keys()].sort(), ['a', 'b']);
});

test('the legal window is acknowledged..issued, and at most one is in flight', () => {
  const { store, device } = threeWrites();
  for (let i = 0; i <= device.ops.length; i++) {
    const w = legalWindow(store.mutations, i);
    assert.ok(w.issued - w.acked <= 1, 'a synchronous single writer cannot have two in flight');
    assert.ok(w.acked <= w.issued);
  }
});

test('a recovery inside the window is consistent', () => {
  const { store, device } = threeWrites();
  const prefixes = prefixStates(store.mutations);
  const at = device.ops.length;
  const v = validate({
    mutations: store.mutations, prefixes, crashPoint: at,
    recovery: { state: prefixes[3], lastSeq: 3, replayed: 3, stopped: 'end of log', snapshot: 'absent', threw: null },
  });
  assert.equal(v.verdict, 'consistent');
  assert.equal(v.matchedPrefix, 3);
});

test('a recovery missing an acknowledged write is corrupt, and says how many', () => {
  const { store, device } = threeWrites();
  const prefixes = prefixStates(store.mutations);
  const v = validate({
    mutations: store.mutations, prefixes, crashPoint: device.ops.length,
    recovery: { state: prefixes[1], lastSeq: 1, replayed: 1, stopped: 'end of log', snapshot: 'absent', threw: null },
  });
  assert.equal(v.verdict, 'corrupt');
  assert.match(v.reason, /lost 2 acknowledged mutation/);
});

test('a recovery containing a value the API never wrote is corrupt', () => {
  const { store, device } = threeWrites();
  const prefixes = prefixStates(store.mutations);
  const invented = new Map(prefixes[3]);
  invented.set('a', 'a value nobody ever put');
  const v = validate({
    mutations: store.mutations, prefixes, crashPoint: device.ops.length,
    recovery: { state: invented, lastSeq: 3, replayed: 3, stopped: 'end of log', snapshot: 'absent', threw: null },
  });
  assert.equal(v.verdict, 'corrupt');
  assert.match(v.reason, /never produced/);
  assert.equal(v.diff.length, 1);
  assert.equal(v.diff[0].kind, 'wrong');
});

test('recovery that throws is a durability failure, not a silent pass', () => {
  const { store, device } = threeWrites();
  const prefixes = prefixStates(store.mutations);
  const v = validate({
    mutations: store.mutations, prefixes, crashPoint: device.ops.length,
    recovery: { state: new Map(), lastSeq: 0, replayed: 0, stopped: '', snapshot: '', threw: 'boom' },
  });
  assert.equal(v.verdict, 'corrupt');
  assert.match(v.reason, /threw instead of recovering/);
});

test('diffState names what is missing, extra and wrong', () => {
  const a = new Map([['k1', 'x'], ['k2', 'y']]);
  const b = new Map([['k2', 'z'], ['k3', 'w']]);
  const d = diffState(a, b);
  assert.deepEqual(d.map((e) => [e.key, e.kind]), [['k1', 'missing'], ['k2', 'wrong'], ['k3', 'extra']]);
});

test('sameState compares by content, not by identity or order', () => {
  assert.ok(sameState(new Map([['a', '1'], ['b', '2']]), new Map([['b', '2'], ['a', '1']])));
  assert.ok(!sameState(new Map([['a', '1']]), new Map([['a', '2']])));
  assert.ok(!sameState(new Map([['a', '1']]), new Map()));
});

test('the validator judges a real recovery of a real image', () => {
  const { store, device } = threeWrites();
  const prefixes = prefixStates(store.mutations);
  const recovery = recover(new Map(), correctBuild());
  const v = validate({ mutations: store.mutations, prefixes, crashPoint: device.ops.length, recovery });
  assert.equal(v.verdict, 'corrupt', 'losing everything after three acknowledged writes is not consistent');
});
