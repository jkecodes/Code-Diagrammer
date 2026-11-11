"""Combine the static templates with one trace into a traced Graph.

The module tree comes from the real instances; a class's forward flow comes
from its static template; only nodes that actually executed are kept.
"""
from __future__ import annotations

import os
from types import SimpleNamespace

from . import __version__
from .flow import FlowGraph
from .ir import Edge, Graph, Meta, Node, SourceRange
from .static_analysis import ClassTemplate, StaticError, TemplateIndex
from .tracing import CallRecord, ModuleInfo, TraceResult

IN, OUT = "$in", "$out"


def _at(values, index):
    return values[index] if values is not None and 0 <= index < len(values) else None


class _Builder:
    def __init__(self, index: TemplateIndex, result: TraceResult):
        self.index = index
        self.infos: dict[str, ModuleInfo] = {m.path: m for m in result.modules}
        self.children_of: dict[str, list[str]] = {}
        for m in result.modules:
            if m.path:
                parent = m.path.rsplit(".", 1)[0] if "." in m.path else ""
                self.children_of.setdefault(parent, []).append(m.path)
        self.records: dict[tuple, list[CallRecord]] = {}
        for c in result.calls:
            self.records.setdefault((c.module_path, c.key, c.kind), []).append(c)

    def template(self, info: ModuleInfo) -> ClassTemplate | None:
        if info.class_file is None:
            return None
        try:
            return self.index.get(info.class_file, info.type)
        except StaticError:
            return None

    # -- modules ---------------------------------------------------------------------

    def module(self, path: str, name: str, node_id: str, fallback_source: SourceRange | None = None,
               chain: list[str] | None = None, blank: bool = False) -> Node:
        info = self.infos[path]
        blank = blank or info.varies  # reused with changing shapes: inner numbers can't be right
        tpl = self.template(info)
        node = Node(id=node_id, name=name, kind="module", type=info.type, params=info.params,
                    trainable_params=info.trainable_params,
                    source=tpl.source if tpl else fallback_source)
        prefix = "" if node_id == "root" else node_id + "."
        if tpl is not None and tpl.flow is not None:
            used: set[str] = set()
            node.children, node.edges, _ = self.flow(tpl, tpl.flow, path, node_id, prefix, used, (),
                                                     blank)
            for child_path in self.children_of.get(path, []):
                attr = child_path.rsplit(".", 1)[-1]
                if attr not in used:
                    decl = tpl.decl(attr)
                    src = SourceRange(tpl.file, decl.line, decl.line) if decl else None
                    node.children.append(self.module(child_path, attr, prefix + attr, src,
                                                     blank=blank))
        elif chain is not None or info.type == "Sequential":
            members = chain if chain is not None else self.children_of.get(path, [])
            self._chain(node, members, prefix, fallback_source, blank)
        return node

    def _chain(self, node: Node, members: list[str], prefix: str,
               source: SourceRange | None, blank: bool = False) -> None:
        previous, previous_info = IN, None
        seen: dict[str, int] = {}
        for member in members:
            info = self.infos[member]
            attr = member.rsplit(".", 1)[-1]
            seen[attr] = seen.get(attr, 0) + 1
            child_id = prefix + attr + (f"#{seen[attr]}" if seen[attr] > 1 else "")
            node.children.append(self.module(member, attr, child_id, source, blank=blank))
            if previous is IN:
                shape, dtype = _at(info.in_shapes, 0), None
            else:
                shape, dtype = _at(previous_info.out_shapes, 0), _at(previous_info.out_dtypes, 0)
            if blank:
                shape = dtype = None
            node.edges.append(Edge(previous, child_id, 0, shape, dtype))
            previous, previous_info = child_id, info
        if previous_info is not None:
            shape, dtype = _at(previous_info.out_shapes, 0), _at(previous_info.out_dtypes, 0)
            if blank:
                shape = dtype = None
            node.edges.append(Edge(previous, OUT, 0, shape, dtype))

    # -- flows -----------------------------------------------------------------------

    def flow(self, tpl: ClassTemplate, flow: FlowGraph, path: str, parent_id: str, prefix: str,
             used: set[str], method_stack: tuple, blank: bool = False):
        """Returns (children, edges, outputs) where outputs = (shapes, dtypes) of `$out`."""
        info = self.infos[path]
        nodes: list[Node | None] = []
        outs: list[tuple] = []  # per flow node: (shapes, dtypes)
        for fn in flow.nodes:
            line, col, end_line, _ = fn.key
            site = f"{fn.name}@{line}:{col}"
            first_line, last_line = fn.span if fn.span != (0, 0) else (line, end_line)
            source = SourceRange(tpl.file, first_line, last_line)
            node, out = None, (None, None)
            if fn.kind == "module":
                node, out = self._module_call(tpl, fn, path, parent_id, prefix, site, used, blank)
            elif fn.kind == "group" and fn.target in tpl.methods:
                if fn.target not in method_stack:
                    group_id = f"{parent_id}/{site}"
                    children, edges, out = self.flow(
                        tpl, tpl.methods[fn.target], path, group_id, prefix, used,
                        method_stack + (fn.target,), blank)
                    if children:
                        node = Node(id=group_id, name=fn.name, kind="group", type=fn.name,
                                    source=source, children=children, edges=edges)
            else:
                recs = self.records.get((path, fn.key, "op"))
                if recs:
                    rec = recs[-1]
                    node = Node(id=f"{parent_id}/{site}", name=fn.name, kind="op", type=fn.name,
                                source=source, shape_only=fn.shape_only)
                    out = (rec.out_shapes, rec.out_dtypes)
            nodes.append(node)
            outs.append(out)

        # A module argument with several possible producers (a list of tensors, a branch):
        # keep only producers whose shape is one the module really received.
        ruled_out: set[int] = set()
        for i, fn in enumerate(flow.nodes):
            node = nodes[i]
            if node is None or fn.kind != "module":
                continue
            received = [s for s in (self._received(path, fn) or []) if s is not None]
            candidates = [(j, e) for j, e in enumerate(flow.edges)
                          if e.dst == i and e.uncertain and (e.src == IN or nodes[e.src] is not None)]
            shapes = {j: (_at(info.in_shapes, e.out_index) if e.src == IN
                          else _at(outs[e.src][0], e.out_index)) for j, e in candidates}
            if received and any(s in received for s in shapes.values()):
                ruled_out |= {j for j, s in shapes.items() if s not in received}

        edges: list[Edge] = []
        out_shapes: list = []
        out_dtypes: list = []
        incoming: dict[int, list[tuple]] = {}  # dst -> [(flow edge, ir edge)]
        has_in: set = set()

        def add(e, src_id, shape, dtype, uncertain=False):
            if blank:
                shape = dtype = None
            if e.dst == OUT:
                dst_id = OUT
                out_shapes.append(shape)
                out_dtypes.append(dtype)
            else:
                dst_id = nodes[e.dst].id
            edge = Edge(src_id, dst_id, e.out_index, shape, dtype, uncertain)
            edges.append(edge)
            has_in.add(e.dst)
            if e.dst != OUT:
                incoming.setdefault(e.dst, []).append((e, edge))

        for j, e in enumerate(flow.edges):
            if j in ruled_out:
                continue
            if e.src == IN:
                src_id, shape, dtype = IN, _at(info.in_shapes, e.out_index), None
                if method_stack:
                    shape = None  # a helper method's inputs are filled in by its caller
            else:
                if nodes[e.src] is None:
                    continue
                src_id = nodes[e.src].id
                shape, dtype = _at(outs[e.src][0], e.out_index), _at(outs[e.src][1], e.out_index)
            if e.dst != OUT and nodes[e.dst] is None:
                continue
            add(e, src_id, shape, dtype)

        # A node that did not run (or whose call was not matched) must not sever the flow:
        # reconnect its kept consumers to the kept producers behind it, as uncertain edges.
        def sources(dst, seen):
            for j, e in enumerate(flow.edges):
                if e.dst != dst or j in ruled_out:
                    continue
                if e.src == IN or nodes[e.src] is not None:
                    yield e
                elif e.src not in seen:
                    yield from sources(e.src, seen | {e.src})

        targets = [i for i, n in enumerate(nodes) if n is not None] + [OUT]
        for dst in targets:
            if dst in has_in:
                continue
            done: set = set()
            for e in sources(dst, set()):
                key = (e.src, e.out_index)
                if key in done:
                    continue
                done.add(key)
                if e.src == IN:
                    src_id, shape, dtype = IN, _at(info.in_shapes, e.out_index), None
                    if method_stack:
                        shape = None
                else:
                    src_id = nodes[e.src].id
                    shape, dtype = (_at(outs[e.src][0], e.out_index),
                                    _at(outs[e.src][1], e.out_index))
                add(SimpleNamespace(dst=dst, out_index=e.out_index, arg_pos=e.arg_pos),
                    src_id, shape, dtype, True)
        order = {n.id: k for k, n in enumerate(x for x in nodes if x is not None)}
        order[OUT] = len(order)
        edges.sort(key=lambda ed: order.get(ed.to, len(order)))  # stable: flow order per target
        # give each group's `$in` edges the shapes of the edges entering the group
        for i, node in enumerate(nodes):
            if node is not None and node.kind == "group":
                entering = incoming.get(i, [])
                for inner in node.edges:
                    if inner.from_ == IN:
                        match = next((ir for fe, ir in entering if fe.arg_pos == inner.out_index),
                                     None)
                        if match is not None:
                            inner.shape, inner.dtype = match.shape, match.dtype
        return [n for n in nodes if n is not None], edges, (out_shapes, out_dtypes)

    def _received(self, path: str, fn) -> list | None:
        """Input shapes of the module called at this flow node."""
        recs = self.records.get((path, fn.key, "module"))
        info = self.infos.get(recs[0].name) if recs else None
        return info.in_shapes if info else None

    def _module_call(self, tpl: ClassTemplate, fn, path: str, parent_id: str, prefix: str,
                     site: str, used: set[str], blank: bool = False):
        recs = self.records.get((path, fn.key, "module"))
        attr = fn.target
        child_path = f"{path}.{attr}" if path else attr
        if not recs or child_path not in self.infos:
            return None, (None, None)
        first = attr not in used
        used.add(attr)
        node_id = prefix + attr if first else f"{parent_id}/{site}"
        decl = tpl.decl(attr)
        source = SourceRange(tpl.file, decl.line, decl.line) if decl else None
        called = [r.name for r in recs]
        chain = None if all(c == child_path for c in called) else called
        node = self.module(child_path, attr, node_id, source, chain=chain, blank=blank)
        return node, (recs[-1].out_shapes, recs[-1].out_dtypes)


def build_traced_graph(index: TemplateIndex, result: TraceResult, file: str, entry: str,
                       ctor_kwargs: dict, inputs: dict) -> Graph:
    path = os.path.abspath(file)
    root = _Builder(index, result).module("", entry, "root")
    meta = Meta("traced", __version__, path, entry, ctor_kwargs=ctor_kwargs, inputs=inputs,
                device=result.device)
    return Graph(meta, root)
