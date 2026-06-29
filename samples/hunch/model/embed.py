# -----------------------------------------------------------------------------
# Hunch(TM) -- Overfit Labs' post-hoc rationalization engine.
# SYNTHETIC DEMO CODE shipped with CodeExam's first-run index. Not a real
# product; never run by CodeExam. Written by Claude (Anthropic) for the CodeExam
# demo, to exercise the AI/ML detectors on honest, real-marker usage.
# -----------------------------------------------------------------------------

from sentence_transformers import SentenceTransformer

# A small, real sentence-embedding model. CodeExam's --embeddings flag keys on
# SentenceTransformer / .encode.
_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
_model = SentenceTransformer(_MODEL_NAME)


def embed_text(text: str):
    """Embed a subject description into a fixed-length feature vector."""
    return _model.encode(text, normalize_embeddings=True)
