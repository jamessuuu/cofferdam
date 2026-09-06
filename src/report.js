// Turning an enumeration into something a person can read in ten seconds.
//
// The matrix is the point: one character per crash point, so the shape of a bug
// is visible before any of the words are. A run of X's starting at a checkpoint
// looks different from a scatter of them across every write, and that
// difference is the diagnosis.

/** @param {'consistent'|'corrupt'|'unverifiable'} v @returns {string} */
export function glyph(v) {
  return v === 'consistent' ? '.' : v === 'corrupt' ? 'X' : '?';
}

/**
 * @param {import('./enumerate.js').EnumerationResult} r
 * @param {number} [width]
 * @returns {string}
 */
export function renderMatrix(r, width = 50) {
  const lines = [];
  for (let start = 0; start < r.points.length; start += width) {
    const row = r.points.slice(start, start + width);
    lines.push(String(start).padStart(5) + '  ' + row.map((p) => glyph(p.verdict)).join(''));
  }
  lines.push('');
  lines.push('       . consistent   X corrupt   ? unverifiable');
  return lines.join('\n');
}

/**
 * @param {Array<{key:string, value:string}>} rows
 * @returns {string}
 */
function stateBlock(rows) {
  if (rows.length === 0) return '      (empty)';
  return rows.map((row) => '      ' + row.key.padEnd(6) + ' = ' + row.value).join('\n');
}

/**
 * @param {import('./enumerate.js').Finding} f
 * @returns {string}
 */
export function renderFinding(f) {
  const out = [];
  out.push('  crash point ' + f.crashPoint + ', interrupting: ' + f.op);
  out.push('  schedule    ' + f.schedule);
  out.push('  ' + f.reason);
  out.push('  ' + f.recoveryNote);
  out.push('');
  out.push('  expected (the state after ' + f.nearestPrefix + ' mutations; ' + f.acked +
    ' were acknowledged, ' + f.issued + ' issued)');
  out.push(stateBlock(f.expected));
  out.push('  recovered');
  out.push(stateBlock(f.got));
  out.push('  diff');
  for (const d of f.diff) {
    if (d.kind === 'missing') out.push('      - ' + d.key.padEnd(6) + ' ' + d.expected + '  is gone');
    else if (d.kind === 'extra') out.push('      + ' + d.key.padEnd(6) + ' ' + d.got + '  should not exist');
    else out.push('      ~ ' + d.key.padEnd(6) + ' ' + d.expected + '  ->  ' + d.got);
  }
  if (f.diff.length === 0) out.push('      (the states differ only in ordering, which cannot happen; report this)');
  return out.join('\n');
}

/**
 * @param {import('./enumerate.js').EnumerationResult} r
 * @returns {string}
 */
export function renderSummary(r) {
  return 'seed ' + r.seed + '  build ' + r.build + '  bound ' + r.bound + '  ' +
    r.mutations + ' mutations, ' + r.opCount + ' I/O operations\n' +
    r.crashPoints + ' crash points, ' + r.schedules + ' crash schedules: ' +
    r.consistent + ' consistent, ' + r.corrupt + ' corrupt, ' + r.unverifiable + ' unverifiable ' +
    '(' + Math.round(r.ms) + ' ms)';
}

/**
 * @param {import('./targets/run.js').TargetResult[]} results
 * @returns {string}
 */
export function renderTargets(results) {
  const out = [];
  for (const t of results) {
    out.push(t.id.padEnd(8) + t.verdict.toUpperCase().padEnd(14) + t.title);
    out.push('        ' + t.detail);
    for (const n of t.notes) out.push('        note: ' + n);
    out.push('');
  }
  return out.join('\n').trimEnd();
}
