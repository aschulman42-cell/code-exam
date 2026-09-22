# Reproducibility & determinism

CodeExam is built so that an examination can be repeated and defended. Most of it
is deterministic by construction. (CodeExam's own code was generated with heavy AI
help — Claude, in Claude Code — but the AI's knowledge and abilities are baked into
ordinary, fixed JavaScript; the shipped program runs the same way every time, with
no model in the loop.) Where an AI LLM *is* in the loop — the LLM-assisted features,
where CodeExam steers the model with prompts built into CE — whether a result
repeats depends on the engine, and the two engines differ in a way that matters for
the record.

How CodeExam should make its assertions defensible and auditable is still being
worked out in the open — see issue #319, an ongoing discussion of exactly this.
Read this doc as where things stand today, not the final word.

## The non-LLM commands are deterministic

Indexing, search, cross-references, metrics, catalogs, structural search,
extraction — everything that isn't an LLM feature — produce the same output from
the same index and the same invocation, every time. There is no model in the
loop. The exact set of places a model *does* touch CodeExam's output is
enumerated in the **determinism boundary** table in
[docs/model-support.md](model-support.md); everything outside that table is
deterministic code.

## Local models: repeatable when you lock a run down

A local GGUF model can be made to give the same answer twice. Add
**`--reproducible`** and CodeExam runs the model deterministically — temperature
0 and a fixed seed, so sampling stops introducing variation. With the engine
version also fixed — CodeExam ships one exact `node-llama-cpp` / `llama.cpp`
build (see [LOCAL_LLM.md](LOCAL_LLM.md)) — the same question over the same index
and model file has, in testing, produced the same answer bit for bit.

Two honest caveats:

- It is an **empirical, environment-scoped** result, not a formal guarantee
  about the computation. It has held per machine / model file / configuration;
  identical output across *different* machines, GPU drivers, or compute backends
  is not promised.
- Reproducibility means holding *all* the inputs still, not just sampling.
  Sampling is the big one, and `--reproducible` handles it; the subtler input is
  the prompt text itself. CodeExam keeps that stable by default — for example, it
  does not inject the current date into the model's system prompt unless you ask
  it to (`--live-today-date`, off precisely so a run doesn't drift from one day
  to the next). The rule of thumb: pin the sampling, and don't feed the model
  anything that changes on its own.

## Cloud models: not fully reproducible, even at temperature 0

A cloud model (Claude, ChatGPT, Gemini) is **not fully reproducible**, even pinned
to temperature 0. It will usually give you substantially the same answer twice — the
same finding, the same code — but not the *same words*: provider-side batching and
infrastructure nondeterminism mean the exact text can vary from one call to the next.
CodeExam sends cloud chat at temperature 0 by default, which narrows that variation
but cannot remove it — it originates in how the provider runs the model on their own
hardware, which you don't control.

## The asymmetry, and why it matters

This is the one place the local path is *more* dependable than the cloud, not less:
**you can lock a local model down to the byte; you cannot completely lock down a
cloud one.** For a result that has to be defensible or repeated for the record — an
examination artifact, a figure in a report — that is a reason to run it locally with
`--reproducible`: a local run can be reproduced exactly, where a cloud run
reproduces only in substance.

## Showing it, not just claiming it

What you are usually demonstrating is **substantial identicality**: run the
examination again and it reaches the same result — the same code identified, the
same verdicts, the same conclusion — even if a sentence is worded differently. That
is the bar that matters for defending a finding, and it is the one to check first —
save both runs and confirm they *say the same thing*, not that they are the same
file.

**Bit-for-bit is the strongest form, and it's available on a fully pinned local
run.** When the run is pinned (local model, `--reproducible`, fixed engine) you can
go all the way to byte-identical output and prove it with a hash (`certutil
-hashfile <file> SHA256` on Windows, `sha256sum <file>` on Linux) — the cleanest
possible evidence, worth capturing when you can. But treat it as a bonus, not the
pass/fail line: a differing hash is *not* a failure to reproduce. A cloud run, or an
unpinned local one, can be fully reproducible in substance while a single reworded
phrase changes the hash. Record the particulars either way — the model file and its
quantization, the context size, the CodeExam version, and whether `--reproducible`
was in force.

**Convergence across models, for the finding itself.** A stronger question than
"does one model repeat itself?" is "do independent readers agree?" Run the same
claim search under two or three different models — or a local model and a cloud one —
and see whether they land on broadly the same code for a given claim, or on wildly
different code. When independent models converge on the same functions, that
agreement is better evidence that the reading is real than bit-identity from any
single model. Divergence is informative too: it flags a claim element where the code
mapping is genuinely contestable and worth a closer look.

## Where CodeExam is going on determinism and reproducibility

Convergence is worth measuring, not just eyeballing, and that's the direction of
travel. One piece exists today: **`--runs <n>`** repeats the claim-locate
discovery-and-selection cycle n times and keeps every target any run proposed,
tallying each as "Runs-found: N/n" — so a code location that surfaces in all n
runs is firmer evidence than one that surfaced once. Its scope is narrow (it
votes on which *targets* to surface, at the locate stage, and cost is linear in
n), but the principle is the one above: sample more than once and let agreement
speak.

The planned extension is to make cross-run and cross-model agreement a
first-class option — running an examination several times over one model and/or
across several models, then merging, comparing, and scoring the results (voting /
quorum) so a conclusion carries an explicit agreement figure rather than resting
on a single pass. The shape of that is part of the open #319 discussion.
