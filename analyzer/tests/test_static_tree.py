import pytest
from conftest import FIXTURES, child, names
from code_diagrammer.static_analysis import (
    TemplateIndex, build_static_graph, list_classes, StaticError)

CNN = str(FIXTURES / "simple_cnn.py")


def line_of(path, text):
    return next(i for i, l in enumerate(open(path, encoding="utf-8"), 1) if text in l)


def test_list_classes():
    got = list_classes(CNN)
    assert [(c["name"], c["topLevel"]) for c in got] == [("Block", False), ("SimpleCNN", True)]
    assert got[1]["initParams"] == [{"name": "n_blocks", "hasDefault": True}]
    assert got[1]["forwardParams"] == [{"name": "x", "hasDefault": False},
                                       {"name": "flag", "hasDefault": True}]


def test_module_tree():
    g = build_static_graph(TemplateIndex(str(FIXTURES)), CNN, "SimpleCNN")
    root = g.root
    assert (root.id, root.type, g.meta.mode) == ("root", "SimpleCNN", "static")
    mods = [c for c in root.children if c.kind == "module"]
    assert [(m.name, m.type) for m in mods] == [
        ("stem", "Sequential"), ("blocks", "Sequential"), ("fc", "Linear")]
    stem = child(root, "stem")
    assert [(c.id, c.type) for c in stem.children] == [("stem.0", "Conv2d"), ("stem.1", "ReLU")]
    star = child(root, "blocks").children[0]
    assert (star.name, star.type, star.repeated) == ("*", "Block", True)
    assert [c.name for c in star.children if c.kind == "module"] == ["conv", "bn"]
    assert star.source.startLine == line_of(CNN, "class Block")
    assert child(root, "fc").source.startLine == line_of(CNN, "self.fc =")
    assert root.params is None


def test_cross_file_relative_import():
    model = str(FIXTURES / "pkg" / "model.py")
    g = build_static_graph(TemplateIndex(str(FIXTURES)), model, "Wrapper")
    scale = child(g.root, "scale")
    assert scale.type == "Scale" and scale.source.file.endswith("layers.py")


def test_unknown_entry():
    with pytest.raises(StaticError) as e:
        build_static_graph(TemplateIndex(str(FIXTURES)), CNN, "Nope")
    assert e.value.kind == "not-found"
