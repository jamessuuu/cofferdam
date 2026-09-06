// Every planted fixture must still fire, and the correct build must still be
// clean. These are the two numbers the README leads with, so CI asserts them
// against the same recipes the README quotes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES, CONTROL_SEEDS, BOUND_SWEEP } from '../src/fixtures.js';
import { runFixture, runControl, runBoundSweep, runSabotage } from '../src/cli.js';
import { BUG_IDS } from '../src/bugs.js';

for (const fixture of FIXTURES) {
  test('fixture fires: ' + fixture.id, () => {
    const r = runFixture(fixture);
    assert.ok(r.seedsCorrupt >= fixture.floor,
      fixture.id + ' fired on ' + r.seedsCorrupt + ' of ' + r.seedsTried +
      ' seeds, below its floor of ' + fixture.floor);
    assert.ok(r.corruptPoints > 0);
    assert.ok(r.seedsCorrupt <= r.seedsTried);
  });
}

test('every fixture in the table is a real build flag, and every store bug has a recipe', () => {
  for (const f of FIXTURES) assert.ok(BUG_IDS.includes(f.id), f.id + ' is not a build flag');
  const covered = new Set(FIXTURES.map((f) => f.id));
  for (const id of BUG_IDS) {
    if (id === 'checker-accept-corrupt') continue; // measured differentially, see sabotage.test.js
    assert.ok(covered.has(id), id + ' is planted but has no reproduction recipe');
  }
});

test('the negative control is clean', () => {
  // A smaller sweep than the README's, so the suite stays quick; `npm run
  // control` runs the full CONTROL_SEEDS and prints the number the README uses.
  const seeds = Math.min(60, CONTROL_SEEDS);
  const control = runControl(seeds);
  assert.equal(control.corrupt, 0, 'the correct build produced a corruption');
  assert.equal(control.unverifiable, 0, 'the correct build left a crash point unproven');
  assert.ok(control.crashPoints > 3000, 'expected thousands of crash points, got ' + control.crashPoints);
  assert.ok(control.schedules > control.crashPoints);
});

test('the reorder bound sweep behaves monotonically', () => {
  const sweep = runBoundSweep();
  assert.equal(sweep.length, BOUND_SWEEP.length);
  for (let i = 1; i < sweep.length; i++) {
    assert.ok(sweep[i].unverifiable <= sweep[i - 1].unverifiable,
      'raising the bound must never create an unverifiable crash point');
    assert.equal(sweep[i].corrupt, 0);
  }
  assert.ok(sweep[0].unverifiable > 0, 'a bound of zero must leave crash points unproven');
  assert.equal(sweep[sweep.length - 1].unverifiable, 0);
});

test('the sabotage differential the CLI prints is the one the tests assert', () => {
  const s = runSabotage();
  assert.ok(s.honest > 0);
  assert.equal(s.sabotaged, 0);
  assert.ok(s.targetedHonest > 0);
  assert.equal(s.targetedSabotaged, s.targetedHonest);
});
