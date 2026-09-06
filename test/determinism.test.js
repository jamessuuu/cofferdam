// Determinism is a claim the README makes, so it is a claim the build enforces
// rather than a comment somebody has to keep believing.
//
// Two halves: no source file below the CLI may reach for a clock, a random
// number or a timer; and running the same thing twice must produce the same
// bytes. `process.hrtime` is permitted and separately checked, because it
// reports elapsed time and is never allowed to change an outcome.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorkload, rng } from '../src/workload.js';
import { enumerate } from '../src/enumerate.js';
import { parseBuildFlags } from '../src/bugs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

/** @param {string} dir @param {string[]} [acc] @returns {string[]} */
function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const FORBIDDEN = [
  [/\bDate\s*\.\s*now\s*\(/, 'Date.now()'],
  [/\bnew\s+Date\s*\(/, 'new Date()'],
  [/\bMath\s*\.\s*random\s*\(/, 'Math.random()'],
  [/\bsetTimeout\s*\(/, 'setTimeout()'],
  [/\bsetInterval\s*\(/, 'setInterval()'],
  [/\bperformance\s*\.\s*now\s*\(/, 'performance.now()'],
];

test('no source file reads a clock, a random number, or a timer', () => {
  /** @type {string[]} */
  const problems = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(\/\/|\*)/.test(lines[i])) continue;
      for (const [re, name] of FORBIDDEN) {
        if (re.test(lines[i])) problems.push('src/' + rel + ':' + (i + 1) + ' uses ' + name);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('hrtime is used for reporting only: it never changes an outcome', () => {
  const workload = makeWorkload(9);
  const flags = parseBuildFlags('torn-record-accepted');
  const a = enumerate({ workload, flags });
  const b = enumerate({ workload, flags });
  assert.notEqual(a.ms, undefined);
  const strip = (/** @type {any} */ r) => JSON.stringify({ ...r, ms: 0 });
  assert.equal(strip(a), strip(b), 'two runs of one workload must be identical apart from elapsed time');
});

test('the generator is integer arithmetic and gives the same stream every time', () => {
  const a = rng(1234);
  const b = rng(1234);
  const c = rng(1235);
  const first = [];
  for (let i = 0; i < 8; i++) {
    const x = a();
    assert.ok(Number.isInteger(x) && x >= 0 && x <= 0xffffffff, 'values must be uint32');
    assert.equal(x, b());
    first.push(x);
  }
  const other = [];
  for (let i = 0; i < 8; i++) other.push(c());
  assert.notDeepEqual(first, other, 'different seeds must give different streams');
});

test('a workload is a pure function of its seed', () => {
  assert.deepEqual(makeWorkload(77), makeWorkload(77));
  assert.notDeepEqual(makeWorkload(77).steps, makeWorkload(78).steps);
});

test('a workload refuses inputs it cannot honour', () => {
  assert.throws(() => makeWorkload(1.5), TypeError);
  assert.throws(() => makeWorkload(1, { mutations: 0 }), RangeError);
  assert.throws(() => makeWorkload(1, { keys: 0 }), RangeError);
});
