/**
 * infrastructure.js (command) — --infrastructure / --infra (#168).
 *
 * Prints the non-AI/ML operational stack (Containers / Kubernetes / IaC /
 * CI-CD) detected by file shape. Mechanical findings unmarked; heuristic
 * (content-sniffed) findings marked `~`, mirroring the AI/ML cells.
 */

import { detectInfrastructure } from '../core/stack-detectors.js';
import { makeFilterMatcher } from '../core/filter-match.js';

const CAP = 20;  // per-cell rows shown unless -v

export function doInfrastructure(index, args) {
  const { rows, filesScanned } = detectInfrastructure(index);
  const match = args.filter ? makeFilterMatcher(args.filter) : null;
  const found = rows.filter(r => !match || match(r.name, r.filepath, r.cell, r.kind));

  if (found.length === 0) {
    console.log(`Infrastructure: no Containers / Kubernetes / IaC / CI-CD artifacts found` +
      `${args.filter ? ` (filter '${args.filter}')` : ''}.`);
    console.log(`  Scanned ${filesScanned} indexed files. Note: bare Dockerfile/Jenkinsfile ` +
      `aren't indexed yet (extensionless) — see #168.`);
    return;
  }

  const byCell = new Map();
  for (const r of found) {
    if (!byCell.has(r.cell)) byCell.set(r.cell, []);
    byCell.get(r.cell).push(r);
  }

  console.log(`Infrastructure — ${found.length} artifact(s) across ${byCell.size} cell(s)` +
    `${args.filter ? ` — filter: '${args.filter}'` : ''}\n`);

  for (const cell of [...byCell.keys()].sort()) {
    const items = byCell.get(cell).sort((a, b) => a.filepath.localeCompare(b.filepath));
    const kinds = {};
    for (const r of items) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    const kindStr = Object.entries(kinds).map(([k, n]) => `${k}:${n}`).join(', ');
    console.log(`${cell}  (${items.length})  ${kindStr}`);
    const shown = args.verbose ? items : items.slice(0, CAP);
    for (const r of shown) {
      const marker = r.marker ? ` · ${r.marker}` : '';
      console.log(`  ${r.filepath}:${r.line}  [${r.kind}${marker}${r.tag === 'heuristic' ? ' ~' : ''}]`);
    }
    if (!args.verbose && items.length > CAP) {
      console.log(`  ... (${items.length - CAP} more — -v for all)`);
    }
    console.log('');
  }
  console.log(`  ~ = heuristic (content-sniffed); others mechanical (filename/extension). ` +
    `Scanned ${filesScanned} files.`);
}
