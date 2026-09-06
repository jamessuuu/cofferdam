// The planted fixtures, as build flags. Every one of them lives here; nothing
// is hidden in another module.
//
// Four break the store's durability. The fifth breaks the CHECKER, so that its
// "corrupt" path can be watched to fail on purpose. A checker whose own failure
// path has never been exercised is decoration, and the fifth flag is the only
// reason this project is allowed to claim the other four mean anything.

/**
 * @typedef {object} Bug
 * @property {string} id
 * @property {'store'|'checker'} breaks
 * @property {string} title
 * @property {string} detail
 */

/** @type {Bug[]} */
export const BUGS = [
  {
    id: 'no-fsync-before-ack',
    breaks: 'store',
    title: 'put() returns before the log record is on the platter',
    detail:
      'The record is written and the call returns. The fsync that would make it durable never ' +
      'happens, so every write acknowledged since the last barrier is only as safe as the page ' +
      'cache. This is the bug that ordinary testing cannot see: killing the process does not lose ' +
      'a page cache, so the store passes every process-kill test and loses data on power failure.',
  },
  {
    id: 'torn-record-accepted',
    breaks: 'store',
    title: 'recovery checksums the record header and trusts the body',
    detail:
      'The CRC is computed over the 8-byte header fields instead of over the whole record, and the ' +
      'declared key/value lengths are never checked against the bytes actually present. A record ' +
      'whose header sector landed and whose body sector did not is replayed, with the missing ' +
      'bytes read as zeros or as whatever the previous log generation left there.',
  },
  {
    id: 'checksum-skipped',
    breaks: 'store',
    title: 'recovery does not verify checksums at all',
    detail:
      'Lengths are still validated, so a short tail is still discarded. What gets through is a ' +
      'record of the right SIZE and the wrong CONTENT: a torn write over a log that was never ' +
      'truncated leaves a new header in front of a stale body, and without the CRC that reads as ' +
      'a valid record.',
  },
  {
    id: 'rename-before-fsync',
    breaks: 'store',
    title: 'the snapshot is renamed into place before its bytes are durable',
    detail:
      'Checkpoint writes snapshot.tmp, renames it over the snapshot, fsyncs the directory and then ' +
      'truncates the log. Dropping the fsync on snapshot.tmp swaps the ordering of data and ' +
      'metadata: the directory entry is durable, the contents are not, and the log that could have ' +
      'rebuilt them has already been thrown away.',
  },
  {
    id: 'checker-accept-corrupt',
    breaks: 'checker',
    title: 'THE SABOTAGED CHECKER: a lost acknowledged write is reported as consistent',
    detail:
      'The validator returns "consistent" at the exact point it has established that an ' +
      'acknowledged mutation is missing from the recovered state. With this flag on, the ' +
      'enumeration over a genuinely broken store reports zero corruptions. That is the ' +
      'demonstration that the corrupt verdict is produced by the check and not by the weather.',
  },
];

export const BUG_IDS = BUGS.map((b) => b.id);

/**
 * @typedef {object} BuildFlags
 * @property {boolean} noFsyncBeforeAck
 * @property {boolean} tornRecordAccepted
 * @property {boolean} checksumSkipped
 * @property {boolean} renameBeforeFsync
 * @property {boolean} checkerAcceptCorrupt
 */

/** @returns {BuildFlags} */
export function correctBuild() {
  return {
    noFsyncBeforeAck: false,
    tornRecordAccepted: false,
    checksumSkipped: false,
    renameBeforeFsync: false,
    checkerAcceptCorrupt: false,
  };
}

/** @param {string} id @returns {string} */
function camel(id) {
  return id.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

/**
 * @param {string|undefined} spec comma-separated bug ids, or 'correct'
 * @returns {BuildFlags}
 */
export function parseBuildFlags(spec) {
  const flags = correctBuild();
  if (spec === undefined || spec === '' || spec === 'correct') return flags;
  for (const raw of String(spec).split(',')) {
    const id = raw.trim();
    if (id === '' || id === 'correct') continue;
    if (!BUG_IDS.includes(id)) {
      const err = new TypeError(
        'unknown build flag "' + id + '"; known flags: ' + BUG_IDS.slice().sort().join(', ')
      );
      throw err;
    }
    /** @type {any} */ (flags)[camel(id)] = true;
  }
  return flags;
}

/** @param {BuildFlags} flags @returns {string} */
export function formatBuildFlags(flags) {
  const on = BUG_IDS.filter((id) => /** @type {any} */ (flags)[camel(id)]);
  return on.length === 0 ? 'correct' : on.join(',');
}
