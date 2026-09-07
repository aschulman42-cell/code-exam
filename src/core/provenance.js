// provenance.js — builds the print-out provenance banner (version, index, command, AI engine) and masks secrets in argv
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * provenance.js — #215: provenance header for CE-generated output.
 *
 * One builder assembles the banner every surface uses, so surfaces can't
 * drift apart. Phase 1 wires it into CLI stdout via the opt-in
 * `--provenance` flag (default OFF, so machine-readable/piped output stays
 * clean); Phase 2 is the GUI save surfaces (pane 💾 / chat save), which are
 * client-side in public/ and will call the same field set.
 *
 * "Provenance" here really means FILE HEADERS FOR PRINT-OUTS. In CodeExam's
 * litigation context — source-code examination under protective orders —
 * this header is the seed of a print-out discipline that later phases are
 * expected to support (Andrew, 2026-07-04; recorded here so the requirements
 * travel with the code — see #215 and #55, print-to-PDF litigation extras):
 *
 *   - printing source-code EXTRACTS and whole FILES, not just CE command
 *     output — the header must make sense on top of someone else's code;
 *   - line numbers ON vs OFF as a first-class toggle;
 *   - a designated slot for confidentiality banners, e.g.
 *     "CONFIDENTIAL SOURCE CODE — ATTORNEY'S EYES ONLY";
 *   - possibly Bates numbering;
 *   - enforcing protective-order PRINT LIMITS: maximum pages, maximum
 *     consecutive lines or pages printed, and similar caps that protective
 *     orders commonly impose.
 *
 * None of that is implemented yet. The banner's shape — labeled fields
 * between fixed-width rules, built from an options object — is chosen so
 * those can be added without breaking existing consumers.
 */

const RULE = '='.repeat(78);
export const CE_REPO_URL = 'https://github.com/aschulman42-cell/code-exam';

/**
 * Build the provenance banner text (no trailing newline).
 *
 * All fields optional; only supplied ones are printed. The AI line is
 * included only when an engine/model is known — the AI portion is the part
 * that is NOT deterministically reproducible, so it most needs provenance.
 *
 * @param {object} opts
 * @param {string} [opts.version]    e.g. CE_VERSION from version.js
 * @param {string} [opts.indexPath]  index directory the output derives from
 * @param {number} [opts.fileCount]  files in that index
 * @param {string} [opts.command]    invoking command line (pre-sanitized —
 *                                   use sanitizedCommandLine())
 * @param {string} [opts.engine]     AI engine when one is in play ('claude',
 *                                   'openai', 'local')
 * @param {string} [opts.model]      AI model id or GGUF filename
 * @param {string} [opts.banner]     confidentiality banner line (future
 *                                   litigation slot — printed prominently
 *                                   when provided)
 * @param {string} [opts.subject]    what this artifact IS — e.g. the full
 *                                   source path being viewed, or the chat's
 *                                   engine + grounding. Supplied pre-labeled
 *                                   by the caller (surfaces vary), printed
 *                                   verbatim on its own line. Capped so a
 *                                   client can't bloat the header.
 */
export function buildProvenanceHeader({ version, indexPath, fileCount, command, engine, model, banner, subject } = {}) {
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines = [RULE];
  if (banner) { lines.push(banner, RULE); }
  lines.push(`CodeExam ${version || '(unknown version)'} — generated ${when}`);
  lines.push(`Tool source: ${CE_REPO_URL}`);
  if (subject) lines.push(String(subject).replace(/[\r\n]+/g, ' ').slice(0, 300));
  if (indexPath) lines.push(`Index: ${indexPath}${fileCount ? `  (${fileCount} files)` : ''}`);
  if (command) lines.push(`Command: ${command}`);
  if (engine || model) {
    lines.push(`AI: ${[engine, model].filter(Boolean).join(' — ')}  (AI output is not deterministically reproducible)`);
  }
  lines.push(RULE);
  return lines.join('\n');
}

/**
 * The invoking command line with secret values MASKED. Never echo raw argv
 * into a saved artifact: --api-key / --key / --openai-key take secrets as
 * the NEXT token (or after '=').
 */
export function sanitizedCommandLine(argv = process.argv) {
  const SECRET_FLAGS = new Set(['--api-key', '--key', '--openai-key', '--openai_key']);
  const parts = [];
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    let tok = args[i];
    const eq = tok.indexOf('=');
    const flag = (eq > 0 ? tok.slice(0, eq) : tok).replace(/_/g, '-');
    if (SECRET_FLAGS.has(flag)) {
      if (eq > 0) { parts.push(`${tok.slice(0, eq)}=***`); continue; }
      parts.push(tok);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) { parts.push('***'); i++; }
      continue;
    }
    parts.push(tok);
  }
  return `ce ${parts.join(' ')}`.trim();
}
