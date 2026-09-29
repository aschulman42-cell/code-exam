// test_overview_local_hardening.js — local Overview gates: tool budget/floor, date pinning, damage cap
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// Coverage for #276 overview-local hardening parity: the pure helpers that
// gate the local Overview-by-AI paths (CLI runAiOverviewLocal and server
// runAiOverviewLocalShared) — tool budget, special-token neutralization,
// Gemma strict framing, the 0-call fabrication guard, and the local-engine
// grounding clause in the shared prompt.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeToolBudget, neutralizeSpecialTokens, strictInstructionsFor, ungroundedWarning, localBudgets,
  needsSynthesizeRetry, rescuedNote, SYNTHESIZE_RETRY_MAX_TOKENS, SYNTHESIZE_NOW_PROMPT,
  toolFloorFrom, needsToolFloorNudge, toolFloorNote, TOOL_FLOOR_MAX_NUDGES,
  selectSubstitutionTools, FLOOR_SUBSTITUTION_TOOLS, SUBSTITUTION_REVISION_PROMPT,
  countScorableTokens, preferPreNudgeAnswer,
} from '../src/core/ai-overview-local.js';
import { aiOverviewPrompt, LOCAL_ENGINE_GROUNDING } from '../src/core/ai-overview.js';
import fs from 'node:fs';
import { ggufContextOptions, PINNED_TODAY_DATE, DATE_INJECTING_WRAPPERS, ggufDescriptor } from '../src/core/llm-runner.js';
import { parseArgs } from '../src/argparse.js';

// --flash-attention (#306 fix-list 17, F23). Frees 0.5 GB (Gemma-3-12B) to
// 2.3 GB (gpt-oss-20b) of VRAM at ctx 16384 — the difference between a 20B
// model fitting on a 16 GB card and node-llama-cpp's estimator rating it 0%
// compatible. Off by default: experimental in 3.18.1 and may change numerics.
test('#306 flash attention: OFF omits the key entirely, rather than passing false', () => {
  const off = ggufContextOptions(16384);
  assert.deepEqual(off, { contextSize: 16384 });
  // The load-bearing assertion. `{flashAttention: false}` would probably behave
  // the same, but "probably" is not good enough: a default run must hand
  // node-llama-cpp the exact object it received before this flag existed, or a
  // byte-compare re-pin of the existing measurement runs stops being cheap.
  assert.ok(!('flashAttention' in off), 'key must be absent, not false');
  assert.deepEqual(ggufContextOptions(8192, false), { contextSize: 8192 });
});

// Prefetch companion guard (#306 fix-list 4, F40). With CE injecting a real
// `overview` result, `toolCalls === 0` stops meaning "fabricated" — runs scoring
// groundedness 1.000 were being labelled UNGROUNDED, which made the zero-tools
// class un-summable across arms.
test('#306 grounding guard: prefetched runs with zero model calls are not called ungrounded', () => {
  assert.equal(ungroundedWarning(0, 'grounded', true), null);
});

test('#306 grounding guard: without prefetch, zero calls still fires', () => {
  // The guard must NARROW, not vanish. This is the case it exists for.
  assert.match(ungroundedWarning(0, 'grounded', false), /UNGROUNDED OUTPUT/);
  assert.match(ungroundedWarning(0, 'grounded'), /UNGROUNDED OUTPUT/, 'default arg keeps old behaviour');
});

test('#306 grounding guard: prefetch does not suppress the warning when the model DID call tools', () => {
  // Belt and braces — toolCalls > 0 already returns null, but the ordering of
  // the two checks must not make a nonzero-call run depend on the prefetch flag.
  assert.equal(ungroundedWarning(3, 'grounded', true), null);
  assert.equal(ungroundedWarning(3, 'grounded', false), null);
});

test('#306 flash attention: ON adds the key without disturbing contextSize', () => {
  assert.deepEqual(ggufContextOptions(16384, true), { contextSize: 16384, flashAttention: true });
  // Must compose with every rung of the context ladder, since the ladder shrinks
  // on OOM and flash attention is precisely what changes where OOM happens.
  for (const sz of [16384, 8192, 4096, 2048]) {
    assert.deepEqual(ggufContextOptions(sz, true), { contextSize: sz, flashAttention: true });
  }
});

