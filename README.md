# cofferdam

A write-ahead-logged key/value store, and a harness that kills it at **every**
I/O boundary and checks that what recovery leaves behind is a state the API
could actually have produced.

Not a fuzzer. There is no sampling and no luck: a workload's I/O is recorded,
every boundary between two operations becomes a crash point, and at each one the
reorderings of the writes that had not been fsynced are enumerated - all of
them, up to a stated bound, with the bound reported rather than hidden.

**The headline, measured, not asserted:** 200 workloads of the correct build
produce **12,600 crash points and 24,496 crash schedules with zero corruptions
and zero unverifiable results**, in 0.4 seconds. The same machinery finds the
four planted durability bugs, and the fifth planted bug breaks the *checker* so
its failure path can be watched to stop working.

```
$ node src/cli.js control
200 seeds of the correct build
  12600 crash points
  24496 crash schedules
  0 corrupt
  0 unverifiable
  396 ms
```

## Prior art, on the first line, because the method is not mine

The method is bounded black-box crash testing. It comes from ALICE/BOB
(Pillai et al., *All File Systems Are Not Created Equal*, OSDI 2014 - 60 crash
vulnerabilities across 11 filesystems) and from
[CrashMonkey/ACE](https://github.com/utsaslab/crashmonkey) (Mohan et al.,
*Finding Crash-Consistency Bugs with Bounded Black-Box Crash Testing*, OSDI
2018 - 24 bugs in production Linux filesystems, one of them in a formally
verified one). Their published finding, that crash-consistency bugs
overwhelmingly reproduce in three operations or fewer, is the entire reason a
bounded space is worth enumerating exhaustively instead of sampling.

cofferdam applies that method one layer up: not to a filesystem, but to an
application that *trusts* one.

## How this differs from kedge, the sibling project

