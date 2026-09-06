// The store: a write-ahead-logged key/value map, single process, single writer.
//
// It is deliberately small, because the interesting part of this project is not
// the store — it is that every I/O boundary in here is a place the machine can
// lose power, and the enumerator visits all of them.
//
// On-disk shapes (little-endian):
//
//   log record   0 u32 magic   4 u32 crc   8 u32 seq   12 u16 klen   14 u16 vlen
//                16 key bytes  ... value bytes
//                crc covers bytes 8 .. end-of-record, i.e. seq, lengths, key and
//                value. vlen 0xFFFF marks a tombstone and carries no value.
//
//   snapshot     0 u32 magic   4 u32 crc   8 u32 lastSeq   12 u32 count
//                16 entries of (u16 klen, u16 vlen, key, value)
//                crc covers bytes 8 .. end.
//
// Recovery reads the snapshot, then replays log records whose sequence numbers
// continue from it, contiguously. The contiguity rule is what stops a stale
// record left behind by a checkpoint whose log truncation never landed from
// being replayed on top of newer state.

import { crc32 } from './crc32.js';
import { correctBuild } from './bugs.js';

export const LOG = 'log';
export const SNAP = 'snap';
export const SNAP_TMP = 'snap.tmp';

const REC_MAGIC = 0xc0ffe1da;
const SNAP_MAGIC = 0x534e4150; // 'SNAP'
const REC_HEADER = 16;
const SNAP_HEADER = 16;
const TOMBSTONE = 0xffff;
const MAX_FIELD = 0xfffe;

/** @param {string} s @returns {Uint8Array} */
export function enc(s) {
  return new Uint8Array(Buffer.from(s, 'latin1'));
}

/** @param {Uint8Array} b @returns {string} */
export function dec(b) {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');
}

/**
 * @param {number} seq
 * @param {string} key
 * @param {string|null} value null encodes a delete
 * @param {import('./bugs.js').BuildFlags} [flags]
 * @returns {Uint8Array}
 */
export function encodeRecord(seq, key, value, flags = correctBuild()) {
  const k = enc(key);
  const v = value === null ? new Uint8Array(0) : enc(value);
  if (k.length > MAX_FIELD || v.length > MAX_FIELD) {
    throw new RangeError('key or value exceeds ' + MAX_FIELD + ' bytes');
  }
  const total = REC_HEADER + k.length + v.length;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint32(0, REC_MAGIC, true);
  view.setUint32(8, seq, true);
  view.setUint16(12, k.length, true);
  view.setUint16(14, value === null ? TOMBSTONE : v.length, true);
  buf.set(k, REC_HEADER);
  buf.set(v, REC_HEADER + k.length);
  // `torn-record-accepted` is a FORMAT bug, not just a reader bug: the writer
  // authenticates the header and leaves the body unprotected, so a reader that
  // checks the checksum still lets a torn body through.
  view.setUint32(4, crc32(buf, 8, flags.tornRecordAccepted ? REC_HEADER : total), true);
  return buf;
}

/**
 * @param {Map<string, string>} state
 * @param {number} lastSeq
 * @param {import('./bugs.js').BuildFlags} [flags]
 * @returns {Uint8Array}
 */
export function encodeSnapshot(state, lastSeq, flags = correctBuild()) {
  /** @type {Uint8Array[]} */
  const parts = [];
  let size = SNAP_HEADER;
  for (const [key, value] of state) {
    const k = enc(key);
    const v = enc(value);
    const entry = new Uint8Array(4 + k.length + v.length);
    const ev = new DataView(entry.buffer);
    ev.setUint16(0, k.length, true);
    ev.setUint16(2, v.length, true);
    entry.set(k, 4);
    entry.set(v, 4 + k.length);
    parts.push(entry);
    size += entry.length;
  }
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  view.setUint32(0, SNAP_MAGIC, true);
  view.setUint32(8, lastSeq, true);
  view.setUint32(12, state.size, true);
  let at = SNAP_HEADER;
  for (const p of parts) { buf.set(p, at); at += p.length; }
  view.setUint32(4, crc32(buf, 8, flags.tornRecordAccepted ? SNAP_HEADER : size), true);
  return buf;
}

/**
 * @typedef {object} Mutation
 * @property {number} index 0-based position in the workload
 * @property {'put'|'del'} kind
 * @property {string} key
 * @property {string|null} value
 * @property {number} issuedAtOp op-stream length when the call started
 * @property {number} ackedAtOp op-stream length when the call returned
 */

/**
 * The store, running against a modeled device.
 */
