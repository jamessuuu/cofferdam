# Changelog

All notable changes to this project are recorded here. Versions follow
[semantic versioning](https://semver.org/). The version reflects what has
actually shipped, not what would look mature.

## 0.1.0 - 2026-09-06

First release. Every number below was measured on the day it was written, on
Node v24.15.0 and Windows 11; the commands that reproduce each one are in the
README.

### Added

- **Modeled block device** (`src/device.js`). Sector-atomic writes with tearing
  at sector boundaries; un-fsynced data writes land in any subset; un-fsynced
  metadata lands as a prefix of issue order, which is the ordered-mode
  journaling assumption stated out loud rather than assumed silently. Replay is
  pure: same ops, same crash point, same schedule, same bytes.
- **Write-ahead-logged store** (`src/store.js`). Checksummed records, an fsync
  before every acknowledgement, snapshot checkpoints ordered data-then-metadata,
  and recovery that requires contiguous ascending sequence numbers so a stale
  record from a previous log generation cannot be replayed over newer state.
- **Bounded exhaustive crash-point enumeration** (`src/enumerate.js`). Every
  index into the op stream is a crash point; at each one the schedule space is
  (metadata prefix × data subset × at most one torn write). Inside the reorder
  bound the space is enumerated; above it a fixed sample runs instead and the
  crash point is reported unverifiable.
- **The recovery-state validator** (`src/spec.js`). Three outcomes:
  `consistent`, `corrupt` with a diff against the nearest legal state, and
  `unverifiable` with the reason.
- **Five planted fixtures** (`src/bugs.js`): `no-fsync-before-ack`,
  `torn-record-accepted`, `checksum-skipped`, `rename-before-fsync`, and
  `checker-accept-corrupt` - the last of which breaks the *checker* so its
  failure path can be watched to stop working.
- **Negative control**: 200 workloads of the correct build, 12,600 crash points,
  24,496 crash schedules, zero corruptions and zero unverifiable results.
- **Three real targets** (`src/targets/`): byte fidelity of the model against
  NTFS; the store on a real filesystem killed by real `SIGKILL`s and then fed
  the enumerator's own images through real file I/O; and `node:sqlite` in WAL
  mode under `synchronous=FULL` and `synchronous=OFF` with a torn WAL.
- **CLI** with `demo`, `enumerate`, `replay`, `fixtures`, `control`, `targets`,
  `bugs` and `verify`. Bad input produces a stated error and a non-zero exit.
- **A committed report** (`crashes.json`) that `cofferdam verify` re-runs and
  compares, reporting the target section as unverified rather than re-running
  numbers that belong to another machine.
- **Static report page** (`web/`) whose default view is a failing run, with the
  seed, the build and the crash point in the URL. No server, no fetch, no
  dataset, no credentials.

### Measured during development, and kept

- **A real process kill cannot see a missing fsync.** With
  `no-fsync-before-ack` planted, 39 real crash points on real NTFS - each one a
  real `SIGKILL` after 24 acknowledged writes - produced **zero** corruptions,
  while the modeled device found 32 corrupt crash points on the same build and
  2,572 corrupt recoveries across 3,714 modeled images written to real files.
  That gap is the argument for modelling the device at all.
- **`fsync` on a directory is unavailable on Windows** (`EPERM`). The store's
  checkpoint ordering depends on that barrier, so on this platform the real run
  cannot issue a barrier the model assumes. Reported as a note on every target
  run rather than swallowed.

### False positives found by real targets, and removed

- **SQLite at `synchronous=OFF` reported 69 lost commits.** Not defects: `OFF`
  documents that a recent commit may be lost on power failure. That
  configuration is now checked against the integrity half of the specification
  only.
- **A WAL truncated below its schema transaction read as "sqlite refused to
  open".** It is the state after zero mutations. `no such table` is now treated
  as the empty state; every other SQLite error is still a failure to recover.
- **The WAL-tearing harness was not producing independent crash images.**
  Opening a database recovers it and can checkpoint the WAL, so the second tear
  was being applied to the first variant's recovered database. Every SQLite file
  is now captured once after the kill and restored before each variant.

### Known limitations at 0.1.0

- Single process, single writer. Every claim depends on at most one mutation
  being in flight; concurrent writers would need a different specification.
- Sub-sector tearing, bit rot, and a disk that lies about `fsync` are unmodelled.
- Torn writes are enumerated as prefix tears at sector boundaries, at most one
  per schedule. A write whose middle sector alone failed to land is outside the
  space.
- `checksum-skipped` needs two things to go wrong at once and reproduces on 169
  of the first 1,000 seeds, so its fixture sweeps 60 seeds against a floor of 5.
- CI is committed and has never run: the repository has no remote.
- The report page has been checked at 1280 and 1440 CSS pixels and not on a
  phone.