Both plant bugs and check invariants, and that is where the similarity stops.
[kedge](https://github.com/jamessuuu/kedge) samples an enormous space randomly
by seed - a five-node Raft cluster has more executions than anyone can count, so
the honest move is to draw from it. cofferdam does the opposite: the space of
crash points in one workload is *small*, so the honest move is to visit all of
it and say exactly where the bound stopped. Random search that finds nothing
tells you nothing. Exhaustive search that finds nothing tells you something, but
only if it also tells you how far it got.

## Install and run it in 60 seconds

```sh
git clone https://github.com/jamessuuu/cofferdam && cd cofferdam
npm ci          # devDeps are TypeScript and node types; cofferdam has no runtime deps
npm run demo    # a corrupt recovery, explained
```

Or open `web/index.html` in a browser. It is a static page with no server, no
model, no dataset and no credentials, and its default view is a **failing** run,
so the failure is on the first screen.

## The worked example

`npm run demo` enumerates one workload against a build with
`rename-before-fsync` planted: the checkpoint renames the snapshot into place
before the snapshot's bytes are durable, and then throws the log away. Real
output:

```
$ node src/cli.js demo
cofferdam demo -- a corrupt recovery, on purpose.

seed 1  build rename-before-fsync  bound 4  24 mutations, 60 I/O operations
61 crash points, 378 crash schedules: 25 consistent, 36 corrupt, 0 unverifiable (16 ms)

    0  .........................XXXXXXXXXXXXXXXXXXXXXXXXX
   50  XXXXXXXXXXX

       . consistent   X corrupt   ? unverifiable

the first crash point that recovers to a state the API never produced
  crash point 25, interrupting: write log @0 +18B
  schedule    M0/D24
  lost 9 acknowledged mutation(s): recovered the state after 0 but 9 had been acknowledged
  snapshot: rejected: shorter than a header; log: replayed 0 record(s), stopped because end of log

  expected (the state after 9 mutations; 9 were acknowledged, 9 issued)
      k0     = v6 (488B, 33ef7160)
      k1     = v8 (4B, a51f1a1b)
      k2     = v9 (4B, a4dd702c)
      k3     = v3 (4B, a94af5fa)
  recovered
      (empty)
  diff
      - k0     v6 (488B, 33ef7160)  is gone
      - k1     v8 (4B, a51f1a1b)  is gone
      - k2     v9 (4B, a4dd702c)  is gone
      - k3     v3 (4B, a94af5fa)  is gone

Same workload, correct build:
  63 crash points, 115 crash schedules: 63 consistent, 0 corrupt, 0 unverifiable (2 ms)
```

The shape in the matrix is the diagnosis: everything before the checkpoint is
green, and everything after it is red, because the checkpoint is where the only
durable copy of the data got thrown away.

A subtler one is one command away. `checksum-skipped` removes the checksum
verification from recovery, and at seed 6 the enumeration finds exactly one
crash point where that matters:

```
$ node src/cli.js replay --seed 6 --build checksum-skipped --point 51 --schedule M0/D50/T50@1
CORRUPT -- recovered a state the API never produced: it matches no prefix of the workload

  ~ k2     v19 (560B, 89590963)  ->  v19 (560B, 5e24bda5)
```

Same key, same label, same length, different bytes. A 560-byte record was
written over a log whose truncation never landed, its first sector arrived and
its second did not, and the tail the reader saw was left over from the previous
generation. The record is exactly as long as it claims to be. Only the checksum
could have told.

## The three outcomes, and why the third one is not politeness

Every crash point comes back `consistent`, `corrupt`, or `unverifiable`.

The third is forced by the bound. At a crash point with *n* un-fsynced writes in
flight there are 2^n orderings. When *n* is at or below the reorder bound, all of
them are enumerated and the answer is real. When it is above, a fixed sample is
run instead - and a crash point whose sample found nothing has **not** been
shown to be safe. Reporting that as a pass would be the exact lie this project
exists to refuse. A corruption found under a sample is still definitive; an
absence under a sample is not evidence of anything.

What the bound costs, measured over 30 workloads of the correct build:

| reorder bound | consistent | corrupt | unverifiable |
|---|---|---|---|
| 0 | 1,050 | **0** | 840 |
| 1 | 1,830 | **0** | 60 |
| 2 | 1,890 | **0** | 0 |
| 4 (default) | 1,890 | **0** | 0 |

Reproduce it with `node src/cli.js control`. The reason bound 2 is already
enough is itself the finding: **the correct build never has more than two writes
in flight at once.** That is what an `fsync` after every record buys - the
reorder space stays small enough to finish, so these crash points are proven
rather than sampled. A build that acknowledges writes before flushing them does
not have that property, and its enumeration reports 4 unverifiable crash points
where the correct build reports none.

## What is actually in here

**`src/device.js`** - the modeled block device, and the only place the crash
model lives. Sector-atomic writes; a larger write may tear at a sector boundary.
Un-fsynced *data* writes may land in any subset, because independent sectors
under a write-back cache genuinely can. Un-fsynced *metadata* lands as a prefix
of issue order, because a journaling filesystem commits metadata transactions in
order - modelling 2^n metadata interleavings that no real journal produces would
manufacture corruptions that cannot happen. A data write to a file whose
directory entry never landed is dropped, not an error: the blocks went somewhere
nothing references.

**`src/store.js`** - the store. `put` appends a checksummed record and fsyncs
before returning. `checkpoint` writes a snapshot, fsyncs it, renames it into
place, fsyncs the directory, and only then truncates the log - and deliberately
does *not* fsync that truncation, because once the snapshot is durable the old
log is redundant. Recovery reads the snapshot, then replays log records whose
sequence numbers continue from it **contiguously**. That contiguity rule is what
stops a stale record, left behind by a checkpoint whose truncation never landed,
from being replayed on top of newer state.

**`src/enumerate.js`** - the enumerator. Crash points are every index into the
op stream. Schedules are (metadata prefix × data subset × at most one torn
write, torn at every sector boundary inside it). "At most one torn write" is
ACE's bound and it is taken for ACE's reason.

**`src/spec.js`** - the checker, and the only file that decides anything. The
contract in one sentence: *recovery yields the state after some prefix of the
issued mutations, and that prefix includes every mutation the API acknowledged
before the crash.* Because the writer is synchronous and single-threaded, at
most one mutation is ever in flight, so the legal answers at any crash point are
exactly two. Anything else is a state the API could not have produced.

**`src/targets/`** - the three real targets, below.

## The planted fixtures, and the negative control

A checker whose failure path has never been exercised is decoration. cofferdam
ships five build-flag bugs (`node src/cli.js bugs` lists them; all five live in
`src/bugs.js` and nothing is hidden elsewhere). Four break the store. The fifth
breaks the checker.

```
$ node src/cli.js fixtures
Planted fixtures (recipes in src/fixtures.js, measured 2026-09-06)
  OK   no-fsync-before-ack   30/30 seeds corrupt (floor 28), 960 corrupt crash points
  OK   torn-record-accepted  30/30 seeds corrupt (floor 28), 139 corrupt crash points
  OK   rename-before-fsync   30/30 seeds corrupt (floor 28), 1080 corrupt crash points
  OK   checksum-skipped      8/60 seeds corrupt (floor 5), 8 corrupt crash points
  OK   checker-accept-corrupt  the same enumeration reports 32 corrupt crash points honestly and 0 with the checker sabotaged
       and the sabotage is targeted, not a blanket pass: an invented-value corruption still fires (1 -> 1)

Negative control: 200 seeds of the correct build, 12600 crash points, 24496 crash schedules, 0 corrupt, 0 unverifiable (396 ms)
```

**The sabotaged checker is the one that matters.** `checker-accept-corrupt`
returns `consistent` at the exact point the validator has established that an
acknowledged mutation is missing. With it on, the enumeration over a store that
genuinely loses acknowledged writes reports **zero** corrupt crash points
instead of 32. That is what makes the corrupt verdict load-bearing rather than
incidental (`test/sabotage.test.js`).

It is also deliberately *targeted*. It forgives a lost acknowledged write and
nothing else, so a recovery that invented a value is still caught - 1 corrupt
crash point with the sabotage on and 1 with it off. A sabotage that just
returned `consistent` would prove nothing about which branch produces the
verdict.

**The negative control** is 200 workloads of the correct build: 12,600 crash
points, 24,496 crash schedules, zero corruptions, zero unverifiable. Without it,
"it found bugs" is indistinguishable from "it fires at random".

### Why `checksum-skipped` is rare and the others are not

Three of the four fire on every seed, because losing an unflushed write or
mis-validating a torn record needs one thing to go wrong. `checksum-skipped`
needs two at once: a checkpoint whose log truncation did not land, *and* a torn
write on top of the log it left behind. Scanning the first 1,000 seeds
reproduces it on 169 of them, and 8 of the first 60 - so its fixture sweeps 60
seeds against a floor of 5 rather than pretending it is a per-seed certainty.

## Three real targets

House rule: a checker is not done until it has run against three real targets
with the false positives removed. For a durability checker the honest real
targets are real durability contracts. Measured on Windows 11 / NTFS, Node
v24.15.0, seed 1, with `node src/cli.js targets`:

| target | verdict | crash points | result |
|---|---|---|---|
| **T3** model bytes vs NTFS bytes | consistent | 62 | 62 real operations, 1,142 bytes across 2 files, byte-identical to the model |
| **T1** the store on NTFS, real `SIGKILL` | consistent | 178 | 62 of 63 runs died to a real SIGKILL mid-workload; 115 modeled crash images were then written to real files and recovered through real file I/O, and 0 disagreed with the in-memory verdict |
| **T2** `node:sqlite`, WAL, `synchronous=FULL` | consistent | 25 | every committed transaction present, no state outside the workload |
| **T2** `node:sqlite`, WAL, `synchronous=OFF`, torn WAL | consistent | 97 | 0 integrity violations: every recovery is a prefix of the workload |

T3 runs first, because if the model does not reproduce the bytes NTFS actually
writes then every verdict the enumerator has ever produced is fiction.

### What T1 cannot do, which is the whole argument

**Killing a process does not lose the operating system's page cache.** Only a
power failure or a block-layer fault injector does that, and neither is
available in a portable Node test. So the fsync boundary - the one that matters
most - is unreachable by process kill, and that is measurable rather than
theoretical:

```
build no-fsync-before-ack, seed 1, on real NTFS
  39 real crash points, each one a real SIGKILL:      0 corrupt
  the same build on the modeled device:               32 corrupt crash points
  the same 3,714 modeled images on real files:        2,572 corrupt, 0 verdict mismatches
```

Twenty-four acknowledged writes, a store that never flushes any of them, and a
real process kill cannot see it. That is exactly why the bug ships in real
software, and exactly why the device is modeled.

### False positives found by real targets, and removed

1. **SQLite at `synchronous=OFF` "loses" committed transactions.** It does, and
   it never promised not to: at `OFF`, SQLite's documented contract is that a
   recent commit may be lost on power failure. Applying the durability half of
   cofferdam's specification there produced 69 corruption reports that were not
   defects. Removed by scoping: `OFF` is checked against the *integrity* half
   only - recovery must land on some prefix of the workload - and it passes 97
   real crash images with 0 violations. `FULL` gets the full contract.

2. **A truncated WAL below the schema transaction reads as "sqlite refused to
   open".** Cutting SQLite's `-wal` file below the frame that created the table
   leaves a database with no table at all, and the first run reported that as a
   corrupt recovery. It is not: it is the state after zero mutations, which is
   what losing the first transaction looks like. Removed by treating
   `no such table` as the empty state; every other SQLite error is still a
   failure to recover.

3. **A harness bug, not a checker bug, found by thinking about the first
   result.** Opening a SQLite database *recovers* it and can checkpoint and
   truncate the WAL. The first version of T2 applied its WAL truncations one
   after another to the same directory, so the second variant was not a crash
   image at all - it was the first variant's already-recovered database with a
   hole punched in it. Fixed by capturing every SQLite file once after the kill
   and restoring all of them before each variant.

### One real platform limitation, reported rather than swallowed

`fsync` on a **directory** is unavailable on Windows: opening one for reading
and calling `fsync` returns `EPERM`. The store's checkpoint ordering depends on
that barrier, so on this platform the barrier the model assumes is one the real
run cannot issue. T3 records it as a note on every run rather than passing
quietly. On Linux the same call works, which is why CI runs there too.

## What it does NOT do

- **Not a database.** No transactions, no range scans, no indexes, no
  compaction, no MVCC.
- **Not a replacement for SQLite or LevelDB**, and not a competitor to them  - 
  one of them is a target here. If you need durable storage, use one of those.
- **Single process, single writer, no concurrency model at all.** Every claim in
  this README depends on there being at most one mutation in flight. Concurrent
  writers would need a different specification, not a bigger bound.
- **Not a filesystem checker.** cofferdam checks an application that trusts a
  filesystem. Use CrashMonkey/ACE, or ALICE, for the layer below.
- **The device is modeled.** Its fidelity to NTFS is measured (T3), not assumed,
  but a model that matches on one op stream can still be wrong on another.
- **Cut from v1:** concurrent writers, a real block-device fault injector, group
  commit, `O_DIRECT`, and npm packaging.

### Known failure modes and limits

- Sub-sector tearing, bit rot, and a disk that lies about `fsync` are all real
  and all unmodelled. cofferdam assumes a sector either lands or does not.
- Torn writes are enumerated as *prefix* tears at sector boundaries, with at
  most one per schedule. A write whose middle sector alone failed to land is
  outside the enumerated space.
- The reorder bound is a real ceiling: `--bound` above 16 is refused because
  2^17 schedules per crash point does not finish.
- A schedule id names operations in one build's op stream. Replaying the buggy
  build's schedule against the correct build is a category error, and the CLI
  refuses it rather than replaying something that looks close enough.
- `node:sqlite` is not present in every Node build. When it is absent, T2
  reports **unverifiable** with the version that lacked it. It is not skipped
  and it is not a pass.
- The report page has been rendered and checked at 1280 and 1440 CSS pixels. It
  is written to reflow (fluid type, auto-fitting columns, the crash-point matrix
  scrolling inside its own container) but it has not been measured on a phone.

## Commands

```
cofferdam demo                   one corrupt recovery, explained
cofferdam enumerate [options]    visit every crash point of one workload
cofferdam replay [options]       replay one crash point under one schedule
cofferdam fixtures               the planted fixtures and the negative control
cofferdam control [options]      the negative control and the bound sweep
cofferdam targets [options]      the three real targets (spawns real processes)
cofferdam bugs                   list the planted fixtures
cofferdam verify <crashes.json>  re-run a committed report and compare
```

`enumerate` and `replay` take `--seed`, `--build`, `--bound`, `--point`,
`--schedule` and `--json`.

Bad input produces a stated error and a non-zero exit, never a stack trace:

```
$ node src/cli.js verify nope.json
cofferdam: no such file: nope.json

$ node src/cli.js enumerate --seed banana
cofferdam: --seed must be an integer, got "banana"

$ node src/cli.js enumerate --build not-a-bug
cofferdam: unknown build flag "not-a-bug"; known flags: checker-accept-corrupt,
checksum-skipped, no-fsync-before-ack, rename-before-fsync, torn-record-accepted
```

## The committed report

`crashes.json` is the whole run, written down: the negative control, every
fixture's fire rate, the bound sweep, the sabotage differential, five full
crash-point matrices, and the target results with the machine they were measured
on. `web/data.js` is the same object as one classic script, which is why the
report page opens from `file://` with no server and no `fetch`.

`node src/cli.js verify crashes.json` re-runs everything deterministic in it and
compares. The target section is reported **unverified**, not re-run: it spawns
real processes and its numbers belong to the machine that produced them.

```
$ node src/cli.js verify crashes.json
  MATCH      negative control        12600 crash points, 24496 schedules, 0 corrupt, 0 unverifiable
  MATCH      no-fsync-before-ack     30/30 seeds, 960 corrupt crash points
  MATCH      torn-record-accepted    30/30 seeds, 139 corrupt crash points
  MATCH      rename-before-fsync     30/30 seeds, 1080 corrupt crash points
  MATCH      checksum-skipped        8/60 seeds, 8 corrupt crash points
  UNVERIFIED real targets            4 target results recorded on win32, Node v24.15.0; ...
```

## Reproducing every number in this README

| claim | command |
|---|---|
| the negative control and the bound table | `node src/cli.js control` |
| fixture fire rates and the sabotage differential | `node src/cli.js fixtures` |
| the worked example | `node src/cli.js demo` |
| the torn-value corruption | `node src/cli.js replay --seed 6 --build checksum-skipped --point 51 --schedule M0/D50/T50@1` |
| the three real targets | `node src/cli.js targets` |
| the committed report still reproduces | `node src/cli.js verify crashes.json` |
| the sabotaged checker | `node --test "test/sabotage.test.js"` |
| determinism | `node --test "test/determinism.test.js"` |
| hostile input | `node --test "test/cli.test.js"` |
| everything | `npm test` (89 tests, ~10 s) |

Measured on Node v24.15.0, Windows 11, 2026-09-06. `engines.node` is `>=22.0.0`;
22 is the oldest version the test runner's glob support allows, and Node 24 is
what every number above was produced on.

**On CI, honestly:** `.github/workflows/ci.yml` installs from the lockfile on
pinned Node versions and runs lint, typecheck, report freshness, the full suite,
the control, the fixtures, the real targets and the demo on Linux (22.14.0 and
24.x), then the suite and the targets again on Windows. **It has never run**  - 
this repository has not been pushed to a remote, so there is no green badge and
this README will not imply one. What has been verified is the equivalent
locally: lint clean, typecheck clean, report fresh, 88 passing tests and 1
skipped (the `node:sqlite`-absent branch, which cannot run on a build that has
it), the control clean, every fixture firing, and all four target runs green.

## Development

```sh
npm test              # 89 tests
npm run lint          # a project-specific gate, not a style opinion engine
npm run typecheck     # tsc over JSDoc types
npm run build:report  # regenerate crashes.json and web/data.js
npm run check:report  # fail if either is stale
```

`npm run build:report -- --targets` also re-runs the three real targets and
records them. Without that flag the previously recorded target section is
carried forward unchanged, because pretending a target ran when it did not is
the failure mode this whole project is about.

## Credits and licence

cofferdam is MIT licensed - see [LICENSE](LICENSE). It has no runtime
dependencies.

- Bounded black-box crash testing: Mohan, Martinez, Ponnapalli, Raju &
  Chidambaram, *Finding Crash-Consistency Bugs with Bounded Black-Box Crash
  Testing*, OSDI 2018 (CrashMonkey and ACE).
- Application-level crash vulnerabilities: Pillai, Chidambaram, Alagappan,
  Al-Kiswany, Arpaci-Dusseau & Arpaci-Dusseau, *All File Systems Are Not Created
  Equal: On the Complexity of Crafting Crash-Consistent Applications*, OSDI 2014
  (ALICE and BOB).
- The store's shape is the ordinary one: a checksummed write-ahead log with
  periodic snapshots, as in SQLite's WAL, LevelDB, and every database that has
  ever had to survive a power cut.
- CRC-32 is IEEE 802.3, checked against published vectors in
  `test/crc32.test.js`.
