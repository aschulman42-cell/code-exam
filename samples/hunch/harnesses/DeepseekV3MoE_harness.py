#!/usr/bin/env python3
"""
AUTO-GENERATED instrumentation harness -- emitted by CodeExam (--emit-harness)
==============================================================================
Target class : DeepseekV3MoE
Source       : models/deepseek_v3/modeling_deepseek_v3.py:156
Index        : .transformers
Template     : activation-hook (#95 foothold)

CodeExam emitted this file MECHANICALLY from static analysis of the model's
nn.Module tree. CodeExam never runs it -- you do. REVIEW BEFORE RUNNING.

Mechanical (static, no LLM):
  - STATIC_NAMESPACE : recursive hook-path namespace read from each class's
                       `self.x = SubModule(...)` assignments. `{i}` marks an
                       nn.ModuleList repeat (count known only at runtime).
  - STATIC_ROLES     : heuristic name-pattern labels -- verify before relying.
  - hook registration + shape/dtype capture + static-vs-runtime cross-check.

You supply (the one non-mechanical step): a model instance and an apt sample
input, in load_model() below. CodeExam cannot know your checkpoint or a
meaningful input -- that seam is intentionally left to you.

READING THE OUTPUT
------------------
Two sections print when you run this:

1. CAPTURED ACTIVATIONS -- one row per forward hook = one submodule's
   output tensor, as data flows through. Columns: path, class, output
   shape, dtype, and (where labeled) a role. For example, a row like
     experts.{i}.act_fn  -> the activation tensor (a natural "what features fire" tap)
   tells you the tensor SHAPE at that point (real even with random
   weights) -- though the VALUES are only meaningful with real weights
   and an apt input.

2. STATIC-VS-RUNTIME CROSS-CHECK -- did CodeExam's statically-read
   namespace match the model's real module tree? "none / none" means the
   static map was exact. Mismatches point at modules created dynamically
   (static miss) or that the extractor did not predict.

WHY THESE ARE "SEAMS" (instrumentation points)
----------------------------------------------
Every named submodule is a clean tensor boundary: a forward hook reads
(or, if you extend it, intervenes on) the tensor crossing it -- no model
edits needed. That makes each a ready probe point for dynamic analysis:
  - activation taps (e.g. experts.{i}.act_fn) -> feed an SAE / collect features;
  - repeated blocks (experts.{i}) -> per-layer probes across depth.
The role labels flag the circuit-relevant taps; this harness captures
shapes + the namespace so the dynamic step (SHAP/PCA/UMAP/activation
patching, run by you) starts from correct wiring, not a guess.
"""

import os
import re
import torch

# Provenance -- where this harness came from (printed at the top of its output).
TARGET_CLASS = "DeepseekV3MoE"
SOURCE       = "models/deepseek_v3/modeling_deepseek_v3.py:156"
INDEX        = ".transformers"


# ---------------------------------------------------------------------------
# MECHANICAL PART 1 -- statically extracted namespace + heuristic role labels.
# ---------------------------------------------------------------------------
STATIC_NAMESPACE = [
    "experts",  # nn.ModuleList container (non-hookable: no forward)
    "experts.{i}",  # DeepseekV3MLP
    "experts.{i}.gate_proj",  # nn.Linear -- MLP in-projection (gated/SwiGLU pair)
    "experts.{i}.up_proj",  # nn.Linear -- MLP in-projection (gated/SwiGLU pair)
    "experts.{i}.down_proj",  # nn.Linear -- MLP output -> residual add
    "experts.{i}.act_fn",  # (activation module) -- activation (SAE-candidate)
    "gate",  # DeepseekV3TopkRouter -- router / gating
    "shared_experts",  # DeepseekV3MLP
    "shared_experts.gate_proj",  # nn.Linear -- MLP in-projection (gated/SwiGLU pair)
    "shared_experts.up_proj",  # nn.Linear -- MLP in-projection (gated/SwiGLU pair)
    "shared_experts.down_proj",  # nn.Linear -- MLP output -> residual add
    "shared_experts.act_fn",  # (activation module) -- activation (SAE-candidate)
]

STATIC_ROLES = {
    "experts.{i}.gate_proj": "MLP in-projection (gated/SwiGLU pair)",
    "experts.{i}.up_proj": "MLP in-projection (gated/SwiGLU pair)",
    "experts.{i}.down_proj": "MLP output -> residual add",
    "experts.{i}.act_fn": "activation (SAE-candidate)",
    "gate": "router / gating",
    "shared_experts.gate_proj": "MLP in-projection (gated/SwiGLU pair)",
    "shared_experts.up_proj": "MLP in-projection (gated/SwiGLU pair)",
    "shared_experts.down_proj": "MLP output -> residual add",
    "shared_experts.act_fn": "activation (SAE-candidate)",
}


def role_for(name):
    """Map a concrete runtime path back to its templated role label, if any."""
    templ = re.sub(r"\.\d+(?=\.|$)", ".{i}", name)
    return STATIC_ROLES.get(templ, "")


# ---------------------------------------------------------------------------
# MECHANICAL PART 2 -- hook registration + capture + cross-check.
# ---------------------------------------------------------------------------
def _shape(t):
    return tuple(t.shape) if isinstance(t, torch.Tensor) else type(t).__name__


