import os

from conftest import FIXTURES
from test_cli import call

from code_diagrammer.scan import scan_workspace

SCANPROJ = FIXTURES / "scanproj"
MODULE_SRC = "import torch.nn as nn\nclass M(nn.Module):\n    def forward(self, x):\n        return x\n"


def by_name(root=SCANPROJ):
    return {c["name"]: c for c in scan_workspace(str(root))}


def test_lists_module_classes_across_files_and_skips_other_classes():
    assert set(by_name()) == {"Block", "Unused", "Net"}


def test_candidate_has_forward_and_is_nobodys_submodule():
    c = by_name()
    assert c["Net"]["candidate"] is True
    assert c["Block"]["candidate"] is False      # used by Net
    assert c["Unused"]["candidate"] is False     # no forward


def test_class_details():
    net = by_name()["Net"]
    assert net["forwardParams"] == ["x", "mask"]
    assert net["docstring"] == "A tiny net."
    assert net["submoduleTypes"] == ["Block", "Linear"]
    assert os.path.isabs(net["file"]) and net["line"] > 0


def test_unreadable_files_are_skipped():
    names = by_name()           # broken.py (syntax) and latin1.py (not UTF-8) must not raise
    assert "Net" in names and "X" not in names and "Latin" not in names


def test_ignored_directories(tmp_path):
    for d in [".venv", "node_modules", "__pycache__", "venv"]:
        (tmp_path / d).mkdir()
        (tmp_path / d / "m.py").write_text(MODULE_SRC)
    (tmp_path / "ok.py").write_text(MODULE_SRC)
    assert [c["file"] for c in scan_workspace(str(tmp_path))] == [str(tmp_path / "ok.py")]


def test_cli_scan():
    out = call({"command": "scan", "workspaceRoot": str(SCANPROJ)})
    assert out["ok"] and any(c["name"] == "Net" and c["candidate"] for c in out["classes"])
