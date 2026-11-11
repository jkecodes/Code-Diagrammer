from code_diagrammer.ir import Graph, Meta, Node, Edge, SourceRange


def test_round_trip_uses_json_keys():
    leaf = Node(id="fc", name="fc", kind="module", type="Linear",
                source=SourceRange("m.py", 3, 3), params=90)
    root = Node(id="root", name="Net", kind="module", type="Net", children=[leaf],
                edges=[Edge("$in", "fc"), Edge("fc", "$out", shape=[2, 10], dtype="float32")])
    g = Graph(Meta("traced", "0.1.0", "m.py", "Net", device="meta"), root)
    d = g.to_dict()
    assert d["version"] == 1
    assert d["meta"] == {"mode": "traced", "analyzerVersion": "0.1.0",
                         "entry": {"file": "m.py", "className": "Net"},
                         "ctorKwargs": None, "inputs": None, "device": "meta", "traceError": None}
    assert d["root"]["children"][0]["source"] == {"file": "m.py", "startLine": 3, "endLine": 3}
    assert d["root"]["children"][0]["shapeOnly"] is False
    assert d["root"]["edges"][1] == {"from": "fc", "to": "$out", "outIndex": 0,
                                     "shape": [2, 10], "dtype": "float32", "uncertain": False}
    assert Graph.from_dict(d).to_dict() == d