def instrument(model):
    """Register a forward hook on every named submodule. Returns the records
    list (filled during the forward pass) and the runtime name set."""
    records = []

    def make_hook(path):
        def hook(module, inputs, output):
            out = output[0] if isinstance(output, tuple) else output
            records.append({
                "path": path,
                "class": type(module).__name__,
                "out_shape": _shape(out),
                "dtype": str(getattr(out, "dtype", None)),
                "role": role_for(path),
            })
        return hook

    runtime_names = set()
    for name, module in model.named_modules():
        if name:
            module.register_forward_hook(make_hook(name))
            runtime_names.add(name)
    return records, runtime_names


def cross_check(runtime_names):
    """Compare CE's static namespace to the model's real runtime tree.
    {i} templates match any numeric index -- repeat counts are runtime facts.
    A static path with no runtime match = a static-analysis miss; a runtime
    module matching no static path = something the extractor didn't predict
    (e.g. a module created dynamically). Either is worth surfacing."""
    def to_regex(p):
        return re.compile("^" + re.escape(p).replace(r"\{i\}", r"\d+") + "$")
    static_res = [(p, to_regex(p)) for p in STATIC_NAMESPACE]
    missing = [p for p, rx in static_res if not any(rx.match(n) for n in runtime_names)]
    unpredicted = sorted(n for n in runtime_names
                         if not any(rx.match(n) for _, rx in static_res))
    print("\n=== static-vs-runtime namespace cross-check ===")
    print(f"  static paths   : {len(STATIC_NAMESPACE)}")
    print(f"  runtime modules: {len(runtime_names)}")
    print(f"  static paths with no runtime match : {missing or 'none'}")
    print(f"  runtime modules CE did not predict : {unpredicted or 'none'}")


def report(records):
    print("\n=== captured activations (path -> class, out shape, dtype | role) ===")
    for r in records:
        role = f"  | {r['role']}" if r["role"] else ""
        print(f"  {r['path']:32s} {r['class']:24s} {str(r['out_shape']):20s} "
              f"{r['dtype']}{role}")


def provenance():
    """Print where this harness came from -- so redirected output is self-identifying."""
    here = os.path.basename(__file__)
    print("Output from CodeExam --emit-harness (activation-hook template)")
    print(f"  Target: {TARGET_CLASS}")
    print(f"  Source: {SOURCE}")
    print(f"  Index : {INDEX}")
    print(f"  Guide : see the docstring at the top of {here} for how to read this")
    print(f"          output and why these submodule boundaries are useful 'seams'.")


def dynamic_coverage(records, runtime_names):
    """For each REPEATED block (a '{i}' template), how many instances actually
    FIRED (their forward ran) vs how many are REGISTERED. fired < registered
    means dynamic / conditional execution -- e.g. a Mixture-of-Experts enlists
    only the top-k experts the router picks for THIS input, so you see e.g.
    '4 of 32 experts fired'. This is the static-structure vs dynamic-behavior
    gap made concrete -- the thing static analysis alone cannot tell you."""
    fired = {r["path"] for r in records}
    blocks = [p for p in STATIC_NAMESPACE if p.endswith(".{i}") or p == "{i}"]
    if not blocks:
        return
    print("\n=== dynamic coverage (instances fired vs registered, per repeated block) ===")
    for tmpl in blocks:
        rx = re.compile("^" + re.escape(tmpl).replace(r"\{i\}", r"\d+") + "$")
        reg = sum(1 for n in runtime_names if rx.match(n))
        fir = sum(1 for n in fired if rx.match(n))
        flag = "   <- dynamic: only some ran for this input (e.g. MoE routing)" if fir < reg else ""
        print(f"  {tmpl:28s} {fir:4d} of {reg:4d} fired{flag}")


# ---------------------------------------------------------------------------
# YOU SUPPLY: model instance + sample input.
# ---------------------------------------------------------------------------
def load_model():
    """Return (model, args_tuple, kwargs_dict) for one forward pass.

    Import hint (verify against your environment):
        # from models.deepseek_v3.modeling_deepseek_v3 import DeepseekV3MoE

    Typical shapes:
      - real checkpoint:   model = DeepseekV3MoE.from_pretrained(...)  (HF-style)
      - config-only/tiny:  build a small config and instantiate DeepseekV3MoE(cfg)
        with random weights -- structure/namespace validation without downloads.
    """
    raise NotImplementedError(
        "Supply a DeepseekV3MoE instance and a sample input here, then rerun."
    )


def main():
    provenance()
    model, fwd_args, fwd_kwargs = load_model()
    model = model.eval()
    records, runtime_names = instrument(model)
    # The forward pass can fail on a wrong synthetic INPUT SHAPE (a # FIXME),
    # but the static-vs-runtime cross-check below does NOT need it -- module
    # registration (named_modules) happened at instrument() time, before this.
    # So a shape error still leaves the STRUCTURE validation intact.
    forward_ok = True
    try:
        with torch.no_grad():
            model(*fwd_args, **fwd_kwargs)
    except Exception as e:
        forward_ok = False
        print(f"\n[forward did not complete: {type(e).__name__}: {e}]")
        print("  Activation capture is partial. If you used --synthetic-loader this is")
        print("  almost certainly the input SHAPE (a # FIXME in load_model). The static-")
        print("  vs-runtime cross-check below is STILL VALID (it uses module registration,")
        print("  which happens before the forward pass).")
    report(records)
    cross_check(runtime_names)
    if forward_ok:
        dynamic_coverage(records, runtime_names)


if __name__ == "__main__":
    main()