test('#276 budget: stops after maxCalls with a synthesize-now message, stays stopped', () => {
  const b = makeToolBudget({ maxCalls: 3, maxChars: 1e9 });
  assert.equal(b.gate(), null);
  assert.equal(b.gate(), null);
  assert.equal(b.gate(), null);
  const stop = b.gate(); // 4th call
  assert.match(stop, /TOOL BUDGET EXHAUSTED/);
  assert.match(b.gate(), /TOOL BUDGET EXHAUSTED/); // still stopped
  assert.equal(b.stopped, true);
});

test('#276 budget: char budget trips independently of call count', () => {
  const b = makeToolBudget({ maxCalls: 100, maxChars: 5000 });
  assert.equal(b.gate(), null);
  b.charge(6000);
  assert.match(b.gate(), /TOOL BUDGET EXHAUSTED/);
});

test('#276 neutralize: breaks ChatML, Gemma, Mistral, and </s> token forms', () => {
  const dirty = 'x <|im_start|> y <start_of_turn> z [INST] w </s>';
  const clean = neutralizeSpecialTokens(dirty);
  assert.ok(!/<\|im_start\|>|<start_of_turn>|\[INST\]|<\/s>/.test(clean));
  assert.ok(clean.includes('‹¦im_start¦›')); // lookalike delimiters, content preserved
});

test('#276 neutralize: plain text passes through untouched, no log call', () => {
  let logged = 0;
  const s = 'normal tool output with <angle> brackets but no template tokens';
  assert.equal(neutralizeSpecialTokens(s, 'x', () => logged++), s);
  assert.equal(logged, 0);
});

test('#276 strict framing: Gemma gets the header, other wrappers do not', () => {
  assert.match(strictInstructionsFor('Gemma', 'PROMPT'), /^Instructions \(follow these strictly\):\nPROMPT$/);
  assert.equal(strictInstructionsFor('Qwen', 'PROMPT'), 'PROMPT');
  assert.equal(strictInstructionsFor(undefined, 'PROMPT'), 'PROMPT');
});

test('#276 fabrication guard: fires only on 0 calls in grounded mode', () => {
  assert.match(ungroundedWarning(0, 'grounded'), /UNGROUNDED OUTPUT/);
  assert.match(ungroundedWarning(0, null), /UNGROUNDED OUTPUT/); // default = grounded
  assert.equal(ungroundedWarning(3, 'grounded'), null);
  assert.equal(ungroundedWarning(0, 'augmented'), null); // general knowledge allowed there
});

test('#276 localBudgets mirrors server scaling', () => {
  const { maxTokens, toolBudgetChars } = localBudgets(24576, null);
  assert.ok(maxTokens >= 2400 && maxTokens <= 6144);
  assert.ok(toolBudgetChars > 20000); // 24k ctx leaves a real tool budget
  const small = localBudgets(2048, null);
  assert.ok(small.maxTokens >= 256 && small.toolBudgetChars >= 500);
});

test('localBudgets: an explicit maxTokens DEFEATS context scaling', () => {
  // The trap this documents: `explicitMaxTokens || <scaled>` cannot tell a
  // caller's deliberate 2400 from a default parameter that merely looks like
  // one. runAiOverviewLocal used to declare `maxTokens = 2400`, so the sole
  // caller (index.js, which never passes it) silently pinned output at 2400 at
  // every context size — --context-size raised the tool budget while the answer
  // allowance never moved. The test above only ever passes `null`, so it
  // exercised the scaling path and could not notice.
  assert.equal(localBudgets(24576, undefined).maxTokens, 4096, 'scales with context when unset');
  assert.equal(localBudgets(24576, 2400).maxTokens, 2400, 'an explicit value wins, by design');
  assert.ok(localBudgets(24576, undefined).maxTokens > localBudgets(16384, undefined).maxTokens,
    'a larger context must buy a larger answer');
});

