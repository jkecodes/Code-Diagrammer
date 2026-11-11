import json
import shutil
import subprocess
import sys
from conftest import FIXTURES


def call(req):
    p = subprocess.run([sys.executable, "-m", "code_diagrammer"],
                       input=json.dumps(req).encode("utf-8"), capture_output=True)
    assert p.returncode == 0, p.stderr.decode("utf-8", "replace")
    return json.loads(p.stdout.decode("utf-8"))


CNN = str(FIXTURES / "simple_cnn.py")
BASE = {"file": CNN, "entry": "SimpleCNN", "workspaceRoot": str(FIXTURES)}


def test_list():
    out = call({"command": "list", "file": CNN})
    assert out["ok"] and [c["name"] for c in out["classes"]] == ["Block", "SimpleCNN"]


def test_static():
    out = call({"command": "static", **BASE})
    assert out["ok"] and out["graph"]["meta"]["mode"] == "static"


def test_trace():
    out = call({"command": "trace", **BASE, "ctorKwargs": {}, "inputs": {"x": [2, 3, 16, 16]},
                "device": "auto"})
    g = out["graph"]
    assert g["meta"]["mode"] == "traced" and g["meta"]["traceError"] is None
    assert g["meta"]["inputs"] == {"x": [2, 3, 16, 16]}


def test_trace_failure_falls_back_to_static():
    out = call({"command": "trace", **BASE, "ctorKwargs": {}, "inputs": {}, "device": "auto"})
    assert out["ok"] and out["graph"]["meta"]["mode"] == "static"
    assert out["graph"]["meta"]["traceError"].startswith("input: ")
    assert "'x'" in out["graph"]["meta"]["traceError"]


def test_trace_survives_print():
    noisy = str(FIXTURES / "noisy.py")
    out = call({"command": "trace", "file": noisy, "entry": "Noisy", "workspaceRoot": str(FIXTURES),
                "ctorKwargs": {}, "inputs": {"x": [1, 4]}, "device": "auto"})
    assert out["graph"]["meta"]["mode"] == "traced"


def test_static_syntax_error():
    out = call({"command": "static", "file": str(FIXTURES / "broken.py"), "entry": "X",
                "workspaceRoot": str(FIXTURES)})
    assert out["ok"] is False and set(out["error"]) == {"kind", "message", "log"}
    assert out["error"]["kind"] == "syntax" and "line 3" in out["error"]["message"]


def test_static_path_with_space_and_unicode(tmp_path):
    d = tmp_path / "my models 模型"
    d.mkdir()
    shutil.copy(CNN, d / "simple_cnn.py")
    out = call({"command": "static", "file": str(d / "simple_cnn.py"), "entry": "SimpleCNN",
                "workspaceRoot": str(d)})
    assert out["ok"]
    assert out["graph"]["root"]["children"][0]["source"]["file"].endswith("simple_cnn.py")


def test_bad_request():
    assert call({"command": "nope"})["error"]["kind"] == "bad-request"
