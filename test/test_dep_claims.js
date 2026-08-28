/**
 * test_dep_claims.js -- #311 step 1: chains across a claim set (src/core/dep-claims.js).
 *
 * The real-family test uses US 7,047,526 (Cisco, 26 claims) with the parent / root / depth that
 * patents.google.com's markup carries, fetched 2026-08-27: the module must reproduce that graph from
 * the claim text alone. The synthetic sets cover what one family cannot: forward references,
 * multi-parent choice, the contribution kinds, the cross-class variants, unresolvable parents,
 * cycles, and the residue report.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeClaimSet, classifyContribution, chainOf, depthLabel, formatDepReport, PARENT_POLICIES,
} from '../src/core/dep-claims.js';

// US 7,047,526 (Cisco), all 26 claims as fetched by litigated-claims-fetch.mjs on 2026-08-27, with the
// parent / root / depth that patents.google.com's claim markup carries -- ground truth the module must
// reproduce from the text alone.
const FAMILY_7047526 = [
  { n: 1, parent: null, root: 1, depth: 0, text: "A method in a processor-based system configured for executing a plurality of management programs according to respective command formats, the method comprising: receiving a generic command from the user; validating the generic command based on a command parse tree that specifies valid generic commands relative to a prescribed generic command format, the command parse tree having elements each specifying at least one corresponding generic command component and a corresponding at least one command action value, the validating step including identifying one of the elements as a best match relative to the generic command; and issuing a prescribed command of a selected one of the management programs according to the corresponding command format, based on the identified one element." },
  { n: 2, parent: 1, root: 1, depth: 1, text: "The method of claim 1 , wherein the generic command includes at least one input command word, the validating step including: comparing each input command word to a command word translation table, configured for storing for each prescribed command word a corresponding token, for identification of a matching token; and determining a presence of the matching token within the command parse tree for each input command word." },
  { n: 3, parent: 2, root: 1, depth: 2, text: "The method of claim 2 , wherein the determining step includes recursively traversing the command parse tree based on an order of the input command words for identification of the matching token within the identified one element." },
  { n: 4, parent: 3, root: 1, depth: 3, text: "The method of claim 3 , wherein the issuing step includes issuing the prescribed command based on a corresponding command key specified for the matching token within the identified one element." },
  { n: 5, parent: 4, root: 1, depth: 4, text: "The method of claim 4 , wherein the issuing step further includes accessing a prescribed translator configured for converting the generic command according to the corresponding command format into the prescribed command based on the corresponding command key." },
  { n: 6, parent: 5, root: 1, depth: 5, text: "The method of claim 5 , wherein the validating step including validating at least a portion of the generic command by identifying the one element having the best match relative to the portion of the generic command, the issuing step including issuing the prescribed command based on the identified one element corresponding to the portion of the generic command." },
  { n: 7, parent: 6, root: 1, depth: 6, text: "The method of claim 6 , further comprising executing the prescribed command within the corresponding selected one management program." },
  { n: 8, parent: 1, root: 1, depth: 1, text: "The method of claim 1 , wherein the validating step including validating at least a portion of the generic command by identifying the one element having the best match relative to the portion of the generic command, the issuing step including issuing the prescribed command based on the identified one element corresponding to the portion of the generic command." },
  { n: 9, parent: 8, root: 1, depth: 2, text: "The method of claim 8 , further comprising executing the prescribed command within the corresponding selected one management program." },
  { n: 10, parent: null, root: 10, depth: 0, text: "A system configured for executing a plurality of management programs according to respective command formats, the system comprising: a parser having a command parse tree configured for validating a generic command received from a user, the command parse tree configured for specifying valid generic commands relative to a prescribed generic command format and having elements each specifying at least one corresponding generic command component and a corresponding at least one command action value, the parser identifying one of the elements as a best match relative to the generic command; and a plurality of translators configured for issuing commands for the management programs according to respective command formats, the parser outputting a prescribed command to a selected one of the translators based on the identified one element." },
  { n: 11, parent: 10, root: 10, depth: 1, text: "The system of claim 10 , wherein the parser further comprises a command word translation table configured for storing for each prescribed command word a corresponding token for identification of a matching token, the parser configured for determining a presence of the matching token within the command parse tree for each input command word." },
  { n: 12, parent: 11, root: 10, depth: 2, text: "The system of claim 11 , wherein the parser recursively traverses the command parse tree based on an order of the input command words for identification of the matching token within the identified one element." },
  { n: 13, parent: 12, root: 10, depth: 3, text: "The system of claim 12 , wherein the parser validates at least a portion of the generic command by identifying the one element having the best match relative to the portion of the generic command." },
  { n: 14, parent: null, root: 14, depth: 0, text: "A computer readable medium having stored thereon sequences of instructions for executing a plurality of management programs according to respective command formats, the sequences of instructions including instructions for performing the steps of: receiving a generic command from the user; validating the generic command based on a command parse tree that specifies valid generic commands relative to a prescribed generic command format, the command parse tree having elements each specifying at least one corresponding generic command component and a corresponding at least one command action value, the validating step including identifying one of the elements as a best match relative to the generic command; and issuing a prescribed command of a selected one of the management programs according to the corresponding command format, based on the identified one element." },
  { n: 15, parent: 14, root: 14, depth: 1, text: "The medium of claim 14 , wherein the generic command includes at least one input command word, the validating step including: comparing each input command word to a command word translation table, configured for storing for each prescribed command word a corresponding token, for identification of a matching token; and determining a presence of the matching token within the command parse tree for each input command word." },
  { n: 16, parent: 15, root: 14, depth: 2, text: "The medium of claim 15 , wherein the determining step includes recursively traversing the command parse tree based on an order of the input command words for identification of the matching token within the identified one element." },
  { n: 17, parent: 16, root: 14, depth: 3, text: "The medium of claim 16 , wherein the issuing step includes issuing the prescribed command based on a corresponding command key specified for the matching token within the identified one element." },
  { n: 18, parent: 17, root: 14, depth: 4, text: "The medium of claim 17 , wherein the issuing step further includes accessing a prescribed translator configured for converting the generic command according to the corresponding command format into the prescribed command based on the corresponding command key." },
  { n: 19, parent: 18, root: 14, depth: 5, text: "The medium of claim 18 , wherein the validating step including validating at least a portion of the generic command by identifying the one element having the best match relative to the portion of the generic command, the issuing step including issuing the prescribed command based on the identified one element corresponding to the portion of the generic command." },
  { n: 20, parent: 19, root: 14, depth: 6, text: "The medium of claim 19 , further comprising instructions for performing the step of executing the prescribed command within the corresponding selected one management program." },
  { n: 21, parent: 14, root: 14, depth: 1, text: "The medium of claim 14 , wherein the validating step including validating at least a portion of the generic command by identifying the one element having the best match relative to the portion of the generic command, the issuing step including issuing the prescribed command based on the identified one element corresponding to the portion of the generic command." },
  { n: 22, parent: 21, root: 14, depth: 2, text: "The medium of claim 21 , further comprising instructions for performing the step of executing the prescribed command within the corresponding selected one management program." },
  { n: 23, parent: null, root: 23, depth: 0, text: "A system configured for executing a plurality of management programs according to respective command formats, the system comprising: means for validating a generic command received from a user, the validating means configured for specifying valid generic commands relative to a prescribed generic command format and having elements each specifying at least one corresponding generic command component and a corresponding at least one command action value, the validating means identifying one of the elements as a best match relative to the generic command; and a plurality of translators configured for issuing commands for the management programs according to respective command formats, the validating means outputting a prescribed command to a selected one of the translators based on the identified one element." },
  { n: 24, parent: 23, root: 23, depth: 1, text: "The system of claim 23 , wherein the validating means comprises a command word translation table configured for storing for each prescribed command word a corresponding token for identification of a matching token, the validating means configured for determining a presence of the matching token for each input command word." },
  { n: 25, parent: 24, root: 23, depth: 2, text: "The system of claim 24 , wherein the validating means recursively validates each input command word based on an order of the input command words for identification of the matching token within the identified one element." },
  { n: 26, parent: 25, root: 23, depth: 3, text: "The system of claim 25 , wherein the validating means validates at least a portion of the generic command by identifying the one element having the best match relative to the portion of the generic command." },
];

describe('dep-claims: a real 26-claim family reproduces Google’s chain from text alone', () => {
  const res = analyzeClaimSet(FAMILY_7047526.map((c) => ({ n: c.n, text: c.text })));
  it('classifies the independents and dependents exactly', () => {
    const ind = FAMILY_7047526.filter((c) => c.parent == null).map((c) => c.n);
    assert.deepEqual(res.claims.filter((r) => !r.dependent).map((r) => r.n), ind);
    assert.equal(res.report.dependent, FAMILY_7047526.length - ind.length);
    assert.equal(res.report.ambiguous.length, 0);
    assert.equal(res.report.missingParent.length, 0);
    assert.equal(res.report.cycles.length, 0);
  });
  it('resolves every parent to the one Google records', () => {
    for (const c of FAMILY_7047526) {
      const r = res.byNumber.get(c.n);
      assert.equal(r.parent, c.parent, `claim ${c.n}: parent ${r.parent} vs Google ${c.parent}`);
    }
  });
  it('reproduces every depth, with I / D / D2 ... labels, and the root of every chain', () => {
    // Google's depth counts the independent as 0 -- the same convention as depthLabel.
    for (const c of FAMILY_7047526) {
      const r = res.byNumber.get(c.n);
      assert.equal(r.depth, c.depth, `claim ${c.n}: depth ${r.depth} vs Google ${c.depth}`);
      assert.equal(r.depthLabel, depthLabel(c.depth));
      if (c.parent != null) assert.equal(chainOf(res, c.n)[0], c.root, `claim ${c.n}: chain root`);
    }
    assert.equal(res.report.byDepth.I, FAMILY_7047526.filter((c) => c.depth === 0).length);
  });
  it('classifies each dependent’s contribution from its cues, and reports the split honestly', () => {
    const deps = FAMILY_7047526.filter((c) => c.parent != null);
    const hasAdd = (t) => /\bfurther\s+(?:comprising|comprises|including|includes)\b/i.test(t);
    const hasMod = (t) => /\b(?:wherein|in which)\b/i.test(t);
    const modOnly = deps.filter((c) => hasMod(c.text) && !hasAdd(c.text)).length;
    const addOnly = deps.filter((c) => hasAdd(c.text) && !hasMod(c.text)).length;
    const both = deps.filter((c) => hasAdd(c.text) && hasMod(c.text)).length;
    assert.equal(res.report.byContribution.MODIFICATION, modOnly);
    assert.equal(res.report.byContribution.ADDITION, addOnly);
    // Claims 5 and 11 say "wherein the ... step further includes ..." -- a narrowing cue with an
    // addition cue nested inside it. The design reports UNDETERMINED rather than guessing (a wrong
    // call silently skips a re-evaluation); a leading-cue rule ("the first cue governs") is the
    // obvious refinement and is deliberately NOT applied here without a corpus measurement.
    assert.equal(res.report.byContribution.UNDETERMINED, both);
    assert.ok(both >= 2, `nested-cue rows in this family: ${both}`);
    for (const c of deps.filter((c) => hasAdd(c.text) && hasMod(c.text))) {
      assert.equal(res.byNumber.get(c.n).contribution.kind, 'UNDETERMINED', `claim ${c.n}`);
      assert.match(res.byNumber.get(c.n).contribution.note, /both/);
    }
    assert.equal(modOnly + addOnly + both, deps.length, 'every dependent is classified');
    assert.equal(res.report.byContribution['PRODUCT-BY-PROCESS'] + res.report.byContribution.COMBINATION, 0);
  });
  it('the report is readable', () => {
    const lines = formatDepReport(res);
    assert.match(lines[0], /^26 claim\(s\): \d+ independent .* \d+ dependent, \d+ with a resolved parent$/);
    assert.match(lines[1], /depth: /);
  });
});

describe('dep-claims: depth labels', () => {
  it('I, D, D2, D3 ...', () => {
    assert.equal(depthLabel(0), 'I');
    assert.equal(depthLabel(1), 'D');
    assert.equal(depthLabel(2), 'D2');
    assert.equal(depthLabel(5), 'D5');
    assert.equal(depthLabel(null), null);
  });
});

describe('dep-claims: forward references resolve (claimlen.awk: 5,677,880 #31 depends on #32)', () => {
  it('a claim may depend on a later independent claim; resolution is not single-pass', () => {
    const res = analyzeClaimSet([
      { n: 31, text: '31. The apparatus of claim 32, wherein the housing is magnetic.' },
      { n: 32, text: '32. An apparatus comprising a housing and a sensor mounted in the housing.' },
    ]);
    const r = res.byNumber.get(31);
    assert.equal(r.parent, 32);
    assert.equal(r.forward, true);
    assert.equal(r.depthLabel, 'D');
    assert.deepEqual(chainOf(res, 31), [32, 31]);
    assert.deepEqual(res.report.forward, [{ n: 31, parent: 32 }]);
  });
});

describe('dep-claims: multi-parent references choose a parent and SAY so', () => {
  const set = [
    { n: 1, text: '1. A method comprising receiving a packet and forwarding the packet according to a routing table having a plurality of entries each carrying a next hop.' },
    { n: 2, text: '2. A method comprising receiving a packet.' },
    { n: 3, text: '3. The method of claim 1 or 2, wherein the packet is an IP packet.' },
    { n: 4, text: '4. The method of any one of claims 1 to 3, further comprising logging the packet.' },
  ];
  it('shortest-parent (default) takes the broadest parent present and lists the alternatives', () => {
    const res = analyzeClaimSet(set);
    const r3 = res.byNumber.get(3);
    assert.equal(r3.parent, 2, 'claim 2 is the shorter, broader parent');
    assert.deepEqual(r3.parentChoice.alternatives, [1]);
    assert.equal(r3.parentChoice.policy, 'shortest-parent');
    assert.equal(res.report.multiParent.length, 2);
    assert.match(formatDepReport(res).join('\n'), /claim 3: multi-parent reference; chose 2 by shortest-parent \(alternatives 1\)/);
  });
  it('first-listed is the alternative policy; an unknown policy throws rather than defaulting silently', () => {
    const res = analyzeClaimSet(set, { policy: 'first-listed' });
    assert.equal(res.byNumber.get(3).parent, 1);
    assert.throws(() => analyzeClaimSet(set, { policy: 'longest' }), /unknown parent policy/);
    assert.ok(Object.keys(PARENT_POLICIES).includes('shortest-parent'));
  });
  it('a range with the chosen parent itself dependent still chains to the root', () => {
    const res = analyzeClaimSet(set);
    const r4 = res.byNumber.get(4);   // claims 1 to 3: shortest present is 2 ("A method comprising receiving a packet.")
    assert.equal(r4.parent, 2);
    assert.deepEqual(chainOf(res, 4), [2, 4]);
  });
});

describe('dep-claims: contribution -- ADDITION re-opens nothing, MODIFICATION re-opens a verdict', () => {
  it('further comprising -> ADDITION; wherein / in which -> MODIFICATION', () => {
    assert.equal(classifyContribution('The method of claim 1, further comprising sending the response to the first user.').kind, 'ADDITION');
    assert.equal(classifyContribution('The apparatus of claim one, wherein said casing is magnetic.').kind, 'MODIFICATION');
    assert.equal(classifyContribution('The method of claim 3 in which the threshold is fixed.').kind, 'MODIFICATION');
  });
  it('both cues, or neither, is UNDETERMINED -- never guessed (111 of 1,139 on the 2026-08-24 corpus)', () => {
    const both = classifyContribution('The method of claim 1, further comprising a filter, wherein the filter is a low-pass filter.');
    assert.equal(both.kind, 'UNDETERMINED');
    assert.match(both.note, /both/);
    const neither = classifyContribution('The method of claim 2 with the packet encrypted.');
    assert.equal(neither.kind, 'UNDETERMINED');
    assert.match(neither.note, /neither/);
  });
  it('cross-class references are their own kinds, never forced into (a)/(b)', () => {
    assert.equal(classifyContribution('A stent comprising a coating formed by the method of claim 1.').kind, 'PRODUCT-BY-PROCESS');
    assert.equal(classifyContribution('A product produced by the process of claim 3, wherein the product is dried.').kind, 'PRODUCT-BY-PROCESS');
    assert.equal(classifyContribution('A combination comprising: the system of claim 17 and a sensor.').kind, 'COMBINATION');
  });
  it('the variants ride the chain machinery like any dependent', () => {
    const res = analyzeClaimSet([
      { n: 1, text: '1. A method of forming a coating comprising spraying a polymer onto a substrate.' },
      { n: 2, text: '2. A stent comprising a coating formed by the method of claim 1.' },
    ]);
    const r2 = res.byNumber.get(2);
    assert.equal(r2.dependent, true);
    assert.equal(r2.parent, 1);
    assert.equal(r2.contribution.kind, 'PRODUCT-BY-PROCESS');
    assert.equal(res.report.byContribution['PRODUCT-BY-PROCESS'], 1);
  });
});

describe('dep-claims: what will not resolve is reported, never downgraded', () => {
  it('a dependent with no recoverable number stays dependent and is listed AMBIGUOUS', () => {
    const res = analyzeClaimSet([
      { n: 1, text: '1. A process comprising heating a first material.' },
      { n: 2, text: '2. The process of claim wherein said first material is a metal.' },
    ]);
    const r2 = res.byNumber.get(2);
    assert.equal(r2.dependent, true);
    assert.equal(r2.parent, null);
    assert.equal(r2.depthLabel, null, 'depth is unknown, not assumed');
    assert.equal(res.report.dependent, 2 - 1);
    assert.equal(res.report.ambiguous.length, 1);
    assert.equal(res.report.ambiguous[0].n, 2);
    assert.equal(res.report.independent, 1, 'the ambiguous row is NOT counted as independent');
  });
  it('a parent outside the set is reported as missing (claimlen.awk: "depends on missing")', () => {
    const res = analyzeClaimSet([
      { n: 4, text: '4. The method of claim 9, wherein the key is symmetric.' },
    ]);
    const r = res.byNumber.get(4);
    assert.equal(r.dependent, true);
    assert.deepEqual(r.missingParents, [9]);
    assert.equal(r.parent, null);
    assert.deepEqual(res.report.missingParent, [{ n: 4, missing: [9] }]);
    assert.match(formatDepReport(res).join('\n'), /claim 4 depends on missing claim\(s\) 9/);
  });
  it('a cycle is reported and no depth is assigned to its members', () => {
    const res = analyzeClaimSet([
      { n: 2, text: '2. The method of claim 3, wherein the key is symmetric.' },
      { n: 3, text: '3. The method of claim 2, wherein the key is 256 bits.' },
    ]);
    assert.equal(res.report.cycles.length >= 1, true);
    assert.equal(res.byNumber.get(2).depth, null);
    assert.equal(res.byNumber.get(3).depth, null);
    assert.match(formatDepReport(res).join('\n'), /CYCLE/);
  });
});

describe('dep-claims: the residue reports itself', () => {
  it('every independent says why, and the ones that smell dependent are listed for inspection', () => {
    const res = analyzeClaimSet([
      { n: 1, text: '1. A widget comprising a housing, a spring inside the housing, and a cap closing the housing.' },
      { n: 2, text: '2. Widget per the claim above, the cap being magnetic.' },   // no pattern fires; short and says "claim"
    ]);
    const r1 = res.byNumber.get(1), r2 = res.byNumber.get(2);
    assert.equal(r1.dependent, false);
    assert.match(r1.why, /residue/);
    assert.deepEqual(r1.smell, []);
    assert.equal(r2.dependent, false, 'no rule fires -- and that is exactly the case the channel exists for');
    assert.ok(r2.smell.length >= 1, JSON.stringify(r2.smell));
    assert.deepEqual(res.report.lowConfidenceResidue.map((x) => x.n), [2]);
    assert.match(formatDepReport(res).join('\n'), /low-confidence residue: claim 2/);
  });
  it('a bare string set reads each claim’s number from its own leading "N."', () => {
    const res = analyzeClaimSet(['1. A method comprising a step.', '2. The method of claim 1, wherein the step is repeated.']);
    assert.equal(res.byNumber.get(2).parent, 1);
    assert.equal(res.byNumber.get(2).depthLabel, 'D');
  });
});