test('#276 prompt: local engines get the grounding clause, cloud does not', () => {
  const local = aiOverviewPrompt('grounded', { localEngine: true });
  const cloud = aiOverviewPrompt('grounded');
  assert.ok(local.includes(LOCAL_ENGINE_GROUNDING));
  assert.ok(!cloud.includes('LOCAL-ENGINE GROUNDING'));
  assert.ok(local.includes('GROUNDING — STRICT')); // grounding clause still present
});

test('empty-final-turn rescue: fires only on empty output AFTER real investigation', () => {
  // The failure being rescued: every tool call succeeded, budget barely touched,
  // and session.prompt still resolved to "" — CE then returned empty prose with
  // exit code 0, which reads as success to any script checking the exit code.
  assert.equal(needsSynthesizeRetry('', 12), true);
  assert.equal(needsSynthesizeRetry(['   ', '  '].join('\n'), 12), true, 'whitespace-only counts as empty');
  // Inert whenever the model answered — this must never touch a healthy run.
  assert.equal(needsSynthesizeRetry('a real overview', 12), false);
  // Zero tool calls is the UNGROUNDED case, not this one. Re-prompting a model
  // that never looked at the index would invite fabrication rather than rescue.
  assert.equal(needsSynthesizeRetry('', 0), false);
  assert.equal(needsSynthesizeRetry(null, 0), false);
});

test('empty-final-turn rescue: the retry is bounded well below the context ceiling', () => {
  // Observed rescues produce ~520 tokens; the cap exists because a shorter
  // generation is a shorter synchronous native block, and this path has been
  // seen blocking the event loop for ~640s.
  assert.ok(SYNTHESIZE_RETRY_MAX_TOKENS <= 2048, 'cap stays small');
  assert.ok(SYNTHESIZE_RETRY_MAX_TOKENS >= 512, 'but large enough for an overview');
  // The effective value is min(cappedMaxTokens, cap), so a large context can
  // never widen it.
  const big = localBudgets(32768, undefined).maxTokens;
  assert.ok(Math.min(big, SYNTHESIZE_RETRY_MAX_TOKENS) === SYNTHESIZE_RETRY_MAX_TOKENS,
    'the cap binds at large contexts');
});

test('empty-final-turn rescue: reuses the budget stop wording, and labels the output', () => {
  // CE already had the right primitive — it only fired at budget exhaustion.
  const stop = makeToolBudget({ maxCalls: 0 }).gate();
  assert.ok(stop.includes('from the results you already have'));
  assert.ok(SYNTHESIZE_NOW_PROMPT.includes('from the results you already have'));
  // A rescued overview must not be indistinguishable from a healthy one, or the
  // model defect goes invisible the moment the workaround lands.
  const note = rescuedNote(12);
  assert.ok(note.includes('12 tool call'));
  assert.match(note, /RECOVERED OUTPUT/);
  assert.match(note, /not a clean run/);
});

// ---------------------------------------------------------------------------
// Tool-call floor (#306 fix-list 7, F37/F39). makeToolBudget caps
// investigation; this is the same primitive inverted. Prefetch makes the FIRST
// call unconditional but does not make the second happen — on .ExoPlayer3 it
// drove 3 of 5 cells to zero model-initiated calls (F39).
// ---------------------------------------------------------------------------

test('#306 floor: unset env means no floor, so default behaviour is untouched', () => {
  assert.equal(toolFloorFrom({}), 0);
  assert.equal(toolFloorFrom({ CE_TOOL_CALL_FLOOR: '' }), 0);
  assert.equal(toolFloorFrom(undefined), 0);
  // Junk must disable, never throw and never become NaN — an unparseable value
  // silently enabling a floor would be worse than ignoring it.
  assert.equal(toolFloorFrom({ CE_TOOL_CALL_FLOOR: 'yes' }), 0);
  assert.equal(toolFloorFrom({ CE_TOOL_CALL_FLOOR: '-3' }), 0);
  assert.equal(toolFloorFrom({ CE_TOOL_CALL_FLOOR: '0' }), 0);
  assert.equal(toolFloorFrom({ CE_TOOL_CALL_FLOOR: '3' }), 3);
  assert.equal(toolFloorFrom({ CE_TOOL_CALL_FLOOR: '2.9' }), 2);
});

