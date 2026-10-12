// local-chat-tools.js — resolves the local GUI Chat's tool menu: the curated core, or the CE_LOCAL_CHAT_TOOLS override
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.

// Local models degrade sharply as the tool menu grows (see
// docs/cloud-gpu-chat-testing.md, First-run findings + Cross-model matrix:
// 8B/14B collapse to zero calls or garbage args at the full menu; even 32B
// args degrade). This core is the menu measured to work; it is the product.
export const CURATED_LOCAL_CHAT_TOOLS = ['search', 'extract', 'show_file', 'callers',
  'callees', 'digest', 'overview', 'list_functions'];

/**
 * Resolve the tool names the local Chat exposes.
 *
 *   spec        the CE_LOCAL_CHAT_TOOLS value; unset or empty keeps the core
 *                 'all'     every registered tool
 *                 '+a,b'    the core plus a and b
 *                 'a,b'     exactly a and b
 *   registered  the names in the MCP TOOLS table
 *   curated     the core (default: CURATED_LOCAL_CHAT_TOOLS)
 *
 * Returns { names, note }. `note` is a one-line message for stderr whenever
 * the menu differs from the core or names were ignored, so an unmeasured menu
 * is never silent; null when the core is in force. Pure: no environment read,
 * no output — the caller (src/server.js) does both once at startup.
 */
export function resolveLocalChatTools(spec, registered, curated = CURATED_LOCAL_CHAT_TOOLS) {
  const reg = new Set(registered || []);
  const core = curated.filter((n) => reg.has(n));
  const s = String(spec || '').trim();
  if (!s) return { names: core, note: null };

  if (s.toLowerCase() === 'all') {
    return {
      names: [...reg],
      note: `[local-chat] tool menu: all ${reg.size} tools via CE_LOCAL_CHAT_TOOLS=all`
        + ` (the curated core is ${core.length}; small models were measured collapsing at the full menu)`,
    };
  }

  const extend = s.startsWith('+');
  const asked = (extend ? s.slice(1) : s).split(/[,\s]+/).map((n) => n.trim()).filter(Boolean);
  const unknown = asked.filter((n) => !reg.has(n));
  const known = asked.filter((n) => reg.has(n));
  const named = extend ? [...core, ...known.filter((n) => !core.includes(n))] : [...new Set(known)];
  const ignored = unknown.length ? `; unknown tool name(s) ignored: ${unknown.join(', ')}` : '';

  if (!named.length) {
    return { names: core, note: `[local-chat] CE_LOCAL_CHAT_TOOLS named no registered tool; using the curated core of ${core.length}${ignored}` };
  }
  const sameAsCore = named.length === core.length && named.every((n) => core.includes(n));
  if (sameAsCore) {
    return { names: core, note: unknown.length ? `[local-chat] tool menu: the curated core of ${core.length}${ignored}` : null };
  }
  return {
    names: named,
    note: `[local-chat] tool menu: ${named.length} tools via CE_LOCAL_CHAT_TOOLS`
      + ` (the curated core is ${core.length}; a menu other than the core is unmeasured for small models)${ignored}`,
  };
}
