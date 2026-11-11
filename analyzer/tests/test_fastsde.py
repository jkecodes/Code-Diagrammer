"""Acceptance against a real paper repo (spec section 7).

Needs `analyzer/tests/external/FAST-SDE` (pinned commit 024c7f3) and `torchlibrosa`.
"""
import pytest
from pathlib import Path
from conftest import child, names, edges
from code_diagrammer.cli import handle
from code_diagrammer.ir import Graph

REPO = Path(__file__).parent / "external" / "FAST-SDE"
FILE = REPO / "models" / "fastsde.py"
pytestmark = pytest.mark.skipif(not FILE.exists(), reason="FAST-SDE not cloned")
BASE = {"file": str(FILE), "entry": "SeldNetSubbandFast", "workspaceRoot": str(REPO)}


def lines(start_text):
    src = FILE.read_text(encoding="utf-8").splitlines()
    return next(i for i, l in enumerate(src, 1) if start_text in l)


def test_static_structure():
    g = Graph.from_dict(handle({"command": "static", **BASE})["graph"])
    root = g.root
    mods = [c.name for c in root.children if c.kind == "module"]
    for m in ["split", "enc", "fuse", "gru", "head"]:
        assert m in mods
    assert child(root, "extract_features").kind == "group"
    assert "STFT" in names(child(root, "extract_features"))
    enc = child(root, "enc")
    assert [c.name for c in enc.children if c.kind == "module"] == ["proj", "blocks"]
    ffb = child(enc, "blocks").children[0]
    assert ffb.type == "FastFilterBlock" and ffb.repeated
    assert [c.name for c in ffb.children] == ["pw1", "dw_a", "dw_b", "cat", "pw2", "add"]
    assert enc.source.startLine == lines("class SharedSubbandEncoder")
    assert ffb.source.startLine == lines("class FastFilterBlock")
    assert child(root, "split").source.startLine == lines("class SubbandSplitNoOverlap")


def test_traced_shapes_match_paper_figure():
    out = handle({"command": "trace", **BASE, "ctorKwargs": {}, "inputs": {"wav": [1, 3200]},
                  "device": "auto"})
    g = Graph.from_dict(out["graph"])
    assert g.meta.trace_error is None, out.get("log")
    got = [(a, b, s) for a, b, s, _ in edges(g.root)]
    for expected in [
        ("extract_features", "split", [1, 3, 26, 256]),   # 3 x T x F
        ("split", "view", [1, 8, 3, 26, 32]),
        ("view", "enc", [8, 3, 26, 32]),                  # N x 3 x T x (F/N)
        ("enc", "view", [8, 24, 26, 32]),                 # N x C x T x (F/N)
        ("mul", "view", [1, 8, 24, 26]),                  # N x C x T
        ("view", "fuse", [1, 192, 26]),
        ("fuse", "permute", [1, 64, 26]),                 # C_Fuse x T
        ("gru", "mean", [1, 26, 96]),
        ("mul", "head", [1, 96]),
        ("head", "$out", [1, 1]),
    ]:
        assert expected in got, f"missing {expected}; got {got}"
    assert len(child(child(g.root, "enc"), "blocks").children) == 3
    assert "squeeze" not in names(g.root)   # the return_seq branch did not run