export class Store {
  /**
   * @param {import('./device.js').DeviceLike} device modeled, or the real filesystem
   * @param {import('./bugs.js').BuildFlags} [flags]
   */
  constructor(device, flags = correctBuild()) {
    this.device = device;
    this.flags = flags;
    /** @type {Map<string, string>} */
    this.mem = new Map();
    this.lastSeq = 0;
    this.logSize = 0;
    /** @type {Mutation[]} */
    this.mutations = [];
    /** @type {number[]} op indices at which a checkpoint completed */
    this.checkpoints = [];
  }

  /** Create the log and make its directory entry durable. */
  format() {
    this.device.create(LOG);
    this.device.fsyncdir();
  }

  /** @param {string} key @param {string} value */
  put(key, value) {
    this.#mutate('put', key, value);
  }

  /** @param {string} key */
  del(key) {
    this.#mutate('del', key, null);
  }

  /** @param {string} key @returns {string|undefined} */
  get(key) {
    return this.mem.get(key);
  }

  /**
   * @param {'put'|'del'} kind
   * @param {string} key
   * @param {string|null} value
   */
  #mutate(kind, key, value) {
    const issuedAtOp = this.device.ops.length;
    const seq = this.lastSeq + 1;
    const rec = encodeRecord(seq, key, value, this.flags);
    this.device.write(LOG, this.logSize, rec);
    // The single line that separates a durable store from a fast one.
    if (!this.flags.noFsyncBeforeAck) this.device.fsync(LOG);
    this.logSize += rec.length;
    this.lastSeq = seq;
    if (value === null) this.mem.delete(key); else this.mem.set(key, value);
    this.mutations.push({
      index: this.mutations.length, kind, key, value,
      issuedAtOp, ackedAtOp: this.device.ops.length,
    });
  }

  /**
   * Fold the log into a snapshot and start a fresh log.
   * Correct order: data durable, then the directory entry, then throw the log
   * away. `rename-before-fsync` removes the first of those three.
   */
  checkpoint() {
    const bytes = encodeSnapshot(this.mem, this.lastSeq, this.flags);
    this.device.create(SNAP_TMP);
    this.device.write(SNAP_TMP, 0, bytes);
    if (!this.flags.renameBeforeFsync) this.device.fsync(SNAP_TMP);
    this.device.rename(SNAP_TMP, SNAP);
    this.device.fsyncdir();
    // The truncation is deliberately NOT fsynced. Once the snapshot is durable
    // the old log is redundant, so forcing it to the platter buys nothing --
    // and leaving it un-forced is what lets a later record land on top of an
    // untruncated log, which is where a stale record body comes from.
    this.device.truncate(LOG, 0);
    this.logSize = 0;
    this.checkpoints.push(this.device.ops.length);
  }
}

/**
 * @typedef {object} Recovery
 * @property {Map<string, string>} state
 * @property {number} lastSeq
 * @property {number} replayed records applied from the log
 * @property {string} stopped why log replay ended
 * @property {string} snapshot what happened to the snapshot
 * @property {string|null} threw message if recovery crashed instead of recovering
 */

/**
 * Rebuild the state from a post-crash disk image. Never throws for image
 * reasons: a store that refuses to open is a store that lost your data, and the
 * validator is entitled to see that as the failure it is.
 * @param {Map<string, Uint8Array>} image
 * @param {import('./bugs.js').BuildFlags} [flags]
 * @returns {Recovery}
 */
export function recover(image, flags = correctBuild()) {
  /** @type {Recovery} */
  const out = {
    state: new Map(), lastSeq: 0, replayed: 0,
    stopped: 'no log', snapshot: 'absent', threw: null,
  };
  try {
    const snap = image.get(SNAP);
    if (snap !== undefined) {
      const parsed = parseSnapshot(snap, flags);
      if (parsed.ok) {
        out.state = parsed.state;
        out.lastSeq = parsed.lastSeq;
        out.snapshot = 'applied (' + parsed.state.size + ' keys, through seq ' + parsed.lastSeq + ')';
      } else {
        out.snapshot = 'rejected: ' + parsed.why;
      }
    }
    const log = image.get(LOG);
    if (log === undefined) return out;
    let at = 0;
    let expect = out.lastSeq + 1;
    for (;;) {
      const r = parseRecord(log, at, expect, flags);
      if (!r.ok) { out.stopped = r.why; break; }
      if (r.value === null) out.state.delete(r.key); else out.state.set(r.key, r.value);
      out.lastSeq = r.seq;
      out.replayed++;
      at = r.next;
      expect = r.seq + 1;
    }
  } catch (err) {
    out.threw = /** @type {Error} */ (err).message;
  }
  return out;
}

