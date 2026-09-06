// The library surface. Everything a caller needs to enumerate crash points over
// their own workload and judge the recoveries, without going through the CLI.

export { Device, SECTOR, materialize, durableBefore, inflightAt, sectorsOf, describeOp } from './device.js';
export { Store, recover, encodeRecord, encodeSnapshot, LOG, SNAP, SNAP_TMP } from './store.js';
export { crc32 } from './crc32.js';
export { BUGS, BUG_IDS, correctBuild, parseBuildFlags, formatBuildFlags } from './bugs.js';
export { makeWorkload, runWorkload, summarizeValue, rng } from './workload.js';
export { enumerate, replayOne, scheduleSpace, DEFAULT_BOUND, MAX_SCHEDULES_PER_POINT } from './enumerate.js';
export { prefixStates, legalWindow, sameState, diffState, validate } from './spec.js';
export { renderMatrix, renderFinding, renderSummary, renderTargets, glyph } from './report.js';
export { FIXTURES, CONTROL_SEEDS, MEASURED_ON, BOUND_SWEEP, BOUND_SEEDS, FEATURED, range } from './fixtures.js';