test('#306 floor: nudges a model that wrote prose after too few DISTINCT tools', () => {
  assert.equal(needsToolFloorNudge({ raw: 'an overview', distinctTools: 1, floor: 3, nudges: 0, rescued: false }), true);
  assert.equal(needsToolFloorNudge({ raw: 'an overview', distinctTools: 3, floor: 3, nudges: 0, rescued: false }), false);
});

test('#306 floor: never fires without the env gate', () => {
  assert.equal(needsToolFloorNudge({ raw: 'x', distinctTools: 0, floor: 0, nudges: 0, rescued: false }), false);
});

test('#306 floor: empty output belongs to the rescue, not the floor', () => {
  // The two are disjoint by construction — needsSynthesizeRetry fires on empty,
  // this fires on non-empty — so they can never contend for one response.
  assert.equal(needsToolFloorNudge({ raw: '', distinctTools: 0, floor: 3, nudges: 0, rescued: false }), false);
  assert.equal(needsToolFloorNudge({ raw: '   ', distinctTools: 0, floor: 3, nudges: 0, rescued: false }), false);
});

test('#306 floor: a RESCUED run is never nudged back into investigation', () => {
  // The load-bearing exclusion. A rescue already means the model struggled to
  // write anything; sending it back for more tool calls is the worst case in
  // this mechanism's own reasoning.
  assert.equal(needsToolFloorNudge({ raw: 'recovered prose', distinctTools: 1, floor: 3, nudges: 0, rescued: true }), false);
});

test('#306 floor: nudges are bounded, so a stubborn model cannot hang the run', () => {
  const under = { raw: 'x', distinctTools: 1, floor: 3, rescued: false };
  assert.equal(needsToolFloorNudge({ ...under, nudges: TOOL_FLOOR_MAX_NUDGES - 1 }), true);
  assert.equal(needsToolFloorNudge({ ...under, nudges: TOOL_FLOOR_MAX_NUDGES }), false);
  assert.equal(needsToolFloorNudge({ ...under, nudges: TOOL_FLOOR_MAX_NUDGES + 5 }), false);
});

test('#306 floor: the note labels the run either way, and warns against reading it as quality', () => {
  const subbed = toolFloorNote(1, 3, ['overview', 'stats']);
  assert.match(subbed, /FLOOR SUBSTITUTED/);
  assert.match(subbed, /1 distinct tool\(s\)/);
  assert.match(subbed, /CE ran overview, stats ITSELF/);
  // The load-bearing sentence. F39: supplying results can TERMINATE
  // investigation, and the model-call counter is the only instrument that
  // detects it — so the note must say the CE calls are excluded from it.
  assert.match(subbed, /NOT counted in the 1 above/);
  // A floor guarantees quantity only; F43 and F55 are both compatible with a
  // satisfied floor, so the artifact must say so.
  assert.match(subbed, /do not\s+guarantee extra evidence/);

  const none = toolFloorNote(1, 3, []);
  assert.match(none, /FLOOR NOT MET/);
  assert.match(none, /no unused argument-free tool left/);
});

// ---------------------------------------------------------------------------
// `Today Date:` pinning (#306, F58). node-llama-cpp resolves a Llama-3.1 GGUF
// to its OWN wrapper rather than the file's template, and that wrapper defaults
// todayDate to a live clock — so the system prompt, and therefore the output,
// is a function of the calendar. A code index has no "today".
// ---------------------------------------------------------------------------





