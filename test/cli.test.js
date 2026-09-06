// Release-standard row R6, proven behaviourally.
//
// Every one of these runs the real entry point in a real child process against
// a real bad input and asserts a stated error, a non-zero exit, and no stack
// trace. A try/catch that swallows would pass a unit test and fail this.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'src', 'cli.js');

/** A V8 frame, or an internal Node frame. Either means the error escaped. */
const STACK_TRACE = /\n\s+at\s+.+:\d+:\d+\)?|node:internal\//;

/** @param {string[]} args @returns {{status:number|null, stdout:string, stderr:string}} */
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** @param {{status:number|null, stdout:string, stderr:string}} r @param {RegExp} says */
function assertStatedError(r, says) {
  assert.notEqual(r.status, 0, 'expected a non-zero exit, got ' + r.status);
  assert.match(r.stderr, /^cofferdam: /m, 'the error must be stated, not implied');
  assert.match(r.stderr, says);
  assert.ok(!STACK_TRACE.test(r.stderr), 'a stack trace escaped:\n' + r.stderr);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cofferdam-cli-'));
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* disposable */ } });

test('hostile input: a file that does not exist', () => {
  assertStatedError(run(['verify', path.join(tmp, 'nope.json')]), /no such file/);
});

test('hostile input: a malformed file', () => {
  const f = path.join(tmp, 'malformed.json');
  fs.writeFileSync(f, '{ "control": this is not json at all');
  assertStatedError(run(['verify', f]), /not valid JSON/);
});

test('hostile input: an empty file', () => {
  const f = path.join(tmp, 'empty.json');
  fs.writeFileSync(f, '');
  assertStatedError(run(['verify', f]), /is empty/);
});

test('hostile input: a file far larger than expected', () => {
  const f = path.join(tmp, 'huge.json');
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const fd = fs.openSync(f, 'w');
  try { for (let i = 0; i < 20; i++) fs.writeSync(fd, chunk); } finally { fs.closeSync(fd); }
  assertStatedError(run(['verify', f]), /the limit is \d+ bytes/);
});

test('hostile input: a directory where a file was expected', () => {
  assertStatedError(run(['verify', tmp]), /is a directory/);
});

test('hostile input: valid JSON that is not a crash report', () => {
  const f = path.join(tmp, 'wrong-shape.json');
  fs.writeFileSync(f, '[1, 2, 3]');
  assertStatedError(run(['verify', f]), /not a crash report|expected an object/);
  const g = path.join(tmp, 'wrong-keys.json');
  fs.writeFileSync(g, '{"hello": "world"}');
  assertStatedError(run(['verify', g]), /not a cofferdam crash report/);
});

test('hostile input: wrong-type arguments', () => {
  assertStatedError(run(['enumerate', '--seed', 'banana']), /--seed must be an integer, got "banana"/);
  assertStatedError(run(['enumerate', '--bound', 'lots']), /--bound must be an integer/);
  assertStatedError(run(['enumerate', '--bound', '-3']), /--bound must be zero or more/);
  assertStatedError(run(['enumerate', '--bound', '40']), /ceiling is 16/);
  assertStatedError(run(['control', '--seeds', '0']), /--seeds must be at least 1/);
});

test('hostile input: an unknown build flag lists the real ones', () => {
  const r = run(['enumerate', '--build', 'not-a-bug']);
  assertStatedError(r, /unknown build flag "not-a-bug"/);
  assert.match(r.stderr, /no-fsync-before-ack/);
});

test('hostile input: unknown commands and options', () => {
  assertStatedError(run(['frobnicate']), /unknown command "frobnicate"/);
  assertStatedError(run(['enumerate', '--wat']), /unknown option "--wat"/);
  assertStatedError(run(['enumerate', '--seed']), /option "--seed" needs a value/);
  assertStatedError(run(['verify']), /verify needs a file/);
  assertStatedError(run(['replay', '--seed', '1']), /replay needs --point/);
  assertStatedError(run(['replay', '--point', '99999']), /out of range/);
});

test('no arguments prints usage and exits non-zero; --help exits zero', () => {
  const bare = run([]);
  assert.equal(bare.status, 1);
  assert.match(bare.stdout, /cofferdam verify <crashes\.json>/);
  const help = run(['--help']);
  assert.equal(help.status, 0);
});

test('the demo runs from a clean checkout and shows a corruption', () => {
  const r = run(['demo']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /corrupt recovery, on purpose/);
  assert.match(r.stdout, /crash point \d+, interrupting:/);
  assert.match(r.stdout, /0 corrupt/, 'the same workload on the correct build must be clean');
});

test('bugs lists all five fixtures, including the sabotaged checker', () => {
  const r = run(['bugs']);
  assert.equal(r.status, 0);
  for (const id of ['no-fsync-before-ack', 'torn-record-accepted', 'checksum-skipped',
    'rename-before-fsync', 'checker-accept-corrupt']) {
    assert.match(r.stdout, new RegExp(id));
  }
});

test('enumerate --json is machine-readable and self-consistent', () => {
  const r = run(['enumerate', '--seed', '1', '--build', 'rename-before-fsync', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.points.length, out.crashPoints);
  assert.equal(out.consistent + out.corrupt + out.unverifiable, out.crashPoints);
  assert.ok(out.corrupt > 0);
  assert.ok(out.firstFinding.diff.length > 0);
});

test('replay exits non-zero on a corrupt cell and zero on a consistent one', () => {
  const listing = JSON.parse(run(['enumerate', '--seed', '1', '--build', 'rename-before-fsync', '--json']).stdout);
  const f = listing.firstFinding;
  const bad = run(['replay', '--seed', '1', '--build', 'rename-before-fsync',
    '--point', String(f.crashPoint), '--schedule', f.schedule]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^CORRUPT/m);
  // A schedule id names operations in ONE build's op stream. Asking the correct
  // build for the buggy build's schedule is a category error, and the CLI says
  // so rather than replaying something that looks close enough.
  const wrongBuild = run(['replay', '--seed', '1', '--point', String(f.crashPoint), '--schedule', f.schedule]);
  assertStatedError(wrongBuild, /no schedule ".+" at crash point/);
  const good = run(['replay', '--seed', '1', '--point', String(f.crashPoint)]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /^CONSISTENT/m);
});

test('verify reproduces the committed crashes.json', () => {
  const r = run(['verify', path.join(ROOT, 'crashes.json')]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /every re-runnable number in the report reproduced/);
  assert.ok(!/MISMATCH/.test(r.stdout), r.stdout);
  assert.match(r.stdout, /UNVERIFIED\s+real targets/, 'the target section must not be claimed as re-run');
});
