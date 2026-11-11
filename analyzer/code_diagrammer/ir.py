"""Intermediate representation: a tree of nodes with data-flow edges.

Python fields are snake_case; the JSON form uses the keys documented in the
plan's Shared Definitions (camelCase).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

IN = "$in"
OUT = "$out"


@dataclass
class SourceRange:
    file: str
    start_line: int
    end_line: int

    @property
    def startLine(self) -> int:  # noqa: N802 - mirrors the JSON key
        return self.start_line

    @property
    def endLine(self) -> int:  # noqa: N802
        return self.end_line

    def to_dict(self) -> dict:
        return {"file": self.file, "startLine": self.start_line, "endLine": self.end_line}

    @staticmethod
    def from_dict(d: dict | None) -> "SourceRange | None":
        if d is None:
            return None
        return SourceRange(d["file"], d["startLine"], d["endLine"])


@dataclass
class Edge:
    from_: str
    to: str
    out_index: int = 0
    shape: list[int] | None = None
    dtype: str | None = None
    uncertain: bool = False

    def to_dict(self) -> dict:
        return {"from": self.from_, "to": self.to, "outIndex": self.out_index,
                "shape": self.shape, "dtype": self.dtype, "uncertain": self.uncertain}

    @staticmethod
    def from_dict(d: dict) -> "Edge":
        return Edge(d["from"], d["to"], d["outIndex"], d["shape"], d["dtype"], d["uncertain"])


@dataclass
class Node:
    id: str
    name: str
    kind: str  # "module" | "op" | "group"
    type: str
    source: SourceRange | None = None
    params: int | None = None  # all parameters, including frozen ones
    trainable_params: int | None = None  # parameters with requires_grad=True
    shape_only: bool = False
    repeated: bool = False
    children: list["Node"] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)

    @property
    def shapeOnly(self) -> bool:  # noqa: N802
        return self.shape_only

    def to_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name, "kind": self.kind, "type": self.type,
            "source": self.source.to_dict() if self.source else None,
            "params": self.params, "trainableParams": self.trainable_params,
            "shapeOnly": self.shape_only, "repeated": self.repeated,
            "children": [c.to_dict() for c in self.children],
            "edges": [e.to_dict() for e in self.edges],
        }

    @staticmethod
    def from_dict(d: dict) -> "Node":
        return Node(
            id=d["id"], name=d["name"], kind=d["kind"], type=d["type"],
            source=SourceRange.from_dict(d["source"]), params=d["params"],
            trainable_params=d.get("trainableParams"),
            shape_only=d["shapeOnly"], repeated=d["repeated"],
            children=[Node.from_dict(c) for c in d["children"]],
            edges=[Edge.from_dict(e) for e in d["edges"]],
        )


@dataclass
class Meta:
    mode: str  # "static" | "traced"
    analyzer_version: str
    entry_file: str
    entry_class: str
    ctor_kwargs: dict[str, Any] | None = None
    inputs: dict[str, Any] | None = None
    device: str | None = None
    trace_error: str | None = None

    def to_dict(self) -> dict:
        return {
            "mode": self.mode, "analyzerVersion": self.analyzer_version,
            "entry": {"file": self.entry_file, "className": self.entry_class},
            "ctorKwargs": self.ctor_kwargs, "inputs": self.inputs,
            "device": self.device, "traceError": self.trace_error,
        }

    @staticmethod
    def from_dict(d: dict) -> "Meta":
        return Meta(d["mode"], d["analyzerVersion"], d["entry"]["file"], d["entry"]["className"],
                    d["ctorKwargs"], d["inputs"], d["device"], d["traceError"])


@dataclass
class Graph:
    meta: Meta
    root: Node

    def to_dict(self) -> dict:
        return {"version": 1, "meta": self.meta.to_dict(), "root": self.root.to_dict()}

    @staticmethod
    def from_dict(d: dict) -> "Graph":
        return Graph(Meta.from_dict(d["meta"]), Node.from_dict(d["root"]))
