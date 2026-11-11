import ast
import pytest
from conftest import FIXTURES
from code_diagrammer.tracing import trace, TraceError

CNN = str(FIXTURES / "simple_cnn.py")
ROOT = str(FIXTURES)


def run(**inputs):
    return trace(CNN, "SimpleCNN", {}, inputs or {"x": [2, 3, 16, 16]}, workspace_root=ROOT)


def test_modules_and_params():
    r = run()
    by = {m.path: m for m in r.modules}
    assert by[""].params == 1322 and by["blocks.0"].params == 600 and by["fc"].params == 90
    assert by["blocks.1"].type == "Block" and by["blocks.1"].class_file.endswith("simple_cnn.py")
    assert by["fc"].class_file is None
    assert by["stem.0"].out_shapes == [[2, 8, 16, 16]] and by["fc"].out_shapes == [[2, 10]]
    assert by["fc"].out_dtypes == ["float32"]
    assert r.device == "meta"


def test_call_keys_match_ast_positions():
    r = run()
    tree = ast.parse(open(CNN, encoding="utf-8").read())
    spans = {(n.lineno, n.col_offset, n.end_lineno, n.end_col_offset)
             for n in ast.walk(tree) if isinstance(n, ast.expr)}
    assert r.calls and all(c.key in spans for c in r.calls)
    root_calls = [(c.kind, c.name) for c in r.calls if c.module_path == ""]
    assert root_calls == [("module", "stem"), ("module", "blocks"), ("op", "mean"),
                          ("op", "view"), ("module", "fc")]
    assert ("op", "add") in [(c.kind, c.name) for c in r.calls if c.module_path == "blocks.0"]


def test_literal_input():
    r = run(x=[2, 3, 16, 16], flag={"value": True})
    assert ("op", "mul") in [(c.kind, c.name) for c in r.calls if c.module_path == ""]


def test_missing_input_named():
    with pytest.raises(TraceError) as e:
        trace(CNN, "SimpleCNN", {}, {}, workspace_root=ROOT)
    assert e.value.kind == "input" and "'x'" in e.value.message


def test_ctor_kwargs_and_cpu():
    r = trace(CNN, "SimpleCNN", {"n_blocks": 3}, {"x": [1, 3, 8, 8]}, device="cpu",
              workspace_root=ROOT)
    assert "blocks.2" in [m.path for m in r.modules] and r.device == "cpu"


def test_relative_import_package():
    r = trace(str(FIXTURES / "pkg" / "model.py"), "Wrapper", {}, {"x": [1, 4]},
              workspace_root=ROOT)
    assert [m.path for m in r.modules][:1] == [""]


def test_loop_records_each_layer():
    r = trace(str(FIXTURES / "loop_net.py"), "LoopNet", {}, {"x": [2, 4]}, workspace_root=ROOT)
    assert [c.name for c in r.calls if c.kind == "module"] == ["layers.0", "layers.1", "layers.2"]
    assert len({c.key for c in r.calls}) == 1


def test_constructor_failure_is_trace_error():
    with pytest.raises(TraceError) as e:
        trace(CNN, "SimpleCNN", {"nope": 1}, {"x": [1, 3, 8, 8]}, workspace_root=ROOT)
    assert e.value.kind == "construct" and "nope" in e.value.log
