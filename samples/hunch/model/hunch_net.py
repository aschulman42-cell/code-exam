# -----------------------------------------------------------------------------
# Hunch(TM) -- Overfit Labs' post-hoc rationalization engine.
# SYNTHETIC DEMO CODE shipped with CodeExam's first-run index. Not a real
# product; never run by CodeExam. Written by Claude (Anthropic) for the CodeExam
# demo, to exercise the AI/ML detectors on honest, real-marker usage.
# -----------------------------------------------------------------------------

import torch
import torch.nn as nn


class HunchNet(nn.Module):
    """The Hunch model.

    Architecturally unremarkable -- a plain MLP that maps a feature vector to a
    two-class verdict. The "intelligence" Overfit Labs markets lives entirely in
    the explanation layer (see app/agent.js), not here. CodeExam's --models
    flag reaches this via the nn.Module base class.
    """

    def __init__(self, in_dim: int = 64, hidden: int = 128):
        super().__init__()
        self.network = nn.Sequential(
            nn.Linear(in_dim, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, 2),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.network(x)
