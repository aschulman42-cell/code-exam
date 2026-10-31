# Pseudo-claims for CodeExam's Overview by AI (rubric page)

A hand rubric: one claim set for the feature, every row cited to the code, used as the fixed
rows a `--pseudo-claims` run is scored against (`scripts/pseudo-claim-rubric-score.mjs`, #353
part (e)). Written 2026-10-29 from Andrew's notes, the drafts of the 10/25, 10/27 and 10/29 runs
and the working tree of 2026-10-29 (`86ef26b` plus the pack work that landed as `f87ec14`);
line numbers move with later commits, function names do not. The scorer reads the `**N.**`,
`(a)` and `wherein` markers under the Set heading and the citations table at the end. The
working notes the scratch original carried (comments answered, what the drafts missed) stay
outside the repository.

**As first written:**

Built from Andrew's notes (`pseudo_claim_rubric_notes_102926.txt`, lines 276-382), the 10/25
7:20pm run's claims 14 and 24, the 10/27 Claude and ChatGPT runs' claims 10, 11 and 14, the
10/29 Gemma 4 run's claims 17, 18 and 26, the two chat transcripts, and the code in the working
tree on 2026-10-29. Andrew's instruction governs the shape: the claim is about what the feature
delivers and how CodeExam elicits it, which means the prompt, the tool menu, the two lists and the
checks that run afterwards, with cloud-versus-local as dependents.

## What the feature delivers, and where each part comes from

Andrew's six parts, each traced to the mechanism that produces it:

| Part | Produced by | Where |
|---|---|---|
| (a) two to four paragraphs on the code | the prompt's output specification, the model writing | `ao:57-90` |
| (b) "Where to look first", at most five | the same prompt; the model's text, unparsed by CodeExam | `ao:88` |
| (c) "Questions to start with", at most five | `QUESTIONS_RULE` in the prompt; parsed in the GUI for Ask in Chat and regeneration | `ao:55`, `oq`, `lr:2201-2352` |
| (d) the AI/ML caveat naming specific prose | CodeExam re-running `models_used` and diffing names and denials against it | `ad:424-532` |
| (e) the AI/ML models named | the model's own `models_used` call feeding its sentence; CodeExam's unfiltered call for the check | `ao:223-235`, `al:659-715` |
| (f) the list of tool calls | the per-tool counts kept at every call, printed as the footer | `ad:541-560` |

The one-line division of labor: CodeExam computes every signal and offers each as a tool with a
description; the model's job is to read those results, decide which of them matter for this code,
and say so in prose, including which questions a reviewer should bring and which CodeExam action
answers each. A rule can list commands (the deterministic Overview's "Next" line does, the same
for every index); it cannot say what is interesting about this index in particular. When the model
has not investigated, its "Where to look first" collapses to the rule's answer, which is the
generic list Andrew sees.

## Set A: Overview by AI

**1.** A method of orienting a reader to a body of source code, using a language model that is
given no access to the source code except through a set of tools, comprising:

(a) providing an index of the source code, and a table of tools, each tool being a procedure
computed without a language model that answers one named question about the index (its size, its
languages and top-level folders, its distinctive vocabulary, its entry points, the digest of a
named function or file, the resources it references outside itself, its own user-facing commands,
the AI/ML models it loads or calls, structural duplicates, and literal and pattern search) and
carrying a one-line description and a schema of its arguments; and selecting from the table a
fixed menu of sixteen tools suited to orientation ("the orientation menu");

(b) composing an instruction to the model ("the orientation prompt") which
  - names the output: two to four short paragraphs on what the code is, how it is structured
    and what it does, with one sentence on AI/ML use taken from the models tool; then a list,
    "Where to look first", of at most five of the system's own commands for this code, each with
    a one-line reason and naming any tool the code defeats; then a list, "Questions to start
    with", of at most five questions a reviewer should bring next, mixed between the graphical
    surface and the command line, each paired with the single action of the system that most
    directly answers it;
  - prescribes an investigation path conditioned on what the first two tools return: call the
    overview tool, then the statistics tool, then branch on the shape of the target (minified or
    binary-dominated; a collection of projects; a readable single project), naming for each
    branch which tools to call and which to avoid, within a stated budget of about five to eight
    calls and at most five digests;
  - sets rules of voice: write about the code and not about the system, do not narrate the
    process, be terse on trouble, output nothing but the orientation, and write file and
    function references as backticked paths so that they can be made links; and
  - appends a grounding clause chosen from three (strict, augmented, attributed), strict by
    default, confining the model to what the tools return; and, for a model run locally, a
    further clause insisting that the tools are live and prescribing one fixed line to output if
    they cannot be called;