// The upstream-drift guard. DATE_INJECTING_WRAPPERS is a hand-maintained list,
// and a Llama-only version of this fix shipped and did nothing for Harmony —
// which is what gpt-oss-20b resolves to. This test reads the installed dist and
// fails if the set of wrappers defaulting `todayDate` to a clock ever differs
// from the list CE pins, so the next one cannot be missed silently.
test('#306 todayDate: CE pins every wrapper that injects a date, per the installed library', () => {
  const dir = 'node_modules/node-llama-cpp/dist/chatWrappers';
  if (!fs.existsSync(dir)) return; // library optional; nothing to check
  const NAME_BY_FILE = {
    'Llama3_1ChatWrapper.js': 'llama3.1',
    'Llama3_2LightweightChatWrapper.js': 'llama3.2-lightweight',
    'HarmonyChatWrapper.js': 'harmony',
    'MuseChatWrapper.js': 'muse',
  };
  const injecting = fs.readdirSync(dir)
    .filter((f) => f.endsWith('ChatWrapper.js'))
    .filter((f) => /todayDate\s*=\s*\(\)\s*=>\s*new Date\(\)/.test(fs.readFileSync(`${dir}/${f}`, 'utf8')));
  const unknown = injecting.filter((f) => !NAME_BY_FILE[f]);
  assert.deepEqual(unknown, [],
    `node-llama-cpp gained a date-injecting wrapper CE does not pin: ${unknown.join(', ')}`);
  assert.deepEqual(
    injecting.map((f) => NAME_BY_FILE[f]).sort(),
    [...DATE_INJECTING_WRAPPERS].sort(),
    'DATE_INJECTING_WRAPPERS must match the installed library');
});


// D2: the constant must name the same CALENDAR DAY in every timezone. A UTC
// instant does not — `new Date('2024-07-26T00:00:00Z')` renders "25 Jul 2024"
// everywhere west of UTC, so two machines in different zones would send
// different prompts. Asserting the LOCAL components is timezone-independent by
// construction: a local-noon date has these components wherever it is built.
test('#306 todayDate: the pinned constant is the same calendar day in any timezone', () => {
  assert.equal(PINNED_TODAY_DATE.getFullYear(), 2024);
  assert.equal(PINNED_TODAY_DATE.getMonth(), 6, 'July (0-indexed)');
  assert.equal(PINNED_TODAY_DATE.getDate(), 26, 'the date Llama 3.1\'s own template hardcodes');
  // Noon, not midnight: ~12h of margin either side keeps every real UTC offset
  // (-12..+14) on the same calendar day.
  assert.equal(PINNED_TODAY_DATE.getHours(), 12, 'midday margin is what makes it zone-proof');
  // Guard against a regression to the UTC-instant form, which is what shipped
  // and was wrong.
  assert.notEqual(PINNED_TODAY_DATE.toISOString(), '2024-07-26T00:00:00.000Z');
});

// D1: version 2 of this fix passed the date through customWrapperSettings, which
// made Harmony fall through to JinjaTemplate — swapping the wrapper and leaving
// the clock live. Version 3 resolves unperturbed and assigns the field. These
// two tests pin the properties that make that safe.
test('#306 todayDate: assignment after construction takes effect (read at render, not captured)', async () => {
  let mod;
  try { mod = await import('node-llama-cpp'); } catch { return; }
  for (const [name, Cls] of [
    ['llama3.1', mod.Llama3_1ChatWrapper],
    ['llama3.2-lightweight', mod.Llama3_2LightweightChatWrapper],
    ['harmony', mod.HarmonyChatWrapper],
  ]) {
    const w = new Cls({});
    assert.equal(typeof w.todayDate, 'function', `${name}: library default really is a clock`);
    w.todayDate = PINNED_TODAY_DATE;                       // what chatSessionOptions does
    assert.ok(w.todayDate instanceof Date, `${name}: field is writable`);
    assert.equal(w.todayDate.getTime(), PINNED_TODAY_DATE.getTime(), `${name}: holds CE's constant`);
  }
});


// ---------------------------------------------------------------------------
// Damage cap (asus-CC batch-2 floor measurement). 16 nudges across 8 cells
// produced ZERO additional distinct tool calls and destroyed two cells outright.
// Never return an answer worse than the one the nudge replaced.
// ---------------------------------------------------------------------------

test('#306 damage cap: keeps the original when the re-prompt names fewer things', () => {
  // Gemma-K_M's real failure shape: 3.6x longer, almost nothing named. ABSOLUTE
  // count rather than density is what catches this — density alone would not,
  // and a density threshold would be a magic number to argue about.
  const rich = 'The `AdaptiveTrackSelection` class in AdaptiveTrackSelection.java calls '
    + 'determineIdealSelectedIndex and updateSelectedTrack via DefaultLoadControl.';
  const padded = 'This codebase appears to be a large and well organised project. '.repeat(40);
  assert.ok(countScorableTokens(rich) > countScorableTokens(padded));
  assert.equal(preferPreNudgeAnswer(rich, padded), true, 'longer but emptier must be rejected');
});

