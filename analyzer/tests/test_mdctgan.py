"""Second acceptance repo (user request): https://github.com/neoncloud/mdctGAN, arXiv 2305.11104.

Needs `analyzer/tests/external/mdctGAN` (commit 0e2063c), torchvision, einops and
bottleneck_transformer_pytorch. Generator config follows the repo's train.sh.
"""
import pytest
from pathlib import Path
from conftest import child, names, edges
from code_diagrammer.cli import handle
from code_diagrammer.ir import Graph

REPO = Path(__file__).parent / "external" / "mdctGAN"
FILE = REPO / "models" / "networks.py"
pytest.importorskip("bottleneck_transformer_pytorch")
pytestmark = pytest.mark.skipif(not FILE.exists(), reason="mdctGAN not cloned")
BASE = {"file": str(FILE), "entry": "LocalEnhancer", "workspaceRoot": str(REPO)}
KWARGS = {"input_nc": 2, "output_nc": 1, "ngf": 56, "n_downsample_global": 3,
          "n_blocks_global": 4, "n_local_enhancers": 1, "n_blocks_local": 3,
          "downsample_type": "resconv", "upsample_type": "interpolate",
          "n_attn_g": 3, "heads_g": 6, "dim_head_g": 128, "proj_factor_g": 4}


def test_static_structure():
    g = Graph.from_dict(handle({"command": "static", **BASE})["graph"])
    assert names(g.root) == ["downsample", "model", "model1_1", "add", "model1_2"]
    assert ("model", "add", None, False) in edges(g.root)        # global branch
    assert ("model1_1", "add", None, False) in edges(g.root)     # local branch
    assert ("add", "model1_2", None, False) in edges(g.root)


def test_traced_generator():
    out = handle({"command": "trace", **BASE, "ctorKwargs": KWARGS,
                  "inputs": {"input": [1, 2, 128, 256]}, "device": "auto"})
    g = Graph.from_dict(out["graph"])
    assert g.meta.trace_error is None, out.get("log")
    # the half-resolution input goes to the global generator, the full one to the local branch
    assert [(a, b, s) for a, b, s, _ in edges(g.root)] == [
        ("$in", "downsample", [1, 2, 128, 256]),
        ("downsample", "model", [1, 2, 64, 128]),
        ("$in", "model1_1", [1, 2, 128, 256]),
        ("model1_1", "add", [1, 112, 64, 128]),
        ("model", "add", [1, 112, 64, 128]),
        ("add", "model1_2", [1, 112, 64, 128]),
        ("model1_2", "$out", [1, 1, 128, 256])]
    res = child(child(g.root, "model1_1"), "4")
    assert res.type == "ConvResBlock"
    assert ("conv_res", "add", [1, 112, 64, 128]) in [(a, b, s) for a, b, s, _ in edges(res)]
    assert any(c.type == "BottleStack" for c in child(g.root, "model").children)
    resnet = next(c for c in child(g.root, "model1_2").children if c.type == "ResnetBlock")
    assert child(resnet, "conv_block").type == "Sequential"
