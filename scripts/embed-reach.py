# Copyright 2026 CodeExam contributors — https://github.com/aschulman42-cell/code-exam
# Licensed under the Apache License, Version 2.0.
#
# issue-322-codebert-reach-test: embed every claim element and every symbol of
# the agreement harness's indexes with code-text encoders, so
# scripts/embed-reach-score.mjs can ask, with no model, whether a litigant's
# cited functions are within reach of a claim element by cosine.
#
#   python scripts/embed-reach.py --work <dir> [--only id,id] [--models codebert,unixcoder]
#       [--reprs name,sig,body] [--device auto|cpu|cuda] [--batch 32] [--max-symbols N]
#       [--index <path> --tree <dir> --index-key <key>]   (one index outside the harness)
#       [--claim <id>=<elements file>]                      (one claim outside the harness)
#
# Layout under <work>/embed/:
#   index/<indexKey>/keys.json              ["file@name", ...] in a fixed order
#   index/<indexKey>/<model>/<repr>.npy     float32, unit-norm rows, one per key
#   claims/<id>/elements.json               element texts in order
#   claims/<id>/<model>/elements.npy        one row per element
#   log.jsonl                               one line per (index, model): device, seconds, symbols
# Resumable: an existing .npy is skipped. Requires torch, transformers, numpy.
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

MODELS = {
    "codebert": "microsoft/codebert-base",
    "unixcoder": "microsoft/unixcoder-base",
}
MAX_TOKENS = 512


def symbol_tokens(name: str) -> str:
    """The same split src/core/symbol-verify.js symbolTokens applies: camel, snake, ::, . → words."""
    s = re.sub(r"[:.]+", " ", name or "")
    s = re.sub(r"[_\-]+", " ", s)
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
    return " ".join(t for t in s.lower().split() if len(t) > 1)


def read_elements(path: Path):
    out = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        out.append(t)
    return out


def load_symbols(index_dir: Path, tree: Path | None, max_symbols: int | None):
    """Keys 'file@name' in a fixed order (sorted files, names in index order) with body text when the tree exists."""
    fi = json.loads((index_dir / "function_index.json").read_text(encoding="utf-8"))
    keys, sigs, bodies = [], [], []
    file_cache = {}
    missing_tree = 0
    for file in sorted(fi.keys()):
        fns = fi[file] or {}
        lines = None
        if tree is not None:
            src = tree / file.split("!")[-1]
            if src.exists():
                if file not in file_cache:
                    try:
                        file_cache[file] = src.read_text(encoding="utf-8", errors="replace").splitlines()
                    except OSError:
                        file_cache[file] = None
                lines = file_cache[file]
            else:
                missing_tree += 1
        for name, info in fns.items():
            keys.append(f"{file}@{name}")
            start = int((info or {}).get("start") or 0)
            end = int((info or {}).get("end") or 0)
            if lines and start >= 1 and end >= start:
                chunk = lines[start - 1:end]
                sigs.append("\n".join(chunk[:20]))
                bodies.append("\n".join(chunk))
            else:
                sigs.append(name)
                bodies.append(name)
            if max_symbols and len(keys) >= max_symbols:
                return keys, sigs, bodies, missing_tree
    return keys, sigs, bodies, missing_tree