test('#306 damage cap: catches a model knocked out of the function-calling channel', () => {
  // Qwen's real failure: the best-scoring cell in the roster returned 399 bytes
  // of call syntax as literal prose, which node-llama-cpp never intercepted.
  const before = 'The `CodeSearchIndex` class in CodeSearchIndex.js builds the function index.';
  const leaked = '<tool_call>\n{"name": "command_catalog", "arguments": {}}\n</tool_call>';
  assert.equal(preferPreNudgeAnswer(before, leaked), true);
  assert.equal(preferPreNudgeAnswer(before, '{"name": "overview", "arguments": {}}'), true);
});

test('#306 damage cap: keeps the NEW answer when the re-prompt genuinely improved it', () => {
  // The cap must not fire on success, or it would silently defeat the mechanism
  // in exactly the cases where it worked.
  const thin = 'This project is a code analysis tool.';
  const better = 'The `CodeSearchIndex` class in CodeSearchIndex.js builds a function index; '
    + 'mcp-server.js exposes handleTool and ai-overview-local.js drives the loop.';
  assert.equal(preferPreNudgeAnswer(thin, better), false);
});

test('#306 damage cap: an empty re-prompt falls back; an empty original does not', () => {
  assert.equal(preferPreNudgeAnswer('some `real` content here', ''), true);
  assert.equal(preferPreNudgeAnswer('', 'anything'), false, 'nothing better to fall back to');
});

test('#306 damage cap: the note says the original was kept, so the failure is not hidden', () => {
  const n = toolFloorNote(1, 3, ['overview'], true);
  assert.match(n, /FLOOR SUBSTITUTED/);
  assert.match(n, /named FEWER concrete things[\s\S]*original was kept/);
  assert.match(n, /substitution made this run worse, and that is the result/);
  assert.doesNotMatch(toolFloorNote(1, 3, ['overview'], false), /original was kept/);
});

// ---------------------------------------------------------------------------
// #306 item 7 — SUBSTITUTION replaces the nudge. The nudge was measured dead:
// 16 nudges across 8 cells produced ZERO additional distinct tool calls, and
// destroyed two cells outright. The replacement is the prefetch route, which
// F37 validated on 10/10 cells including models that never call anything.
// ---------------------------------------------------------------------------

test('#306 substitution: picks the highest-value tools the model did NOT call', () => {
  // Model called nothing; floor 3 → the top three of the catalog.
  // #320 1a: models_used joined the catalogue at position 3 — the AI/ML
  // sentence is a mandated output, and its absence was the measured defect.
  assert.deepEqual(selectSubstitutionTools(new Set(), 3), ['overview', 'stats', 'models_used']);
  // Model already called `overview` → it is skipped, not re-run.
  assert.deepEqual(selectSubstitutionTools(new Set(['overview']), 3), ['stats', 'models_used']);
  // Shortfall drives the count, not the floor: 2 called, floor 3 → one tool.
  assert.deepEqual(selectSubstitutionTools(new Set(['overview', 'stats']), 3), ['models_used']);
});

test('#306 substitution: a model at or above the floor is left completely alone', () => {
  assert.deepEqual(selectSubstitutionTools(new Set(['overview', 'stats', 'vocabulary']), 3), []);
  assert.deepEqual(selectSubstitutionTools(new Set(['a', 'b', 'c', 'd']), 3), []);
  assert.deepEqual(selectSubstitutionTools(new Set(), 0), [], 'floor unset = inert');
});

test('#306 substitution: the catalog is argument-free tools only', () => {
  // The prefetch scope note applied here: `digest <file>` would require CE to
  // invent an argument and would spend context on a result this run may not
  // need. Anything conditional in this list is a bug.
  for (const t of FLOOR_SUBSTITUTION_TOOLS) {
    assert.doesNotMatch(t, /digest|extract|callers|callees|show_file|search/,
      `${t} needs an argument — CE cannot choose one on the model's behalf`);
  }
});

