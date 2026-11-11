from conftest import FIXTURES, child, names, edges
from code_diagrammer.static_analysis import TemplateIndex, build_static_graph


def graph():
    return build_static_graph(TemplateIndex(str(FIXTURES)),
                              str(FIXTURES / "simple_cnn.py"), "SimpleCNN")


def test_top_level_flow():
    root = graph().root
    assert names(root) == ["stem", "blocks", "mul", "pool", "view", "fc"]
    assert [c.kind for c in root.children] == ["module", "module", "op", "group", "op", "module"]
    assert child(root, "view").shapeOnly is True and child(root, "mul").shapeOnly is False
    assert edges(root) == [
        ("$in", "stem", None, False), ("stem", "blocks", None, False),
        ("blocks", "mul", None, True), ("blocks", "pool", None, True),
        ("mul", "pool", None, True), ("pool", "view", None, False),
        ("view", "fc", None, False), ("fc", "$out", None, False)]


def test_block_flow_has_residual():
    block = child(graph().root, "blocks").children[0]
    assert names(block) == ["conv", "bn", "relu", "add"]
    assert edges(block) == [
        ("$in", "conv", None, False), ("conv", "bn", None, False), ("bn", "relu", None, False),
        ("relu", "add", None, False), ("$in", "add", None, False), ("add", "$out", None, False)]


def test_helper_method_is_group():
    pool = child(graph().root, "pool")
    assert pool.kind == "group" and names(pool) == ["mean"]
    assert edges(pool) == [("$in", "mean", None, False), ("mean", "$out", None, False)]
    assert pool.id.startswith("root/pool@")


def test_non_tensor_values_make_no_nodes():
    # `v.shape[0]` and `flag` produce no nodes
    assert "getitem" not in names(graph().root)
