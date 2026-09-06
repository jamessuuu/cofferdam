// The enumerator: that it visits every crash point, that its schedule space is
// exhaustive inside the bound, and that going over the bound produces
// `unverifiable` rather than a quiet pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflightAt } from '../src/device.js';
import { makeWorkload, runWorkload } from '../src/workload.js';
import { enumerate, replayOne, scheduleSpace, DEFAULT_BOUND } from '../src/enumerate.js';
import { parseBuildFlags, correctBuild } from '../src/bugs.js';

test('there is exactly one crash point per op boundary, plus the end', () => {
  const workload = makeWorkload(3);
  const { device } = runWorkload(workload);
  const r = enumerate({ workload });
  assert.equal(r.crashPoints, device.ops.length + 1);
  assert.deepEqual(r.points.map((p) => p.i), r.points.map((_p, i) => i));
});

test('inside the bound the subset space is complete: 2^n times the metadata prefixes', () => {
  const workload = makeWorkload(3);
  const { device } = runWorkload(workload);
  for (let i = 0; i <= device.ops.length; i++) {
    const flight = inflightAt(device.ops, i);
    if (flight.data.length > DEFAULT_BOUND) continue;
    const space = scheduleSpace(device.ops, flight, DEFAULT_BOUND);
    assert.equal(space.exhaustive, true);
    const base = (flight.meta.length + 1) * 2 ** flight.data.length;
    assert.ok(space.schedules.length >= base,
      'crash point ' + i + ': ' + space.schedules.length + ' schedules for ' + base + ' subsets');
    assert.equal(new Set(space.schedules.map((s) => s.id)).size, space.schedules.length,
      'schedule ids must be unique so a replay command is unambiguous');
  }
});

test('over the bound the crash point is unverifiable with a stated reason', () => {
  const workload = makeWorkload(3);
  const r = enumerate({ workload, bound: 0 });
  const unver = r.points.filter((p) => p.verdict === 'unverifiable');
  assert.ok(unver.length > 0, 'a bound of zero must leave something unproven');
  for (const p of unver) assert.match(p.reason, /reorder bound exceeded/);
  assert.equal(r.corrupt, 0, 'the correct build is still not corrupt, only unproven');
});

test('raising the bound converts unverifiable into consistent and never into corrupt', () => {
  const workload = makeWorkload(5);
  let previousUnverifiable = Infinity;
  for (const bound of [0, 1, 2, 4]) {
    const r = enumerate({ workload, bound });
    assert.equal(r.corrupt, 0);
    assert.ok(r.unverifiable <= previousUnverifiable);
    previousUnverifiable = r.unverifiable;
    assert.equal(r.consistent + r.corrupt + r.unverifiable, r.crashPoints);
  }
  assert.equal(previousUnverifiable, 0, 'at the default bound the correct build is fully enumerated');
});

test('the enumeration is a pure function of its inputs', () => {
  const workload = makeWorkload(11);
  const a = enumerate({ workload, flags: parseBuildFlags('no-fsync-before-ack') });
  const b = enumerate({ workload, flags: parseBuildFlags('no-fsync-before-ack') });
  assert.equal(a.schedules, b.schedules);
  assert.deepEqual(
    a.points.map((p) => [p.i, p.verdict, p.schedules, p.corruptSchedules]),
    b.points.map((p) => [p.i, p.verdict, p.schedules, p.corruptSchedules])
  );
  assert.deepEqual(a.firstFinding, b.firstFinding);
});

test('a bad bound is refused rather than silently clamped', () => {
  assert.throws(() => enumerate({ workload: makeWorkload(1), bound: -1 }), RangeError);
  assert.throws(() => enumerate({ workload: makeWorkload(1), bound: 1.5 }), RangeError);
});

test('replayOne reproduces the exact cell the enumeration reported', () => {
  const workload = makeWorkload(1);
  const flags = parseBuildFlags('rename-before-fsync');
  const r = enumerate({ workload, flags });
  const finding = r.firstFinding;
  assert.ok(finding, 'this fixture must produce a finding');
  const cell = replayOne({ workload, flags, crashPoint: finding.crashPoint, scheduleId: finding.schedule });
  assert.equal(cell.verdict.verdict, 'corrupt');
  assert.equal(cell.verdict.reason, finding.reason);
});

test('replayOne refuses a crash point or schedule that does not exist', () => {
  const workload = makeWorkload(1);
  assert.throws(() => replayOne({ workload, crashPoint: 99999 }), /out of range/);
  assert.throws(() => replayOne({ workload, crashPoint: 2, scheduleId: 'nonsense' }), /no schedule/);
});

test('the correct build survives every crash point of many seeds', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const r = enumerate({ workload: makeWorkload(seed), flags: correctBuild() });
    assert.equal(r.corrupt, 0, 'seed ' + seed + ': ' + (r.firstFinding?.reason ?? ''));
    assert.equal(r.unverifiable, 0, 'seed ' + seed + ' left crash points unproven');
  }
});