(c) conducting a loop of turns in which the prompt and the menu's tool definitions are sent to
the model; on each turn every tool call the model requests is executed by the system against the
index and its text returned to the model as that call's result, the system counting the calls by
tool and keeping the first result of the overview tool and of the models tool; the loop ending at
the first turn in which the model requests no tool, or at a cap on turns, on calls, on the volume
of returned text, on spend, or on elapsed time;

(d) taking as the orientation the last text the model emitted;

(e) checking the orientation's AI/ML sentence against the index without the model: running the
models tool again, unfiltered; taking, from each sentence of the orientation that carries an
AI/ML cue, the names it uses; and appending below the orientation (i) a note listing the names
that neither that result, nor any tool result the model saw, nor the index's own file paths, nor
the tools' own names contain, with the tool's output reproduced under it, and (ii) when a sentence
denies models and the tool reports some, a note quoting the sentence and the tool's count and
saying whether the model had called the tool and with what arguments;

(f) appending a footer stating how many tool calls the model chose to make and which tools,
saying, when the only tool called was the overview tool, that the orientation is a rewording of
the deterministic overview, and disclosing every call the system made on the model's behalf; and

(g) presenting the orientation with the system's own notes marked by a fixed sign that separates
them from the model's text, each question of the "Questions to start with" list carrying a
control that opens a chat with a model over the same index with the question filled in and not
sent, and the list's heading carrying a control that obtains a different five by a second call
to the model, without tools, at a sampling temperature, quoting the same rule and the current
five and asking for different ones, the answer replacing only the body of the list and a note
recording that it was regenerated,

wherein the model reads no file and no function of the source code except as a tool returns it,
and the orientation is presented as the model's, which may differ from run to run, with the
system's checks and counts beside it.

### Dependents

**2.** The method of claim 1, in which the orientation menu is `overview`, `vocabulary`,
`digest`, `stats`, `list_files`, `list_classes`, `entry_points`, `hotspots`, `models_used`,
`command_catalog`, `regex_search`, `search`, `call_tree`, `struct_dupes`, `show_file` and
`referenced_resources`, drawn from the one table that serves every surface through which a
model reaches the system, so that a tool's description and schema are the same whatever reaches
it. [C, D]

**3.** The method of claim 1, in which the investigation path names, for a minified or
binary-dominated target, the command catalog and pattern search and forbids the digest, the
vocabulary and the models tool; for a collection, one sentence saying so and then a file listing
per project; and for a readable single project, the vocabulary, then digests of the three to
five key files, then the models tool, with the command catalog for a program that exposes
commands or routes, pattern search for routes and protocols observed, the call tree from an entry
point, the referenced resources for the external surface, and the readme and conventions files
for product framing. [C]

**4.** The method of claim 1, in which the prompt further instructs the model to separate
vendored or bundled code from the host when present, to recognize the system's own artifacts
silently (binary-string captures, archive-member paths, single-letter names in bundles), to
treat names, comments and documentation as indicia rather than ground truth, and to resolve
within budget anything it raises or drop it. [C]

**5.** The method of claim 1, in which the strict clause forbids asserting the purpose of a
referenced library, the research domain or any external framing unless the code states it; the
augmented clause permits general knowledge for the richest orientation; and the attributed
clause permits it with the provenance of each claim made explicit. [C, T-Cl, T-G]

**6.** The method of claim 1, in which the model is a cloud service: the system starts its own
tool server as a child process pointed at the index, lists its tools, keeps those whose bare
name is in the orientation menu, sends them in the provider's tool-calling wire form, caps the
loop at sixteen turns, feeds a malformed tool-call argument back to the model as an error rather
than running the tool, sums the tokens of every turn into an estimated cost checked against a
spend ceiling taken from an argument, else an environment variable, else a fixed default, and
races the whole run against a wall-clock limit. [Cl10, G10, Gm17]