/**
 * @param {Uint8Array} buf
 * @param {import('./bugs.js').BuildFlags} flags
 * @returns {{ok:true, state:Map<string,string>, lastSeq:number}|{ok:false, why:string}}
 */
function parseSnapshot(buf, flags) {
  if (buf.length < SNAP_HEADER) return { ok: false, why: 'shorter than a header' };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== SNAP_MAGIC) return { ok: false, why: 'bad magic' };
  const stored = view.getUint32(4, true);
  const lastSeq = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  if (!flags.checksumSkipped) {
    // Header-only coverage is the `torn-record-accepted` mistake applied to the
    // snapshot: the count is authenticated, the entries it counts are not.
    const over = flags.tornRecordAccepted ? Math.min(SNAP_HEADER, buf.length) : buf.length;
    if (crc32(buf, 8, over) !== stored) return { ok: false, why: 'checksum mismatch' };
  }
  /** @type {Map<string, string>} */
  const state = new Map();
  let at = SNAP_HEADER;
  for (let i = 0; i < count; i++) {
    if (at + 4 > buf.length) {
      if (flags.tornRecordAccepted) break;
      return { ok: false, why: 'entry ' + i + ' of ' + count + ' runs past the end of the file' };
    }
    const klen = view.getUint16(at, true);
    const vlen = view.getUint16(at + 2, true);
    const end = at + 4 + klen + vlen;
    if (end > buf.length) {
      if (flags.tornRecordAccepted) break;
      return { ok: false, why: 'entry ' + i + ' of ' + count + ' runs past the end of the file' };
    }
    state.set(dec(buf.subarray(at + 4, at + 4 + klen)), dec(buf.subarray(at + 4 + klen, end)));
    at = end;
  }
  return { ok: true, state, lastSeq };
}

/**
 * @param {Uint8Array} buf
 * @param {number} at
 * @param {number} expect required sequence number for this record
 * @param {import('./bugs.js').BuildFlags} flags
 * @returns {{ok:true, key:string, value:string|null, seq:number, next:number}|{ok:false, why:string}}
 */
function parseRecord(buf, at, expect, flags) {
  if (at >= buf.length) return { ok: false, why: 'end of log' };
  if (at + REC_HEADER > buf.length) return { ok: false, why: 'torn header at byte ' + at };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(at, true) !== REC_MAGIC) return { ok: false, why: 'bad magic at byte ' + at };
  const stored = view.getUint32(at + 4, true);
  const seq = view.getUint32(at + 8, true);
  if (seq !== expect) {
    return { ok: false, why: 'sequence break at byte ' + at + ': found ' + seq + ', expected ' + expect };
  }
  const klen = view.getUint16(at + 12, true);
  const rawVlen = view.getUint16(at + 14, true);
  const tomb = rawVlen === TOMBSTONE;
  const vlen = tomb ? 0 : rawVlen;
  const end = at + REC_HEADER + klen + vlen;

  // The correct build refuses a record whose declared body is not all there.
  if (end > buf.length && !flags.tornRecordAccepted) {
    return {
      ok: false,
      why: 'torn record at byte ' + at + ': declares ' + (end - at) + ' bytes, ' +
        (buf.length - at) + ' present',
    };
  }
  // The correct build checksums the whole record. `torn-record-accepted`
  // checksums the header only; `checksum-skipped` checksums nothing.
  if (!flags.checksumSkipped) {
    const over = Math.min(flags.tornRecordAccepted ? at + REC_HEADER : end, buf.length);
    if (crc32(buf, at + 8, over) !== stored) {
      return { ok: false, why: 'checksum mismatch at byte ' + at };
    }
  }
  const keyEnd = Math.min(at + REC_HEADER + klen, buf.length);
  const key = dec(padTo(buf.subarray(Math.min(at + REC_HEADER, buf.length), keyEnd), klen));
  const value = tomb
    ? null
    : dec(padTo(buf.subarray(Math.min(at + REC_HEADER + klen, buf.length), Math.min(end, buf.length)), vlen));
  return { ok: true, key, value, seq, next: end };
}

/** Zero-fill a short read, which is exactly the mistake `torn-record-accepted` makes. */
/** @param {Uint8Array} b @param {number} len @returns {Uint8Array} */
function padTo(b, len) {
  if (b.length >= len) return b;
  const out = new Uint8Array(len);
  out.set(b, 0);
  return out;
}