test('#306 substitution: exhausting the catalog degrades to "no tools left", not a crash', () => {
  const all = new Set(FLOOR_SUBSTITUTION_TOOLS);
  assert.deepEqual(selectSubstitutionTools(all, FLOOR_SUBSTITUTION_TOOLS.length + 5), []);
  assert.match(toolFloorNote(6, 99, []), /no unused argument-free tool left/);
});

test('#306 substitution: one pass only — the gate stops firing after it runs', () => {
  // `nudges` is incremented once by the substitution pass; TOOL_FLOOR_MAX_NUDGES
  // then closes the gate. This is what makes `if` safe where the nudge used
  // `while`: F39 says each extra round of supplied context suppresses further.
  const under = { raw: 'an overview', distinctTools: 1, floor: 3, rescued: false };
  assert.equal(needsToolFloorNudge({ ...under, nudges: 0 }), true, 'fires once');
  assert.equal(needsToolFloorNudge({ ...under, nudges: TOOL_FLOOR_MAX_NUDGES }), false, 'and not again');
});

// The damage cap's own defect, found by measurement not review (asus-CC).
// Gemma-K_M degenerated into echoing raw tool output in CE's `||call:` /
// `||result:` format. Two mechanisms missed it in OPPOSITE directions: the leak
// detector covered the vendor formats but not CE's own, and the token count was
// INFLATED 4x by the dump — because tool output is dense in identifier-shaped
// strings. The proxy rewarded the degeneration it exists to catch.
test('#306 damage cap: CE\'s own echo format counts as leaked', () => {
  const before = 'The `CodeSearchIndex` class in CodeSearchIndex.js builds the function index.';
  const echoed = '||call: referenced_resources()\n||result: "Referenced resources:\n\n- Environment variables: …';
  assert.equal(preferPreNudgeAnswer(before, echoed), true,
    'the format Gemma actually leaks in must trigger the revert');
});

test('#306 damage cap: echoed tool output cannot inflate the score', () => {
  // The measured inversion: 2171 B of real prose scored 26, and 7742 B of
  // mostly-echo scored 104. Stripping what the model did not write removes the
  // inflation — asus-CC measured post-strip 0 against a pre of 26.
  const prose = 'The `AdaptiveTrackSelection` class calls determineIdealSelectedIndex.';
  const dump = '||call: referenced_resources()\n'
    + '||result: AWS_SECRET_KEY, GOOGLE_APPLICATION_CREDENTIALS, media3.exoplayer.Foo, Bar.baz\n'
    + '||result: node_modules/pkg/index.js, src/core/CodeSearchIndex.js, someCamelCase\n';
  assert.equal(countScorableTokens(dump), 0, 'echoed lines contribute nothing');
  assert.ok(countScorableTokens(prose) > 0, 'real prose still counts');
  // The two mechanisms are belt and braces, and here BOTH would fire: the leak
  // detector wins first. That is the intended precedence — echoed tool traffic
  // is a broken protocol regardless of how good the prose around it looks.
  assert.equal(preferPreNudgeAnswer(prose, prose + '\n' + dump), true,
    'a dump appended to good prose still reverts — the protocol broke');
  // And the strip is what stops a PARTIAL dump inflating the count past the
  // detector's reach: same text, counted without the echoed lines.
  assert.equal(countScorableTokens(prose + '\n' + dump), countScorableTokens(prose),
    'the dump adds nothing to the score it could have inflated');
});

