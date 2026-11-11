"""Findings of the final whole-branch review. Each test reproduces one of them."""
import ast

from conftest import FIXTURES, child, edges, names
from test_cli import call

from code_diagrammer.flow import call_key
from code_diagrammer.merge import build_traced_graph
from code_diagrammer.static_analysis import TemplateIndex, build_static_graph
from code_diagrammer.tracing import trace

ROOT = str(FIXTURES)
IDIOMS = str(FIXTURES / "idioms.py")


def static_root(entry):
    return build_static_graph(TemplateIndex(ROOT), IDIOMS, entry).root


def traced(entry, inputs, kwargs=None, file=IDIOMS):
    r = trace(file, entry, kwargs or {}, inputs, workspace_root=ROOT)
    return build_traced_graph(TemplateIndex(ROOT), r, file, entry, kwargs or {}, inputs)


def all_ids(node):
    out = [node.id]
    for c in node.children:
        out += all_ids(c)
    return out


# ---- static ----------------------------------------------------------------------------

def test_module_qualified_function_is_an_op():
    r = static_root("QualifiedFn")
    assert names(r) == ["fc", "relu", "head"]
    assert edges(r) == [("$in", "fc", None, False), ("fc", "relu", None, False),
                        ("relu", "head", None, False), ("head", "$out", None, False)]


def test_indexed_container_call_is_a_module_call():
    r = static_root("IndexedBlocks")
    assert names(r) == ["blocks", "head"]
    assert [(a, b) for a, b, _, _ in edges(r)] == [("$in", "blocks"), ("blocks", "head"), ("head", "$out")]


def test_dict_return_keeps_the_flow():
    assert edges(static_root("DictReturn")) == [("$in", "fc", None, False), ("fc", "$out", None, False)]


def test_conditional_expression_submodule_is_a_module():
    r = static_root("CondModule")
    assert [(c.name, c.kind) for c in r.children] == [("norm", "module"), ("fc", "module")]
    assert [(a, b) for a, b, _, _ in edges(r)] == [("$in", "norm"), ("norm", "fc"), ("fc", "$out")]


def test_node_ids_are_unique_when_a_helper_runs_three_times():
    r = static_root("Embedder")
    ids = all_ids(r)
    assert len(ids) == len(set(ids)), ids
    assert names(r) == ["embed", "embed", "embed"]


def test_multiline_method_call_key_starts_at_the_attribute_name():
    # CPython starts such a call at the attribute name, not at the receiver
    tree = ast.parse("def f(x):\n    return (x\n        .view(2)\n        .mean(1))\n")
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)]
    assert sorted(call_key(c) for c in calls) == [(3, 9, 3, 16), (4, 9, 4, 16)]


# ---- traced ----------------------------------------------------------------------------

def test_helper_function_call_stays_connected():
    r = traced("HelperFn", {"x": [2, 4]}).root
    assert names(r) == ["fc", "swish", "head"]
    assert edges(r) == [("$in", "fc", [2, 4], False), ("fc", "swish", [2, 4], False),
                        ("swish", "head", [2, 4], False), ("head", "$out", [2, 2], False)]


def test_module_qualified_function_stays_connected():
    assert edges(traced("QualifiedFn", {"x": [2, 4]}).root) == [
        ("$in", "fc", [2, 4], False), ("fc", "relu", [2, 4], False),
        ("relu", "head", [2, 4], False), ("head", "$out", [2, 2], False)]


def test_indexed_container_calls_are_chained():
    r = traced("IndexedBlocks", {"x": [2, 4]}).root
    assert [(a, b, s) for a, b, s, _ in edges(r)] == [
        ("$in", "blocks", [2, 4]), ("blocks", "head", [2, 4]), ("head", "$out", [2, 2])]
    assert names(child(r, "blocks")) == ["0", "1"]


def test_dict_return_traced():
    r = traced("DictReturn", {"x": [2, 4]}).root
    assert [(a, b, s) for a, b, s, _ in edges(r)] == [("$in", "fc", [2, 4]), ("fc", "$out", [2, 2])]


