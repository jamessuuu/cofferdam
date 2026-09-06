// A modeled block device: what the store writes through, and the only place
// the crash model lives.
//
// Two things happen here. While a workload runs, the device behaves like an
// ordinary filesystem and records every I/O the store issued, in order. After
// the workload finishes, `materialize()` replays a prefix of that recording
// under a crash schedule and returns the bytes a machine would find on the
// platter after losing power at that instant. `materialize()` is pure: same
// ops, same crash point, same schedule, same bytes, forever.
//
// The persistence model, stated once so the README and the checker can both
// point at it:
//
//   * SECTOR-sized writes are atomic. A larger write may tear, and it tears at
//     a sector boundary. Sub-sector tearing is not modeled and neither is
//     bit rot; both are real and both are out of scope.
//   * `write` and `truncate` sit in a volatile cache until an `fsync` on that
//     file. Un-fsynced data writes may reach the platter in ANY subset and any
//     order, because they are independent sectors under a write-back cache.
//   * `create`, `rename` and `unlink` are metadata. They sit in a journal until
//     `fsyncdir`, and un-fsynced metadata lands as a PREFIX of issue order,
//     because a journaling filesystem commits metadata transactions in order.
//     This is the ordered-mode assumption; it is why the model does not
//     enumerate 2^n metadata interleavings that no real journal produces.
//   * A data write to a file whose directory entry never landed is DROPPED,
//     not an error: the blocks were written but nothing references them.

/** Bytes the device writes atomically. */
export const SECTOR = 512;

/** @typedef {{k:'create', path:string}} CreateOp */
/** @typedef {{k:'write', path:string, off:number, data:Uint8Array}} WriteOp */
/** @typedef {{k:'truncate', path:string, len:number}} TruncateOp */
/** @typedef {{k:'rename', from:string, to:string}} RenameOp */
/** @typedef {{k:'unlink', path:string}} UnlinkOp */
/** @typedef {{k:'fsync', path:string}} FsyncOp */
/** @typedef {{k:'fsyncdir'}} FsyncDirOp */
/** @typedef {CreateOp|WriteOp|TruncateOp|RenameOp|UnlinkOp|FsyncOp|FsyncDirOp} Op */

/** @param {Op} op @returns {op is WriteOp|TruncateOp} */
export function isDataOp(op) {
  return op.k === 'write' || op.k === 'truncate';
}

/** @param {Op} op @returns {op is CreateOp|RenameOp|UnlinkOp} */
export function isMetaOp(op) {
  return op.k === 'create' || op.k === 'rename' || op.k === 'unlink';
}

/**
 * What the Store needs from a device. The modeled Device implements it; so does
 * the real-filesystem adapter in src/targets/, which is the whole point of
 * naming the shape instead of the class.
 * @typedef {object} DeviceLike
 * @property {Op[]} ops
 * @property {(path: string) => void} create
 * @property {(path: string, off: number, data: Uint8Array) => void} write
 * @property {(path: string, len: number) => void} truncate
 * @property {(from: string, to: string) => void} rename
 * @property {(path: string) => void} unlink
 * @property {(path: string) => void} fsync
 * @property {() => void} fsyncdir
 */

/** @param {Op} op @returns {boolean} */
export function isBarrier(op) {
  return op.k === 'fsync' || op.k === 'fsyncdir';
}

/**
 * How many sectors a write op touches. A write of 1 byte touches 1 sector; a
 * write of SECTOR+1 bytes touches 2 and can therefore tear.
 * @param {Op} op
 * @returns {number}
 */
export function sectorsOf(op) {
  if (op.k !== 'write') return 1;
  return Math.max(1, Math.ceil(op.data.length / SECTOR));
}

/** Human-readable one-liner for an op, used by the CLI and the report page. */
/** @param {Op} op @returns {string} */
export function describeOp(op) {
  switch (op.k) {
    case 'create': return 'create ' + op.path;
    case 'write': return 'write ' + op.path + ' @' + op.off + ' +' + op.data.length + 'B';
    case 'truncate': return 'truncate ' + op.path + ' -> ' + op.len + 'B';
    case 'rename': return 'rename ' + op.from + ' -> ' + op.to;
    case 'unlink': return 'unlink ' + op.path;
    case 'fsync': return 'fsync ' + op.path;
    case 'fsyncdir': return 'fsync <dir>';
    default: return 'unknown op';
  }
}

/**
 * The device as the running process sees it: every op applied immediately.
 * Nothing here decides durability; it only records what was asked for.
 */
export class Device {
  constructor() {
    /** @type {Map<string, Uint8Array>} live, process-visible contents */
    this.live = new Map();
    /** @type {Op[]} the recording the enumerator replays */
    this.ops = [];
  }

