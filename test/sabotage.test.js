// The fixture that matters most.
//
// Four of the planted bugs break the store and the checker catches them. That
// says nothing about the checker's `corrupt` path being CORRECT -- only that it
// fires. This fixture breaks the CHECKER and asserts that the same enumeration,
// over the same genuinely broken store, then reports nothing at all.
//
// If this test ever passes with the flag off, the corrupt verdict has stopped
// carrying its own weight and every other number in the project is suspect.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkload } from '../src/workload.js';
import { enumerate } from '../src/enumerate.js';
import { parseBuildFlags, BUGS } from '../src/bugs.js';
import { prefixStates, validate } from '../src/spec.js';
import { Device } from '../src/device.js';
import { Store } from '../src/store.js';

const LOSSY = parseBuildFlags('no-fsync-before-ack');
const SABOTAGED = { ...LOSSY, checkerAcceptCorrupt: true };

test('the sabotaged checker reports a genuinely broken store as clean', () => {
  let honestTotal = 0;
  let sabotagedTotal = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const workload = makeWorkload(seed);
    const honest = enumerate({ workload, flags: LOSSY });
    const blind = enumerate({ workload, flags: SABOTAGED });
    assert.ok(honest.corrupt > 0, 'seed ' + seed + ': the honest checker must find the lost writes');
    assert.equal(blind.corrupt, 0, 'seed ' + seed + ': the sabotage must hide every one of them');
    honestTotal += honest.corrupt;
    sabotagedTotal += blind.corrupt;
  }
  assert.ok(honestTotal >= 8);
  assert.equal(sabotagedTotal, 0);
});

test('the sabotage is targeted at one branch, not a blanket pass', () => {
  // It forgives a recovery that lost acknowledged writes. It must NOT forgive a
  // recovery that invented a value, or it would prove nothing about the branch.
  const invented = parseBuildFlags('checksum-skipped');
  const workload = makeWorkload(6);
  const honest = enumerate({ workload, flags: invented });
  const blind = enumerate({ workload, flags: { ...invented, checkerAcceptCorrupt: true } });
  assert.ok(honest.corrupt > 0, 'seed 6 is the pinned reproduction for checksum-skipped');
  assert.equal(blind.corrupt, honest.corrupt,
    'an invented value must still be caught, otherwise the sabotage is just "return consistent"');
});

test('the sabotage cannot manufacture a corruption on a correct build', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const workload = makeWorkload(seed);
    const blind = enumerate({ workload, flags: { ...parseBuildFlags('correct'), checkerAcceptCorrupt: true } });
    assert.equal(blind.corrupt, 0);
    assert.equal(blind.unverifiable, 0);
  }
});

test('the sabotaged verdict is labelled, so it can never be mistaken for a real pass', () => {
  const device = new Device();
  const store = new Store(device);
  store.format();
  store.put('a', 'one');
  store.put('b', 'two');
  const prefixes = prefixStates(store.mutations);
  const recovery = {
    state: prefixes[0], lastSeq: 0, replayed: 0,
    stopped: 'end of log', snapshot: 'absent', threw: null,
  };
  const args = { mutations: store.mutations, prefixes, crashPoint: device.ops.length, recovery };
  const honest = validate({ ...args });
  const blind = validate({ ...args, flags: SABOTAGED });
  assert.equal(honest.verdict, 'corrupt');
  assert.equal(honest.sabotaged, false);
  assert.equal(blind.verdict, 'consistent');
  assert.equal(blind.sabotaged, true);
  assert.match(blind.reason, /^SABOTAGED/);
});

test('the sabotage is declared in the fixture list as breaking the checker', () => {
  const bug = BUGS.find((b) => b.id === 'checker-accept-corrupt');
  assert.ok(bug, 'the sabotaged checker must be listed with the others, not hidden');
  assert.equal(bug.breaks, 'checker');
  assert.equal(BUGS.filter((b) => b.breaks === 'checker').length, 1);
  assert.equal(BUGS.filter((b) => b.breaks === 'store').length, 4);
});