**7.** The method of claim 1, in which the model runs locally: the index is loaded in the same
process, each menu tool is exposed to the model as a callable function with its description cut
to 280 characters and its schema, each result is cut to 4,000 characters and has every
chat-template control token replaced by a lookalike before it reaches the model, and a model
family whose wrapper drops system turns receives the prompt under a strict-instructions header.
[T-Cl, C]

**8.** The method of claim 7, in which a tool budget of 24 calls and a volume of result text
scaled from the context window gates every call; a call past the budget returns a fixed stop
instruction instead of a result; and after two ignored stops the system ends the tool loop
itself. [C]

**9.** The method of claim 7, in which the context is allocated by walking a ladder of sizes
(the requested size, then 8,192, 4,096 and 2,048) on the graphics processor and then on the
central processor, the prompt and the tool definitions are tokenized to measure their overhead
with a fixed margin added, and the output allowance and the result-text budget are computed from
the context actually obtained less that overhead. [Gm26]

**10.** The method of claim 7, further comprising, when the model ends its turn with no text
after calling tools, prompting the same session once more with the tools withheld to write from
the results it has; and, when the system itself ended the tool loop, resetting the session and
supplying the gathered results as plain text under a rule that every name, count and model id
must appear in them verbatim; a note above the orientation naming which of the two happened.
[Cl14, G14, Gm26, 10/25 claim 24]

**11.** The method of claim 7, further comprising a warning above the orientation when the model
made no tool call under the strict clause, and a second warning when prose of at least 400
characters names fewer than eight distinctive terms, or fewer than five percent of its distinctive
terms (backticked spans, qualified identifiers, camel-case words, names with a file extension)
appear anywhere in the gathered tool results. [G14]

**12.** The method of claim 7, in which, when enabled, the system calls the overview tool itself
before the first turn and places the result in the prompt, not counted as a model call; and,
when a floor on distinct tools is set and the model wrote after using fewer, the system runs the
highest-value unused argument-free tools from a fixed catalog, asks once for a revision, keeps
the original when the revision names fewer concrete things or leaks call syntax, and labels the
run either way. [Cl14, G14]

**13.** The method of claim 1, in which a sentence carries an AI/ML cue when it mentions a model
together with an AI term, a vendor or family name, a weights or checkpoint extension, a
parameter size, a model-shaped token, or a load, call or train verb near "model"; a denial is a
negation within six words before the topic or three after it; and a name is excluded when it is
a stop word, an environment-variable shape, a camel-case identifier without digits, a dotted
abbreviation, a file-at-function reference, a number-word, or a hyphenated word with no digit
part. [C]

**14.** The method of claim 13, in which a vendor named in the sentence counts as supported when
the tool result holds an id of that vendor's family; a name that looks like a path counts as
supported when the index holds that file; and, when the tool found no ids, only model-shaped
names are compared and an affirming sentence with none gets a one-line note saying it was not
checked. [C]

**15.** The method of claim 1, in which the "Questions to start with" section is found as a
heading line of at most forty characters in bold, markdown-heading or plain form, ends at the
next heading or the first system note, and each line yields a question as its italic segment
ending in a question mark when present, else the line with its list marker removed. [Cl11, G11,
Gm18]

**16.** The method of claim 1, in which the regenerating call runs at temperature 0.8 with a
400-token allowance, its answer is cut to at most five lines each given a number, the note says
the questions were sampled and the overview above is unchanged, and the control is muted when the
server runs with sampling pinned, since pinned sampling cannot give different questions. [D, C]

**17.** The method of claim 1, in which the chat opened from a question sees every registered
tool on a cloud engine and a curated eight on a local model, and the same question can be asked
from the command line through the same loops with the same footer. [D]

**18.** The method of claim 1, in which the footer's parenthetical discloses a prefetched
overview, a substituted tool, and a models-tool call made only for verification, each named as
the system's call and not the model's. [C]

**19.** The method of claim 1, in which, from the command line, only the orientation reaches
standard output, every status line, tool line, heartbeat, cost or token count and achieved
context going to standard error, and the index is checked for existence before any model is
called. [C]

