from conftest import FIXTURES, child, names, edges
from code_diagrammer.static_analysis import TemplateIndex
from code_diagrammer.tracing import trace
from code_diagrammer.merge import build_traced_graph

ROOT = str(FIXTURES)


def traced(fixture, entry, inputs, kwargs=None):
    path = str(FIXTURES / fixture)
    r = trace(path, entry, kwargs or {}, inputs, workspace_root=ROOT)
    return build_traced_graph(TemplateIndex(ROOT), r, path, entry, kwargs or {}, inputs)


def test_shapes_and_dropped_branch():
    g = traced("simple_cnn.py", "SimpleCNN", {"x": [2, 3, 16, 16]})
    root = g.root
    assert (g.meta.mode, g.meta.device, root.params) == ("traced", "meta", 1322)
    assert names(root) == ["stem", "blocks", "pool", "view", "fc"]
    assert edges(root) == [
        ("$in", "stem", [2, 3, 16, 16], False), ("stem", "blocks", [2, 8, 16, 16], False),
        ("blocks", "pool", [2, 8, 16, 16], False), ("pool", "view", [2, 8], False),
        ("view", "fc", [2, 8], False), ("fc", "$out", [2, 10], False)]


def test_repeated_placeholder_becomes_real_children():
    blocks = child(traced("simple_cnn.py", "SimpleCNN", {"x": [2, 3, 16, 16]}).root, "blocks")
    assert [(c.id, c.type, c.repeated, c.params) for c in blocks.children] == [
        ("blocks.0", "Block", False, 600), ("blocks.1", "Block", False, 600)]
    assert edges(blocks) == [("$in", "0", [2, 8, 16, 16], False), ("0", "1", [2, 8, 16, 16], False),
                             ("1", "$out", [2, 8, 16, 16], False)]
    assert ("relu", "add", [2, 8, 16, 16], False) in edges(blocks.children[0])


def test_taken_branch_is_kept():
    g = traced("simple_cnn.py", "SimpleCNN", {"x": [2, 3, 16, 16], "flag": {"value": True}})
    assert names(g.root) == ["stem", "blocks", "mul", "pool", "view", "fc"]
    assert ("mul", "pool", [2, 8, 16, 16], False) in edges(g.root)


def test_loop_over_modulelist():
    layers = child(traced("loop_net.py", "LoopNet", {"x": [2, 4]}).root, "layers")
    assert names(layers) == ["0", "1", "2"]
    assert edges(layers) == [("$in", "0", [2, 4], False), ("0", "1", [2, 4], False),
                             ("1", "2", [2, 4], False), ("2", "$out", [2, 4], False)]


def test_group_input_edge_gets_shape():
    pool = child(traced("simple_cnn.py", "SimpleCNN", {"x": [2, 3, 16, 16]}).root, "pool")
    assert edges(pool) == [("$in", "mean", [2, 8, 16, 16], False), ("mean", "$out", [2, 8], False)]
