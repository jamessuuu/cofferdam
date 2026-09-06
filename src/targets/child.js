#!/usr/bin/env node
// The child that gets killed.
//
// It runs a workload against a REAL target -- the store on a real filesystem, or
// SQLite -- and terminates itself abruptly at a chosen point. SIGKILL rather
// than process.exit(), because an orderly exit runs exit handlers and flushes
// buffers, which is the opposite of what a crash test wants.
//
// Not a public entry point: `src/cli.js targets` spawns it. It is a separate
// file because a process that kills itself cannot also report the result.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RealDevice } from './realfs.js';
import { Store } from '../store.js';
import { makeWorkload } from '../workload.js';
import { parseBuildFlags } from '../bugs.js';

/** Terminate without running a single exit handler. */
function hardKill() {
  process.kill(process.pid, 'SIGKILL');
  // Only reached if the signal did not land. abort() also skips exit handlers,
  // so the fallback is still a crash and never a clean shutdown.
  process.abort();
}

/** A RealDevice that stops existing at a given op index. */
class CrashingDevice extends RealDevice {
  /** @param {string} dir @param {number} crashAt */
  constructor(dir, crashAt) {
    super(dir);
    this.crashAt = crashAt;
  }

  #gate() {
    if (this.ops.length === this.crashAt) hardKill();
  }

  /** @param {string} p */
  create(p) { this.#gate(); super.create(p); }
  /** @param {string} p @param {number} o @param {Uint8Array} d */
  write(p, o, d) { this.#gate(); super.write(p, o, d); }
  /** @param {string} p @param {number} l */
  truncate(p, l) { this.#gate(); super.truncate(p, l); }
  /** @param {string} a @param {string} b */
  rename(a, b) { this.#gate(); super.rename(a, b); }
  /** @param {string} p */
  unlink(p) { this.#gate(); super.unlink(p); }
  /** @param {string} p */
  fsync(p) { this.#gate(); super.fsync(p); }
  fsyncdir() { this.#gate(); super.fsyncdir(); }
}

/** @param {string[]} argv @returns {Record<string,string>} */
function args(argv) {
  /** @type {Record<string,string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  const dir = a.dir;
  const seed = Number(a.seed);
  const crashAt = Number(a['crash-at']);
  const workload = makeWorkload(seed);

  if (a.target === 'realfs') {
    const device = new CrashingDevice(dir, crashAt);
    const store = new Store(device, parseBuildFlags(a.build));
    store.format();
    for (const step of workload.steps) {
      if (step.kind === 'put') store.put(step.key, step.value);
      else if (step.kind === 'del') store.del(step.key);
      else store.checkpoint();
    }
    // Reached only when crashAt is past the end of the op stream.
    fs.writeFileSync(path.join(dir, 'survived'), String(device.ops.length));
    return 0;
  }

  if (a.target === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'kv.db'));
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=' + (a.sync === 'OFF' ? 'OFF' : 'FULL'));
    db.exec('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const put = db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
    const del = db.prepare('DELETE FROM kv WHERE k=?');
    let done = 0;
    for (const step of workload.steps) {
      if (step.kind === 'checkpoint') continue;
      if (done === crashAt) hardKill();
      if (step.kind === 'put') put.run(step.key, step.value);
      else del.run(step.key);
      done++;
    }
    fs.writeFileSync(path.join(dir, 'survived'), String(done));
    return 0;
  }

  process.stderr.write('child: unknown --target "' + a.target + '"\n');
  return 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; });
}