**20.** The method of claim 1, in which the graphical surface keeps the orientation for the life
of the browser tab, labels it with the engine and model that produced it, and shows the same
prose, notes and controls in the pane and in a pop-up. [D]

**21.** The method of claim 1, in which the three notes read "AI/ML SENTENCE UNVERIFIED", "AI/ML
CLAIM CONTRADICTED" and "Based on N model tool calls", each stating that nothing in it was read
out of the index, and reproduce the models tool's text under them so that the reader judges. [D]

### Preamble variants for retrieval testing

- Method of orienting a reader (above).
- "A method of producing, with a language model confined to a set of deterministic tools over
  an index of source code, a written orientation to the code together with the system's own
  account of what the model consulted and what it got wrong."
- System form: a memory holding the index and the tool table; a processor configured to compose
  the prompt, run the loop, verify the sentence, append the footer and render.
- Two separable independents, if wanted later: the verification of (e), which also serves the
  chat answers (`answer-disclosure.js` is shared); and the regeneration of (g), one call with the
  rule quoted and the current five excluded.

## Citations and provenance

Keys: `ao` = `src/core/ai-overview.js`, `al` = `src/core/ai-overview-local.js`,
`ad` = `src/core/answer-disclosure.js`, `oq` = `public/overview-questions.js`,
`lr` = `public/list-renderers.js`, `sv` = `src/server.js`, `ix` = `src/index.js`,
`ms` = `src/mcp-server.js`. Tags: [A] Andrew's notes; [Cl10] [Cl11] [Cl14] the 10/27 Claude
run; [G10] [G11] [G14] the 10/27 ChatGPT run; [Gm17] [Gm18] [Gm26] the 10/29 Gemma 4 run; [T-Cl]
[T-G] the two chat transcripts; [D] the docs; [C] code only.

Rows keyed by claim and element as the scorer reads them; the topic-by-topic table this
was converted from (2026-10-30) is the scratch original, and rows marked "keyed 2026-10-30"
were added from the parts table above.

