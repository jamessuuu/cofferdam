// Real target 1: the same store, on the real filesystem.
//
// Everything else in cofferdam runs against a model. A model can be wrong in a
// way that makes every verdict it produces fiction, so this file runs the exact
// same op stream through real syscalls on a real disk and compares.
//
// Two honest things this can do, and one it cannot:
//
//   it CAN check byte fidelity  -- replay the op stream for real and assert the
//     bytes NTFS ends up with are the bytes the model predicted;
//   it CAN kill a real process  -- run the workload in a child, terminate it at
//     a chosen op, and recover from whatever the real files hold;
//   it CANNOT cross the fsync boundary -- killing a process does not lose the
//     operating system's page cache. Only a power failure or a block-layer
//     fault injector does that, and neither is available in a portable Node
//     test. That is precisely the boundary the modeled device exists to cover,
//     and it is why `no-fsync-before-ack` is invisible here and obvious there.
//
// The third point is not an excuse. It is the measurement that justifies the
// whole project.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materialize } from '../device.js';
import { LOG, SNAP, SNAP_TMP, recover } from '../store.js';
import { correctBuild } from '../bugs.js';

export const FILES = [LOG, SNAP, SNAP_TMP];

/** @returns {string} a fresh scratch directory under the OS temp dir */
export function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cofferdam-'));
}

/**
 * The Device surface, backed by real syscalls. Same methods, same op recording,
 * so the Store cannot tell the difference and the two op streams are comparable.
 */
export class RealDevice {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
    /** @type {import('../device.js').Op[]} */
    this.ops = [];
    /** @type {string[]} platform limitations hit while running */
    this.notes = [];
  }

  /** @param {string} name @returns {string} */
  #p(name) {
    return path.join(this.dir, name);
  }

  /** @param {string} p */
  create(p) {
    this.ops.push({ k: 'create', path: p });
    fs.closeSync(fs.openSync(this.#p(p), 'a'));
  }

  /** @param {string} p @param {number} off @param {Uint8Array} data */
  write(p, off, data) {
    this.ops.push({ k: 'write', path: p, off, data: Uint8Array.from(data) });
    const fd = fs.openSync(this.#p(p), 'r+');
    try { fs.writeSync(fd, data, 0, data.length, off); } finally { fs.closeSync(fd); }
  }

  /** @param {string} p @param {number} len */
  truncate(p, len) {
    this.ops.push({ k: 'truncate', path: p, len });
    fs.truncateSync(this.#p(p), len);
  }

  /** @param {string} from @param {string} to */
  rename(from, to) {
    this.ops.push({ k: 'rename', from, to });
    fs.renameSync(this.#p(from), this.#p(to));
  }

  /** @param {string} p */
  unlink(p) {
    this.ops.push({ k: 'unlink', path: p });
    fs.rmSync(this.#p(p), { force: true });
  }

  /** @param {string} p */
  fsync(p) {
    this.ops.push({ k: 'fsync', path: p });
    const fd = fs.openSync(this.#p(p), 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  /**
   * Windows has no portable way to flush a directory: opening one for reading
   * and calling fsync returns EPERM. The barrier is recorded and the failure is
   * reported rather than swallowed, because on this platform the store's
   * checkpoint ordering rests on a barrier that is not there.
   */
  fsyncdir() {
    this.ops.push({ k: 'fsyncdir' });
    try {
      const fd = fs.openSync(this.dir, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (err) {
      const note = 'fsync on a directory is unavailable here (' +
        /** @type {NodeJS.ErrnoException} */ (err).code + ' on ' + process.platform +
        '): the metadata barrier the checkpoint depends on cannot be issued';
      if (!this.notes.includes(note)) this.notes.push(note);
    }
  }

  /** @param {string} p @returns {boolean} */
  exists(p) {
    return fs.existsSync(this.#p(p));
  }

  /** @param {string} p @returns {number} */
  size(p) {
    return this.exists(p) ? fs.statSync(this.#p(p)).size : 0;
  }

  /** @param {string} p @returns {Uint8Array} */
  read(p) {
    return new Uint8Array(fs.readFileSync(this.#p(p)));
  }
}

/**
 * Read whatever the store's files currently hold, as a crash image.
 * @param {string} dir
 * @returns {Map<string, Uint8Array>}
 */
export function readRealImage(dir) {
  /** @type {Map<string, Uint8Array>} */
  const image = new Map();
  for (const name of FILES) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) image.set(name, new Uint8Array(fs.readFileSync(full)));
  }
  return image;
}

/**
 * Put a modeled crash image on the real disk, so real recovery reads real bytes
 * through real file I/O rather than a Uint8Array the same process just built.
 * @param {string} dir
 * @param {Map<string, Uint8Array>} image
 */
export function writeRealImage(dir, image) {
  for (const name of FILES) {
    const full = path.join(dir, name);
    if (image.has(name)) fs.writeFileSync(full, /** @type {Uint8Array} */ (image.get(name)));
    else fs.rmSync(full, { force: true });
  }
}

/**
 * @param {Map<string, Uint8Array>} a
 * @param {Map<string, Uint8Array>} b
 * @returns {string[]} one line per disagreement, empty when identical
 */
export function compareImages(a, b) {
  /** @type {string[]} */
  const out = [];
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const name of names) {
    const x = a.get(name);
    const y = b.get(name);
    if (x === undefined) { out.push(name + ': missing from the model image'); continue; }
    if (y === undefined) { out.push(name + ': missing from the real image'); continue; }
    if (x.length !== y.length) {
      out.push(name + ': model ' + x.length + ' bytes, real ' + y.length + ' bytes');
      continue;
    }
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) {
        out.push(name + ': first byte difference at offset ' + i +
          ' (model ' + x[i] + ', real ' + y[i] + ')');
        break;
      }
    }
  }
  return out;
}

/**
 * Recover from real files on disk.
 * @param {string} dir
 * @param {import('../bugs.js').BuildFlags} [flags]
 */
export function recoverFromDisk(dir, flags = correctBuild()) {
  return recover(readRealImage(dir), flags);
}

/**
 * Materialize the model's view of "everything landed" for the same prefix, so
 * it can be compared with what NTFS actually holds.
 * @param {import('../device.js').Op[]} ops
 * @param {number} upto
 * @returns {Map<string, Uint8Array>}
 */
export function modelImageAll(ops, upto) {
  const persist = [];
  for (let i = 0; i < upto; i++) persist.push(i);
  return materialize(ops, upto, { persist, tear: null, id: 'all' });
}
