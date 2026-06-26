#!/usr/bin/env python3
"""multi_index_diff.py - section-aware diff for CodeExam --multi-index output.

A `--multi-index` run concatenates per-index sections, each headed
`=== .index_name ===`. A plain `diff` of two such runs loses the header context
for changes that sit deep inside a section, so you can't tell which codebase a
changed row belongs to. This splits both files on those headers, diffs matching
sections, and labels every hunk with its index.

Usage:
    python multi_index_diff.py OLD.txt NEW.txt

Lines are COMPARED with whitespace compressed (runs of spaces/tabs collapsed,
ends stripped) so a pure column-alignment change (e.g. a widened Model column
shifting File:line) is not treated as a diff; the ORIGINAL lines are what gets
displayed. On the llm_calls_3 -> llm_calls_4 pair this cut the output from
~5600 lines to ~660 (only genuine content changes survive).

Output: a `## .index_name` banner before each section's hunks, then a unified
diff for that section (context lines = 2) showing the original lines. Indexes
present in only one file are reported as [added index] / [removed index]. Exit 0
whether or not differences were found; 2 on a usage error.

Pure stdlib (difflib, re, sys) - runs under the stock Windows Python.
"""
import sys
import re
import difflib

HEADER_RE = re.compile(r'^=== (\.\S+) ===\s*$')
PREAMBLE = '(preamble)'


def split_sections(lines):
    """Split lines into ordered (name, body_lines). The `=== .name ===` header
    line itself is the delimiter and is not included in any body. Content before
    the first header (if any) is keyed as PREAMBLE."""
    sections = []
    name = PREAMBLE
    body = []
    for ln in lines:
        m = HEADER_RE.match(ln)
        if m:
            if body or name != PREAMBLE:
                sections.append((name, body))
            name = m.group(1)
            body = []
        else:
            body.append(ln)
    if body or name != PREAMBLE:
        sections.append((name, body))
    return sections


def ordered_dict(sections):
    """Return ({name: body}, [names in order]). On a duplicate index name the
    later section wins for the body but the name keeps its first position."""
    d = {}
    order = []
    for name, body in sections:
        if name not in d:
            order.append(name)
        d[name] = body
    return d, order


def read_lines(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read().splitlines()


def _compress(line):
    """Whitespace-compress a line for COMPARISON: collapse runs of spaces/tabs
    to one space and strip the ends (cf. awk `gsub(/[ \\t]+/, " ", $0)`), so a
    pure column-alignment change (e.g. a widened Model column shifting File:line)
    doesn't register as a diff. The original line is still what gets displayed."""
    return re.sub(r'[ \t]+', ' ', line).strip()


def _fmt_range(start, stop):
    """Unified-diff range field (1-based start, length), matching difflib."""
    length = stop - start
    if length == 1:
        return str(start + 1)
    if length == 0:
        return '%d,0' % start
    return '%d,%d' % (start + 1, length)


def diff_by_key(a, b, n=2):
    """Unified diff that COMPARES whitespace-compressed lines but EMITS the
    original lines. Returns [] when the two sides are equal after compression."""
    sm = difflib.SequenceMatcher(None, [_compress(x) for x in a],
                                 [_compress(x) for x in b])
    out = []
    for group in sm.get_grouped_opcodes(n):
        first, last = group[0], group[-1]
        out.append('@@ -%s +%s @@' % (_fmt_range(first[1], last[2]),
                                      _fmt_range(first[3], last[4])))
        for tag, i1, i2, j1, j2 in group:
            if tag == 'equal':
                for line in a[i1:i2]:
                    out.append(' ' + line)
            else:
                for line in a[i1:i2]:
                    out.append('-' + line)
                for line in b[j1:j2]:
                    out.append('+' + line)
    return out


def main(argv):
    # CodeExam rows contain non-cp1252 chars (the `->` arrow U+2192, box-drawing);
    # Win11 Python defaults stdout to the console codepage, so force UTF-8.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    if len(argv) != 3:
        sys.stderr.write('usage: python multi_index_diff.py OLD.txt NEW.txt\n')
        return 2
    old_d, old_order = ordered_dict(split_sections(read_lines(argv[1])))
    new_d, new_order = ordered_dict(split_sections(read_lines(argv[2])))

    names = list(old_order)
    for n in new_order:
        if n not in names:
            names.append(n)

    changed = 0
    for name in names:
        in_old, in_new = name in old_d, name in new_d
        if in_old and not in_new:
            print('## %s  [removed index]\n' % name)
            changed += 1
            continue
        if in_new and not in_old:
            print('## %s  [added index]\n' % name)
            changed += 1
            continue
        a, b = old_d[name], new_d[name]
        hunks = diff_by_key(a, b, n=2)
        if not hunks:
            continue  # only column-alignment differed; not a real change
        changed += 1
        print('## %s' % name)
        for l in hunks:
            print(l)
        print()

    if not changed:
        print('(no differences across %d indexes)' % len(names))
    else:
        sys.stderr.write('%d of %d indexes changed\n' % (changed, len(names)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
