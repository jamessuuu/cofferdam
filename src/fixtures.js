// Reproduction recipes for the planted fixtures, and the negative control.
//
// One source of truth shared by `cofferdam fixtures`, the test suite, the
// committed crashes.json and the README, so the numbers in the README cannot
// drift away from the numbers the tests assert.
//
// `floor` is what CI asserts and is deliberately set below `measured`. The
// measured value is the number this machine actually produced on MEASURED_ON.
// Nothing here is a guess.

export const MEASURED_ON = '2026-09-06';

/** The seed range the negative control sweeps. */
export const CONTROL_SEEDS = 200;

/**
 * @typedef {object} Fixture
 * @property {string} id build flag under test
 * @property {string} title
 * @property {number[]} seeds
 * @property {number} floor seeds that must produce at least one corrupt crash point
 * @property {number} measured seeds that actually did, on MEASURED_ON
 * @property {string} note the mechanism, in one paragraph
 */

/** @param {number} from @param {number} to @returns {number[]} */
export function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/** @type {Fixture[]} */
export const FIXTURES = [
  {
    id: 'no-fsync-before-ack',
    title: 'an acknowledged write that was never on the platter',
    seeds: range(1, 30),
    floor: 28,
    measured: 30,
    note:
      'Every schedule in which the un-fsynced record does not land loses a write the caller was ' +
      'already told about. It fires on every seed because there is nothing subtle about it -- and ' +
      'yet a real process kill on a real filesystem cannot see it at all, because a process kill ' +
      'does not lose the page cache. That gap is measured in `cofferdam targets`.',
  },
  {
    id: 'torn-record-accepted',
    title: 'a record whose body never arrived, replayed anyway',
    seeds: range(1, 30),
    floor: 28,
    measured: 30,
    note:
      'The checksum covers the header, so a record whose first sector landed and whose second did ' +
      'not passes validation and is replayed with a zero-filled tail. The recovered value has the ' +
      'right key and the wrong bytes, which is worse than losing it.',
  },
  {
    id: 'rename-before-fsync',
    title: 'a snapshot whose directory entry outlived its contents',
    seeds: range(1, 30),
    floor: 28,
    measured: 30,
    note:
      'Checkpoint renames snapshot.tmp into place before its bytes are durable and then discards ' +
      'the log. Any schedule where the rename lands and the write does not leaves a snapshot file ' +
      'that exists, is empty, and is the only remaining copy of everything.',
  },
  {
    id: 'checksum-skipped',
    title: 'a new record header in front of a stale record body',
    seeds: range(1, 60),
    floor: 5,
    measured: 8,
    note:
      'The rarest of the four, and the only one that needs two things to go wrong at once: a ' +
      'checkpoint whose log truncation did not land, and a torn write on top of the log it left ' +
      'behind. The record is then exactly as long as it claims and contains bytes from the ' +
      'previous generation. Only the checksum can tell, so removing it is fatal. Measured on ' +
      MEASURED_ON + ': 169 of the first 1,000 seeds reproduce it, and 8 of the first 60.',
  },
];

/**
 * The fifth fixture does not live in this table because it is not measured in
 * seeds. `checker-accept-corrupt` breaks the CHECKER, and the only meaningful
 * assertion about it is a differential one: the same enumeration, with and
 * without it, must disagree. test/sabotage.test.js owns that.
 */
export const SABOTAGE_ID = 'checker-accept-corrupt';

/**
 * The reorder bound, swept, to show what the third outcome actually costs. The
 * correct build never leaves more than two writes in flight, so a bound of 2
 * already enumerates the space completely and the default of 4 is headroom.
 */
export const BOUND_SWEEP = [0, 1, 2, 4];

/** Seeds the bound sweep uses. */
export const BOUND_SEEDS = 30;

/** The enumeration the demo and the report page open on. */
export const FEATURED = { seed: 1, build: 'rename-before-fsync' };