def embed_texts(model, tokenizer, texts, device, batch):
    import numpy as np
    import torch

    out = np.zeros((len(texts), model.config.hidden_size), dtype=np.float32)
    with torch.no_grad():
        for i in range(0, len(texts), batch):
            chunk = texts[i:i + batch]
            enc = tokenizer(chunk, padding=True, truncation=True, max_length=MAX_TOKENS, return_tensors="pt").to(device)
            hidden = model(**enc).last_hidden_state
            mask = enc["attention_mask"].unsqueeze(-1).to(hidden.dtype)
            pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1)
            pooled = torch.nn.functional.normalize(pooled, dim=-1)
            out[i:i + len(chunk)] = pooled.float().cpu().numpy()
            if (i // batch) % 50 == 0:
                print(f"    {i + len(chunk)}/{len(texts)}", file=sys.stderr)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--models", default="codebert,unixcoder")
    ap.add_argument("--reprs", default="name,sig,body")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--max-symbols", type=int, default=None, help="embed only the first N symbols (a smoke test)")
    ap.add_argument("--max-index-symbols", type=int, default=None,
                    help="skip an index with more symbols than this (CPU runs keep sig/body to small indexes)")
    ap.add_argument("--index", default=None, help="one index dir outside the harness")
    ap.add_argument("--tree", default=None, help="its source tree, for sig and body")
    ap.add_argument("--index-key", default=None)
    ap.add_argument("--claim", action="append", default=[], help="id=<elements file>")
    a = ap.parse_args()

    import numpy as np
    import torch
    from transformers import AutoModel, AutoTokenizer

    device = ("cuda" if torch.cuda.is_available() else "cpu") if a.device == "auto" else a.device
    work = Path(a.work)
    embed = work / "embed"
    embed.mkdir(parents=True, exist_ok=True)
    log = (embed / "log.jsonl").open("a", encoding="utf-8")
    only = {s.strip() for s in a.only.split(",") if s.strip()}
    models = [m.strip() for m in a.models.split(",") if m.strip()]
    reprs = [r.strip() for r in a.reprs.split(",") if r.strip()]

    # What to embed: the harness's pairs, or the one index / claims named.
    indexes = []  # (key, index_dir, tree_dir)
    claims = []   # (id, elements file)
    if a.index:
        key = a.index_key or Path(a.index).name
        indexes.append((key, Path(a.index), Path(a.tree) if a.tree else None))
    for c in a.claim:
        cid, _, f = c.partition("=")
        claims.append((cid, Path(f)))
    if not a.index and not a.claim:
        manifest = json.loads((work / "manifest.json").read_text(encoding="utf-8"))
        cands = manifest.get("candidates") or []
        cands = cands if isinstance(cands, list) else list(cands.values())
        seen = set()
        for c in cands:
            if only and c.get("id") not in only:
                continue
            # The asserted claim is not always claim 1 (Core Scientific 1-8 asserts
            # claim 3, FriendliAI claim 10); the harness names the file by it.
            nums = c.get("claims") or [1]
            ef = work / "out" / c["id"] / f"claim-{nums[0]}.elements.txt"
            if ef.exists():
                claims.append((c["id"], ef))
            for r in c.get("repos") or []:
                key = f"{r['org']}__{r['repo']}__{str(r.get('resolvedRef') or r.get('ref') or '')[:7]}"
                if key in seen:
                    continue
                seen.add(key)
                idir = work / "indexes" / key
                if idir.exists():
                    tree = work / "trees" / key
                    indexes.append((key, idir, tree if tree.exists() else None))

    loaded = {}

    def get(mname):
        if mname not in loaded:
            hf = MODELS[mname]
            tok = AutoTokenizer.from_pretrained(hf)
            mdl = AutoModel.from_pretrained(hf).to(device).eval()
            loaded[mname] = (mdl, tok)
        return loaded[mname]

    for cid, ef in claims:
        texts = read_elements(ef)
        cdir = embed / "claims" / cid
        cdir.mkdir(parents=True, exist_ok=True)
        (cdir / "elements.json").write_text(json.dumps(texts, indent=1), encoding="utf-8")
        for mname in models:
            out = cdir / mname / "elements.npy"
            if out.exists():
                continue
            out.parent.mkdir(parents=True, exist_ok=True)
            mdl, tok = get(mname)
            np.save(out, embed_texts(mdl, tok, texts, device, a.batch))
            print(f"[embed] claim {cid} {mname}: {len(texts)} elements", file=sys.stderr)

    for key, idir, tree in indexes:
        keys, sigs, bodies, missing_tree = load_symbols(idir, tree, a.max_symbols)
        if a.max_index_symbols and len(keys) > a.max_index_symbols:
            print(f"[embed] {key}: {len(keys)} symbols, over --max-index-symbols {a.max_index_symbols}; skipped", file=sys.stderr)
            continue
        kdir = embed / "index" / key
        kdir.mkdir(parents=True, exist_ok=True)
        (kdir / "keys.json").write_text(json.dumps(keys), encoding="utf-8")
        names = [symbol_tokens(k.split("@", 1)[1]) or k.split("@", 1)[1] for k in keys]
        texts_by_repr = {"name": names, "sig": sigs, "body": bodies}
        for mname in models:
            mdl, tok = get(mname)
            for r in reprs:
                out = kdir / mname / f"{r}.npy"
                if out.exists():
                    continue
                out.parent.mkdir(parents=True, exist_ok=True)
                t0 = time.time()
                vecs = embed_texts(mdl, tok, texts_by_repr[r], device, a.batch)
                np.save(out, vecs)
                secs = time.time() - t0
                rec = {"index": key, "model": mname, "repr": r, "symbols": len(keys), "device": device,
                       "seconds": round(secs, 1), "treeMissingFiles": missing_tree,
                       "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                log.write(json.dumps(rec) + "\n")
                log.flush()
                print(f"[embed] {key} {mname} {r}: {len(keys)} symbols in {secs:.0f}s on {device}"
                      f"{' (tree missing for ' + str(missing_tree) + ' files)' if missing_tree else ''}", file=sys.stderr)


if __name__ == "__main__":
    main()