def test_conditional_expression_submodule_traced():
    r = traced("CondModule", {"x": [2, 4]}).root
    assert child(r, "norm").type == "BatchNorm1d"
    assert [(a, b, s) for a, b, s, _ in edges(r)] == [
        ("$in", "norm", [2, 4]), ("norm", "fc", [2, 4]), ("fc", "$out", [2, 2])]


def test_node_ids_unique_when_a_helper_runs_three_times():
    ids = all_ids(traced("Embedder", {"a": [2, 4], "p": [2, 4], "n": [2, 4]}).root)
    assert len(ids) == len(set(ids)), ids


def test_group_input_shapes_follow_the_parameter_not_the_position():
    mix = child(traced("Mixer", {"x": [2, 4], "y": [2, 6]}).root, "mix")
    by_param = {e.out_index: e.shape for e in mix.edges if e.from_ == "$in"}
    assert by_param[2] == [2, 6]      # `b` received y
    assert by_param.get(1) is None    # `scale` received a literal, not a tensor


def test_multiline_method_chain_traced():
    r = traced("MultiLine", {"x": [2, 4]}).root
    assert [(a, b, s) for a, b, s, _ in edges(r)] == [
        ("$in", "fc", [2, 4]), ("fc", "view", [2, 4]), ("view", "mean", [2, 2, 2]),
        ("mean", "head", [2, 2]), ("head", "$out", [2, 2])]


def test_reused_module_with_changing_shapes_blanks_its_inner_shapes():
    r = traced("Reused", {"a": [2, 4], "b": [2, 6]}).root
    acts = [c for c in r.children if c.type == "Sequential"]
    assert len(acts) == 2 and acts[0].id != acts[1].id
    assert [(a, b, s) for a, b, s, _ in edges(r)] == [
        ("$in", "act", [2, 4]), ("$in", "act", [2, 6]), ("act", "$out", [2, 4]), ("act", "$out", [2, 6])]
    for act in acts:  # one set of numbers cannot be right for both calls
        assert all(s is None for _, _, s, _ in edges(act))


def test_unmatched_op_is_bridged_not_severed():
    path = str(FIXTURES / "simple_cnn.py")
    inputs = {"x": [2, 3, 16, 16]}
    r = trace(path, "SimpleCNN", {}, inputs, workspace_root=ROOT)
    r.calls = [c for c in r.calls if not (c.module_path == "" and c.kind == "op" and c.name == "view")]
    g = build_traced_graph(TemplateIndex(ROOT), r, path, "SimpleCNN", {}, inputs)
    assert edges(g.root) == [
        ("$in", "stem", [2, 3, 16, 16], False), ("stem", "blocks", [2, 8, 16, 16], False),
        ("blocks", "pool", [2, 8, 16, 16], False), ("pool", "fc", [2, 8], True),
        ("fc", "$out", [2, 10], False)]


# ---- command line ----------------------------------------------------------------------

def trace_request(fixture, entry):
    return {"command": "trace", "file": str(FIXTURES / fixture), "entry": entry,
            "workspaceRoot": ROOT, "ctorKwargs": {}, "inputs": {"x": [1, 4]}, "device": "auto"}


def test_exit_in_forward_falls_back_to_static():
    out = call(trace_request("exits.py", "Exits"))
    assert out["ok"] and out["graph"]["meta"]["mode"] == "static"
    assert out["graph"]["meta"]["traceError"].startswith("forward: ")


def test_exit_while_importing_falls_back_to_static():
    out = call(trace_request("exit_import.py", "ExitsOnImport"))
    assert out["ok"] and out["graph"]["meta"]["traceError"].startswith("import: ")


def test_output_written_by_a_child_process_does_not_corrupt_the_response():
    out = call(trace_request("fd_noise.py", "FdNoise"))
    assert out["graph"]["meta"]["mode"] == "traced"