test('#306 damage cap: the strip is inert on healthy output', () => {
  const clean = 'The `CodeSearchIndex` class in CodeSearchIndex.js builds a function index; '
    + 'mcp-server.js exposes handleTool.';
  // No echoed lines, so counting must be exactly as before the strip existed.
  assert.equal(countScorableTokens(clean), (clean.match(/`[^`\n]+`|\b[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.|_)[A-Za-z0-9_]+)+\b|\b[a-z0-9]+[A-Z][A-Za-z0-9]*\b|\b[A-Za-z][A-Za-z0-9_-]*\.[a-z]{1,5}\b/g) || []).length);
});

// #306 F67 — the flag was rejected on the GUI path, silently dropped at two
// hand-built descriptor sites, and accepted where it did nothing. The structural
// cause was a struct that a factory built everywhere else being hand-rolled in
// two places, so it lost every field added after those places were written.
test('#306 ggufDescriptor: one factory, so a new field cannot be missed at a call site', () => {
  const d = ggufDescriptor({ modelPath: 'm.gguf', flashAttention: true });
  assert.equal(d.kind, 'gguf');
  assert.equal(d.modelPath, 'm.gguf');
  assert.equal(d.flashAttention, true);
  // Every field the drafter reads must be present even when the caller omits
  // it — that absence is exactly what the hand-built sites produced.
  for (const k of ['forceCpu', 'contextSize', 'flashAttention', 'liveTodayDate']) {
    assert.ok(k in d, `${k} must always be present, not undefined-by-omission`);
  }
});

test('#306 ggufDescriptor: booleans normalise, so an undefined arg is off not undefined', () => {
  const bare = ggufDescriptor({ modelPath: 'm.gguf' });
  assert.equal(bare.flashAttention, false);
  assert.equal(bare.liveTodayDate, false);
  assert.equal(bare.forceCpu, false);
  assert.equal(bare.contextSize, null);
  // `undefined` reaching makeGgufDrafter was the actual bug shape at the
  // hand-built sites: falsy, so it "worked", and silently off.
  assert.notEqual(bare.flashAttention, undefined);
});

// #320 item 2: measured overhead replaces the 1200 assumption when supplied.
test('#320 localBudgets: a measured overhead shrinks the budgets; omitted keeps 1200', () => {
  const def = localBudgets(8192, null);
  const measured = localBudgets(8192, null, 2900);
  // Same context, bigger overhead → strictly less room for tool results.
  assert.ok(measured.toolBudgetChars < def.toolBudgetChars,
    `measured ${measured.toolBudgetChars} should be < default ${def.toolBudgetChars}`);
  // Backward-compat: null/absent third arg is byte-identical to the old shape.
  assert.deepEqual(localBudgets(8192, null, null), def);
  assert.deepEqual(localBudgets(8192, null), def);
  // Floors still hold at the smallest rung even with a large measured overhead.
  const tiny = localBudgets(2048, null, 2900);
  assert.ok(tiny.maxTokens >= 256 && tiny.toolBudgetChars >= 500);
});

// --local-reasoning <on|off> is the CLI front-door for the local thinking-model
// reasoning control (Gemma 4). It SETS/CLEARS the CE_DISABLE_LOCAL_REASONING env
// var that chatSessionOptions' reasoning gate reads, so the gate + all its call
// sites stay untouched; an explicit flag WINS over a pre-set env var, and unset
// leaves a pre-set var honored.
test('--local-reasoning off/on set and clear CE_DISABLE_LOCAL_REASONING (flag wins over env)', () => {
  const savedArgv = process.argv;
  const savedEnv = process.env.CE_DISABLE_LOCAL_REASONING;
  try {
    // "off" sets the env var (reasoning suppressed)
    delete process.env.CE_DISABLE_LOCAL_REASONING;
    process.argv = ['node', 'ce', '--local-reasoning', 'off'];
    let a = parseArgs();
    assert.equal(a.local_reasoning, 'off');
    assert.equal(process.env.CE_DISABLE_LOCAL_REASONING, '1');

    // "on" clears it, winning over a pre-set env var (reasoning enabled)
    process.env.CE_DISABLE_LOCAL_REASONING = '1';
    process.argv = ['node', 'ce', '--local-reasoning', 'on'];
    a = parseArgs();
    assert.equal(a.local_reasoning, 'on');
    assert.equal(process.env.CE_DISABLE_LOCAL_REASONING, undefined);

    // unset: a pre-set env var is left untouched (still honored)
    process.env.CE_DISABLE_LOCAL_REASONING = '1';
    process.argv = ['node', 'ce'];
    a = parseArgs();
    assert.equal(a.local_reasoning, null);
    assert.equal(process.env.CE_DISABLE_LOCAL_REASONING, '1');
  } finally {
    process.argv = savedArgv;
    if (savedEnv === undefined) delete process.env.CE_DISABLE_LOCAL_REASONING;
    else process.env.CE_DISABLE_LOCAL_REASONING = savedEnv;
  }
});