  /** @param {Op} op */
  #record(op) {
    this.ops.push(op);
    applyOp(this.live, op, null);
  }

  /** @param {string} path */
  create(path) {
    this.#record({ k: 'create', path });
  }

  /** @param {string} path @param {number} off @param {Uint8Array} data */
  write(path, off, data) {
    this.#record({ k: 'write', path, off, data: Uint8Array.from(data) });
  }

  /** @param {string} path @param {number} len */
  truncate(path, len) {
    this.#record({ k: 'truncate', path, len });
  }

  /** @param {string} from @param {string} to */
  rename(from, to) {
    this.#record({ k: 'rename', from, to });
  }

  /** @param {string} path */
  unlink(path) {
    this.#record({ k: 'unlink', path });
  }

  /** @param {string} path */
  fsync(path) {
    this.#record({ k: 'fsync', path });
  }

  fsyncdir() {
    this.#record({ k: 'fsyncdir' });
  }

  /** @param {string} path @returns {boolean} */
  exists(path) {
    return this.live.has(path);
  }

  /** @param {string} path @returns {number} */
  size(path) {
    const f = this.live.get(path);
    return f ? f.length : 0;
  }

  /** @param {string} path @returns {Uint8Array} */
  read(path) {
    const f = this.live.get(path);
    if (!f) throw new Error('device: no such file: ' + path);
    return f;
  }
}

/**
 * Apply one op to an image. `tearSectors` is null for a whole landing, or the
 * number of leading sectors that reached the platter for a torn write.
 * @param {Map<string, Uint8Array>} files
 * @param {Op} op
 * @param {number|null} tearSectors
 */
function applyOp(files, op, tearSectors) {
  switch (op.k) {
    case 'create': {
      if (!files.has(op.path)) files.set(op.path, new Uint8Array(0));
      return;
    }
    case 'write': {
      const cur = files.get(op.path);
      // A write whose directory entry never landed goes to blocks nothing
      // references. It is lost, not an error.
      if (cur === undefined) return;
      const landed = tearSectors === null
        ? op.data.length
        : Math.min(op.data.length, tearSectors * SECTOR);
      if (landed <= 0) return;
      const end = op.off + landed;
      const next = end > cur.length ? new Uint8Array(Math.max(cur.length, end)) : new Uint8Array(cur);
      next.set(cur, 0);
      next.set(op.data.subarray(0, landed), op.off);
      files.set(op.path, next);
      return;
    }
    case 'truncate': {
      const cur = files.get(op.path);
      if (cur === undefined) return;
      const next = new Uint8Array(op.len);
      next.set(cur.subarray(0, Math.min(cur.length, op.len)), 0);
      files.set(op.path, next);
      return;
    }
    case 'rename': {
      const cur = files.get(op.from);
      if (cur === undefined) return;
      files.delete(op.from);
      files.set(op.to, cur);
      return;
    }
    case 'unlink': {
      files.delete(op.path);
      return;
    }
    default:
      // fsync / fsyncdir move no bytes; they only change what is durable, which
      // is decided in durableBefore().
      return;
  }
}

/**
 * Which of ops[0..upto-1] were already forced to the platter by a barrier
 * inside that same prefix. Everything else in the prefix is in flight.
 * @param {Op[]} ops
 * @param {number} upto crash point: ops[0..upto-1] were issued
 * @returns {boolean[]} indexed like ops, true where the op is definitely durable
 */
export function durableBefore(ops, upto) {
  const durable = new Array(ops.length).fill(false);
  // Walk backwards: an op is durable if a matching barrier appears after it
  // and still inside the prefix.
  /** @type {Set<string>} */
  const syncedPaths = new Set();
  let dirSynced = false;
  for (let i = upto - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.k === 'fsync') { syncedPaths.add(op.path); durable[i] = true; continue; }
    if (op.k === 'fsyncdir') { dirSynced = true; durable[i] = true; continue; }
    if (isDataOp(op)) durable[i] = syncedPaths.has(op.path);
    else if (isMetaOp(op)) durable[i] = dirSynced;
  }
  return durable;
}

/**
 * The in-flight ops at a crash point, split by kind. Data ops may land in any
 * subset; metadata ops land as a prefix of this list.
 * @param {Op[]} ops
 * @param {number} upto
 * @returns {{data:number[], meta:number[]}}
 */
export function inflightAt(ops, upto) {
  const durable = durableBefore(ops, upto);
  /** @type {number[]} */ const data = [];
  /** @type {number[]} */ const meta = [];
  for (let i = 0; i < upto; i++) {
    if (durable[i]) continue;
    if (isDataOp(ops[i])) data.push(i);
    else if (isMetaOp(ops[i])) meta.push(i);
  }
  return { data, meta };
}

/**
 * @typedef {object} Schedule
 * @property {number[]} persist in-flight op indices that reached the platter
 * @property {{index:number, sectors:number}|null} tear at most one torn write
 * @property {string} id stable, human-readable, appears in replay commands
 */

/**
 * Replay ops[0..upto-1] under a crash schedule and return the post-crash image.
 * Pure: no clock, no randomness, no I/O.
 * @param {Op[]} ops
 * @param {number} upto
 * @param {Schedule} schedule
 * @returns {Map<string, Uint8Array>}
 */
export function materialize(ops, upto, schedule) {
  const durable = durableBefore(ops, upto);
  const persist = new Set(schedule.persist);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (let i = 0; i < upto; i++) {
    const op = ops[i];
    if (isBarrier(op)) continue;
    if (!durable[i] && !persist.has(i)) continue;
    const tear = schedule.tear && schedule.tear.index === i ? schedule.tear.sectors : null;
    applyOp(files, op, tear);
  }
  return files;
}
