#!/usr/bin/env python3
"""
AUTO-GENERATED instrumentation harness -- emitted by CodeExam (--emit-harness)
==============================================================================
Target class : InterpretableNeuralNet
Source       : integrated-interpretability-14.py:9
Index        : .as_ml_pytest
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
"""

import re
import torch


# ---------------------------------------------------------------------------
# MECHANICAL PART 1 -- statically extracted namespace + heuristic role labels.
# ---------------------------------------------------------------------------
STATIC_NAMESPACE = [
    "network",  # nn.Sequential
    "network.0",  # ?
]

STATIC_ROLES = {

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


# ---------------------------------------------------------------------------
# YOU SUPPLY: model instance + sample input.
# ---------------------------------------------------------------------------
def load_model():
    """Return (model, args_tuple, kwargs_dict) for one forward pass.

    Import hint (verify against your environment):
        # from integrated-interpretability-14 import InterpretableNeuralNet

    Typical shapes:
      - real checkpoint:   model = InterpretableNeuralNet.from_pretrained(...)  (HF-style)
      - config-only/tiny:  build a small config and instantiate InterpretableNeuralNet(cfg)
        with random weights -- structure/namespace validation without downloads.
    """
    raise NotImplementedError(
        "Supply a InterpretableNeuralNet instance and a sample input here, then rerun."
    )


def main():
    model, fwd_args, fwd_kwargs = load_model()
    model = model.eval()
    records, runtime_names = instrument(model)
    with torch.no_grad():
        model(*fwd_args, **fwd_kwargs)
    report(records)
    cross_check(runtime_names)


if __name__ == "__main__":
    main()