| claim | where | provenance |
|---|---|---|
| A1 preamble | `ao:57` (the prompt opens on orienting a reader through the tools); `docs/UNCOVER_KEY_CODE.md:59-70` | keyed 2026-10-30 from the parts table |
| A1(a) | `ms:106-400` (the sixteen at 108, 120, 156, 204, 215, 226, 249, 260, 268, 276, 308, 319, 352, 365, 377, 388); `ms:688` router; `ao:44-49` | [T-G] §2, [D] `CODEEXAM_MCP.md:11-25`; [A] "the limited set of permitted tools seems important" |
| A1(b) | `ao:57`, `ao:86-90`; `ao:55`, interpolated at `ao:89` and quoted at `ao:104-109`; `ao:65-69`; `ao:59-63`, `ao:90`; `ao:130-147` | [A] parts (a)-(c); [A] part (c); [T-Cl] §12; [T-G] §3; [T-Cl] §1; [T-Cl] §3, [T-G] §4 |
| A1(c) | `ao:198-341` (`runTool` 223-235, `checkBudget` 237-242, compat 245-300, Anthropic 301-341); `al:659-715` tools, `al:718` prompt, `al:803` turn; GUI `sv:2573-2612` | [Cl10], [G10], [Gm17], [A] 10/25 claim 14; [T-Cl] §5, §6 |
| A1(d) | `ao:283`, `ao:325`; `al:954` | [Cl10] |
| A1(e) | `ao:345-391`; `al:995-1020`; `sv:2638-2651`; `ad:158-532` | [A] part (d); [T-Cl] §10; [T-G] §7 |
| A1(f) | `ad:541-560`; `ao:394`; `al:1025`; `sv:2653` | [A] part (f); `CODEEXAM_NOTATION.md:164-168` |
| A1(g) | `lr:2201-2230`, `lr:2235-2258`, `lr:2277-2316`, `lr:2327-2352`; `oq:28-112`; `sv:2767-2825` | [A] part (c); [D] `UNCOVER_KEY_CODE.md:59-70`, `CODEEXAM_GUI.md:67-82` |
| A1 wherein | the prompt's "using the CodeExam MCP tools" `ao:57`; `AI_ASSISTED_CODE_EXAM.md:24-27`; `REPRODUCIBILITY.md:50-58` | [A] "AI is black box" |
| A2 | `ao:44-49` (the menu); `ms:106-400` (the table it is drawn from) | keyed 2026-10-30 from the parts table |
| A3 | `ao:65-69` (the path and its branches) | keyed 2026-10-30 from the parts table |
| A4 | `ao:57-63`, `ao:86-90` (the output specification and the rules of voice) | keyed 2026-10-30 from the parts table |
| A5 | `ao:130-147` (the three grounding clauses) | keyed 2026-10-30 from the parts table |
| A6 | `ao:198-341` (the cloud loop) | keyed 2026-10-30 from the parts table |
| A7 | `al:48-77`, `al:36` | [T-Cl] §5 |
| A8 | `al:114-127`, `al:663-676` | [T-Cl] §6 |
| A9 | `al:583-632`, `al:492-500` | [Gm26] |
| A10 | `al:148-183`, `al:830-887` | [Cl14], [G14], 10/25 claim 24 |
| A11 | `al:92-100`, `al:323-437` | [G14] dep 4-5 |
| A12 | `al:756-770`, `al:209-294`, `al:451-482`, `al:893-948` | [Cl14], [G14] |
| A13 | `ad:158-203`, `ad:223-307`, `ad:312-389`, `ad:410-454` | [C] |
| A14 | `ad:158-203`, `ad:223-307`, `ad:312-389`, `ad:410-454` | [C] |
| A15 | `oq:28-79` | [Cl11], [G11], [Gm18] |
| A16 | `ao:92-124`, `sv:2767-2825`, `lr:2235-2258` | [D] |
| A17 | `CODEEXAM_MCP.md:19-25`; `src/commands/ask.js:91` | [D] |
| A18 | `ad:541-560` (the footer) | keyed 2026-10-30 from the parts table |
| A19 | `ix:555-720` | [C] |
| A20 | `lr:2037-2120`; `CODEEXAM_GUI.md:67-82` | [D] |
| A21 | `ad:424-454`, `ad:499-532` (the verification notes) | keyed 2026-10-30 from the parts table |

## Scores (2026-10-30)

Scored with `node scripts/pseudo-claim-rubric-score.mjs`
`--rubric docs/pseudo-claim-rubrics/overview-by-ai.md --run <file>` for each run below:
the best run claim per run (MET counted twice, PARTIAL once)
among the claims with an anchor that matches a row's cite. MET is a cite match with half the
row's content words present, PARTIAL a cite match with a quarter or the words without the cite;
the overlap is a keyword proxy printed beside every verdict, and the reading stays the human's.
The runs are files in the project root of this checkout, not in the repository; "none" means no
claim in that run meets or partly meets a row.

| run | best claim | MET | PARTIAL | ABSENT | surplus (substantive / trivial / ungrounded) | claims considered |
|---|---|---|---|---|---|---|
| CE_pseudo_claim_test_102526_720pm_norank.txt (10/25 7:20pm, Claude, 41 claims) | 14 ([file] ai-overview.js) | 1 | 1 | 27 | 5 / 1 / 10 | 5 |
| CE_pseudo_claims_vocab_concept_overview_Claude.txt (10/27, Claude, 18 claims) | 10 ([file] ai-overview.js) | 1 | 2 | 26 | 1 / 2 / 11 | 4 |
| CE_pseudo_claims_vocab_concept_overview_ChatGPT.txt (10/27, ChatGPT, 18 claims) | 10 ([file] ai-overview.js) | 0 | 3 | 26 | 5 / 1 / 18 | 4 |
| gemma4_CE_pseudo_claims_102926.txt (10/29, Gemma 4 on the Asus, 41 claims) | none | — | — | — | — | 2 |
| CE_pseudo_concept_overview_103026.txt (10/30, Claude, 12 claims) | 6 ([file] ai-overview.js) | 2 | 5 | 22 | 7 / 3 / 3 | 4 |
| CE_pseudo_vocab_103026.txt (10/30, Claude, 9 claims) | none | — | — | — | — | 0 |
