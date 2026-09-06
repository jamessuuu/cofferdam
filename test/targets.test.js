// The three real targets, exercised for real in the suite -- a reduced sweep,
// because each crash point is a spawned process, but the same code paths the
// `cofferdam targets` command runs.
//
// The measurement this file exists for is the last one: the SAME broken build,
// on the SAME real filesystem, with real SIGKILLs, is clean -- and the modeled
// device finds hundreds of corruptions in it. That gap is the argument for the
// whole project, so it is asserted rather than asserted-in-prose.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fidelityTarget, realFsTarget, sqliteTarget, sqliteAvailable, realFsBlindSpot } from '../src/targets/run.js';
import { parseBuildFlags } from '../src/bugs.js';
import { makeWorkload } from '../src/workload.js';
import { enumerate } from '../src/enumerate.js';

test('T3: the model predicts the bytes NTFS actually writes', () => {
  const r = fidelityTarget(1);
  assert.equal(r.verdict, 'consistent', r.detail);
  assert.ok(r.checked > 40, 'the fidelity check must cover the whole op stream');
});

test('T3 reports the platform limitations it hit rather than swallowing them', () => {
  const r = fidelityTarget(1);
  if (process.platform === 'win32') {
    assert.ok(
      r.notes.some((n) => /fsync on a directory is unavailable/.test(n)),
      'on Windows the directory barrier cannot be issued and the run must say so'
    );
  }
  for (const note of r.notes) assert.ok(note.length > 20, 'a note must state something');
});

test('T1: the correct store survives real process kills on a real filesystem', () => {
  const r = realFsTarget({ seed: 1, every: 6 });
  assert.equal(r.verdict, 'consistent', r.detail);
  assert.ok(r.killPhase && r.killPhase.checked >= 8, 'not enough real crash points were exercised');
  assert.equal(r.killPhase.corrupt, 0);
});

test('T1: modeled crash images agree with real files, byte for byte and verdict for verdict', () => {
  const r = realFsTarget({ seed: 1, every: 6 });
  assert.ok(r.imagePhase && r.imagePhase.checked > 10);
  assert.equal(r.imagePhase.mismatches, 0,
    'a verdict that changes when the same bytes come from a file is not a verdict');
});

test('T2: SQLite at synchronous=FULL keeps every committed transaction', { skip: !sqliteAvailable() }, () => {
  const r = sqliteTarget({ seed: 2, sync: 'FULL' });
  assert.equal(r.verdict, 'consistent', r.detail);
  assert.ok(r.checked > 10, 'expected one crash point per statement');
});

test('T2: SQLite at synchronous=OFF never invents a state, even with a torn WAL', { skip: !sqliteAvailable() }, () => {
  const r = sqliteTarget({ seed: 2, sync: 'OFF', tears: 2 });
  assert.equal(r.verdict, 'consistent', r.detail);
  assert.ok(r.notes.some((n) => /FALSE POSITIVE REMOVED/.test(n)),
    'the removed false positive must stay on the record, not disappear once it is fixed');
});

test('T2 is unverifiable rather than passing when node:sqlite is absent', { skip: sqliteAvailable() }, () => {
  const r = sqliteTarget({ seed: 2, sync: 'FULL' });
  assert.equal(r.verdict, 'unverifiable');
  assert.match(r.detail, /not present in this Node build/);
});

test('THE BLIND SPOT: a real process kill cannot see a missing fsync, and the enumerator can', () => {
  const flags = parseBuildFlags('no-fsync-before-ack');
  const blind = realFsBlindSpot({ seed: 1, flags, every: 4 });
  assert.ok(blind.kill.checked >= 8, 'not enough real crash points');
  assert.equal(blind.kill.corrupt, 0,
    'if a process kill ever DOES lose an un-fsynced write, this whole argument changes and the ' +
    'README must be rewritten');
  assert.ok(blind.acknowledged > 10, 'the workload must acknowledge writes for the point to hold');

  const modeled = enumerate({ workload: makeWorkload(1), flags });
  assert.ok(modeled.corrupt > 10,
    'the modeled device must find what the real kill cannot: got ' + modeled.corrupt);
});
