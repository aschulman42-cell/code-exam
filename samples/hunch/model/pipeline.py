# -----------------------------------------------------------------------------
# Hunch(TM) -- Overfit Labs' post-hoc rationalization engine.
# SYNTHETIC DEMO CODE shipped with CodeExam's first-run index. Not a real
# product; never run by CodeExam. Written by Claude (Anthropic) for the CodeExam
# demo, to exercise the AI/ML detectors on honest, real-marker usage.
#
# The inference pipeline: load -> featurize -> predict -> explain -> report.
# Run `call_tree` (or the mermaid view) on run() to see the whole chain.
# -----------------------------------------------------------------------------

import json

import torch

from .hunch_net import HunchNet
from .embed import embed_text


def load_model(path: str) -> HunchNet:
    """Load the trained Hunch model and put it in eval mode."""
    model = HunchNet()
    model.load_state_dict(torch.load(path, map_location="cpu"))
    model.eval()
    return model


def load_subject(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def build_features(subject: dict) -> torch.Tensor:
    """Turn a subject's prose description into a feature vector."""
    vec = embed_text(subject["description"])
    return torch.tensor(vec, dtype=torch.float32).unsqueeze(0)


@torch.no_grad()
def predict(model: HunchNet, features: torch.Tensor):
    """Run inference. Returns (verdict_index, confidence)."""
    logits = model(features)
    probs = torch.softmax(logits, dim=-1)
    conf, idx = torch.max(probs, dim=-1)
    return int(idx.item()), float(conf.item())


def explain(verdict: str, subject: dict) -> str:
    """Post-hoc rationalization. In the product this calls app/agent.js over RPC;
    here it is a stub so the pipeline is self-contained."""
    return f"The verdict '{verdict}' was, in retrospect, the only possible reading."


def format_report(subject: dict, verdict: str, confidence: float, rationale: str) -> str:
    return (
        f"# Hunch Report: {subject.get('id', '?')}\n\n"
        f"**Verdict:** {verdict}  (**confidence:** {confidence:.0%})\n\n"
        f"{rationale}\n"
    )


VERDICTS = ["clean", "AI-washing"]


def run(subject_path: str, model_path: str) -> str:
    """End-to-end: the call chain CodeExam renders as the Hunch pipeline."""
    model = load_model(model_path)
    subject = load_subject(subject_path)
    features = build_features(subject)
    idx, confidence = predict(model, features)
    verdict = VERDICTS[idx]
    rationale = explain(verdict, subject)
    return format_report(subject, verdict, confidence, rationale)
