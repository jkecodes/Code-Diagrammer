"""Stage 1: static analysis. Parses source with `ast`; never imports user code."""
from __future__ import annotations

import ast
import os
from dataclasses import dataclass, field

from . import __version__
from .flow import FlowGraph, build_flow, method_params
from .ir import Edge, Graph, Meta, Node, SourceRange

MODULE_BASES = {"nn.Module", "torch.nn.Module", "Module"}
CONTAINERS = {"Sequential", "ModuleList"}


class StaticError(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind  # "syntax" | "not-found"
        self.message = message


@dataclass
class SubmoduleDecl:
    attr: str
    type: str
    line: int
    class_ref: tuple[str, str] | None = None  # (file, class name) when in the workspace
    items: list["SubmoduleDecl"] = field(default_factory=list)
    repeated: bool = False


@dataclass
class ClassTemplate:
    file: str
    name: str
    source: SourceRange
    submodules: list[SubmoduleDecl]
    node: ast.ClassDef
    flow: FlowGraph | None = None  # data flow of `forward`; None when the class has no forward
    methods: dict[str, FlowGraph] = field(default_factory=dict)  # helper methods

    def decl(self, attr: str) -> SubmoduleDecl | None:
        return next((d for d in self.submodules if d.attr == attr), None)


def _dotted(expr: ast.AST) -> str | None:
    if isinstance(expr, ast.Name):
        return expr.id
    if isinstance(expr, ast.Attribute):
        head = _dotted(expr.value)
        return f"{head}.{expr.attr}" if head else None
    return None


def _walk_ordered(node: ast.AST):
    """Depth-first, source-order walk (ast.walk is breadth-first)."""
    yield node
    for c in ast.iter_child_nodes(node):
        yield from _walk_ordered(c)


def _self_attr(expr: ast.AST) -> str | None:
    """`self.<attr>` -> attr."""
    if (isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name)
            and expr.value.id == "self"):
        return expr.attr
    return None


def _method(cls: ast.ClassDef, name: str) -> ast.FunctionDef | None:
    for n in cls.body:
        if isinstance(n, ast.FunctionDef) and n.name == name:
            return n
    return None


def _is_builtin_nn(dotted: str) -> bool:
    return dotted.startswith("nn.") or dotted.startswith("torch.nn.")


class _FileInfo:
    def __init__(self, path: str, tree: ast.Module):
        self.path = path
        self.tree = tree
        self.classes: dict[str, ast.ClassDef] = {
            n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
        # local name -> (module, imported attr or None, relative level)
        self.imports: dict[str, tuple[str, str | None, int]] = {}
        for n in _walk_ordered(tree):
            if isinstance(n, ast.Import):
                for a in n.names:
                    if a.asname:
                        self.imports[a.asname] = (a.name, None, 0)
                    else:
                        self.imports[a.name.split(".")[0]] = (a.name.split(".")[0], None, 0)
            elif isinstance(n, ast.ImportFrom):
                for a in n.names:
                    self.imports[a.asname or a.name] = (n.module or "", a.name, n.level)


class TemplateIndex:
    """Parses workspace files on demand and caches class templates."""

    def __init__(self, workspace_root: str):
        self.root = os.path.abspath(workspace_root)
        self._files: dict[str, _FileInfo] = {}
        self._templates: dict[tuple[str, str], ClassTemplate | None] = {}

    # -- files and name resolution -------------------------------------------------

    def file_info(self, file: str) -> _FileInfo:
        path = os.path.abspath(file)
        if path not in self._files:
            try:
                with open(path, encoding="utf-8-sig") as f:  # a BOM is common on Windows
                    text = f.read()
            except OSError as e:
                raise StaticError("not-found", f"Cannot read {path}: {e.strerror}") from e
            except UnicodeDecodeError as e:
                raise StaticError("syntax", f"{os.path.basename(path)} is not UTF-8 text") from e
            try:
                tree = ast.parse(text, filename=path)
            except SyntaxError as e:
                raise StaticError("syntax", f"line {e.lineno}: {e.msg}") from e
            except ValueError as e:  # e.g. a NUL byte in the source
                raise StaticError("syntax", str(e)) from e
            self._files[path] = _FileInfo(path, tree)
        return self._files[path]

    def _find_module(self, from_file: str, module: str, level: int) -> str | None:
        parts = module.split(".") if module else []
        here = os.path.dirname(from_file)
        if level > 0:
            for _ in range(level - 1):
                here = os.path.dirname(here)
            bases = [here]
        else:
            bases = [here, self.root]
        for base in bases:
            p = os.path.join(base, *parts)
            if os.path.isfile(p + ".py"):
                return p + ".py"
            if parts and os.path.isfile(os.path.join(p, "__init__.py")):
                return os.path.join(p, "__init__.py")
        return None

    def _info_or_none(self, path: str | None) -> _FileInfo | None:
        if path is None:
            return None
        try:
            return self.file_info(path)
        except StaticError:
            return None

    def _resolve_name(self, info: _FileInfo, name: str, seen: set) -> tuple[str, str] | None:
        if (info.path, name) in seen:
            return None
        seen = seen | {(info.path, name)}
        if name in info.classes:
            return (info.path, name) if self._is_module_class(info, name, seen) else None
        if name in info.imports:
            module, attr, level = info.imports[name]
            if attr is None:
                return None  # a module object, not a class
            other = self._info_or_none(self._find_module(info.path, module, level))
            if other is not None:
                return self._resolve_name(other, attr, seen)
        return None

    def resolve(self, info: _FileInfo, expr: ast.AST, seen: set | None = None) -> tuple[str, str] | None:
        """Resolve a class reference expression to (file, class name) in the workspace."""
        dotted = _dotted(expr)
        if dotted is None:
            return None
        seen = seen or set()
        parts = dotted.split(".")
        if len(parts) == 1:
            return self._resolve_name(info, parts[0], seen)
        head, cls = ".".join(parts[:-1]), parts[-1]
        first = parts[0]
        if first in info.imports:
            module, attr, level = info.imports[first]
            target = module if attr is None else (f"{module}.{attr}" if module else attr)
            extra = parts[1:-1]
            if extra:
                target = ".".join([target, *extra])
            other = self._info_or_none(self._find_module(info.path, target, level))
            if other is not None:
                return self._resolve_name(other, cls, seen)
        del head
        return None

    def _is_module_class(self, info: _FileInfo, name: str, seen: set) -> bool:
        for base in info.classes[name].bases:
            d = _dotted(base)
            if d in MODULE_BASES or (d and _is_builtin_nn(d)):
                return True
            if self.resolve(info, base, seen) is not None:
                return True
        return False

    def is_module_class(self, info: _FileInfo, name: str) -> bool:
        return name in info.classes and self._is_module_class(info, name, {(info.path, name)})

    # -- templates -----------------------------------------------------------------

    def get(self, file: str, class_name: str) -> ClassTemplate | None:
        path = os.path.abspath(file)
        key = (path, class_name)
        if key not in self._templates:
            info = self.file_info(path)
            if not self.is_module_class(info, class_name):
                self._templates[key] = None
            else:
                cls = info.classes[class_name]
                self._templates[key] = self._build_template(info, cls)
        return self._templates[key]

    def _build_template(self, info: _FileInfo, cls: ast.ClassDef) -> ClassTemplate:
        tpl = ClassTemplate(
            file=info.path, name=cls.name,
            source=SourceRange(info.path, cls.lineno, cls.end_lineno or cls.lineno),
            submodules=self._collect_submodules(info, cls), node=cls)
        attrs = {d.attr for d in tpl.submodules}
        helpers = {n.name: n for n in cls.body if isinstance(n, ast.FunctionDef)
                   and n.name != "forward" and not n.name.startswith("__")}
        forward = _method(cls, "forward")
        if forward is not None:
            tpl.flow = build_flow(forward, attrs, {name: [a.arg for a in method_params(fn)]
                                                   for name, fn in helpers.items()})
        signatures = {name: [a.arg for a in method_params(fn)] for name, fn in helpers.items()}
        tpl.methods = {name: build_flow(fn, attrs, signatures) for name, fn in helpers.items()}
        return tpl

    def _collect_submodules(self, info: _FileInfo, cls: ast.ClassDef) -> list[SubmoduleDecl]:
        init = _method(cls, "__init__")
        if init is None:
            return []
        called: set[str] = set()
        for n in _walk_ordered(cls):
            if isinstance(n, ast.Call) and _self_attr(n.func):
                called.add(_self_attr(n.func))
            elif isinstance(n, (ast.For, ast.comprehension)) and _self_attr(n.iter):
                called.add(_self_attr(n.iter))
        out: list[SubmoduleDecl] = []
        seen: set[str] = set()
        for n in _walk_ordered(init):
            if isinstance(n, ast.Assign) and len(n.targets) == 1:
                target, value = n.targets[0], n.value
            elif isinstance(n, ast.AnnAssign) and n.value is not None:
                target, value = n.target, n.value
            else:
                continue
            attr = _self_attr(target)
            if attr is None or attr in seen:
                continue
            # `self.norm = nn.BatchNorm1d(4) if use_bn else nn.Identity()`: either call may build it
            calls = ([value.body, value.orelse] if isinstance(value, ast.IfExp) else [value])
            decl = None
            for call in calls:
                if isinstance(call, ast.Call):
                    decl = self._decl_from_builder(info, cls, attr, call) or self._decl(
                        info, attr, call, accept_unresolved=attr in called)
                    if decl is not None:
                        break
            if decl is not None:
                seen.add(attr)
                out.append(decl)
        return out

    def _decl_from_builder(self, info: _FileInfo, cls: ast.ClassDef, attr: str,
                           call: ast.Call) -> SubmoduleDecl | None:
        """`self.x = self.build_x(...)`: use the module that the helper method returns."""
        builder = _method(cls, _self_attr(call.func) or "")
        if builder is None:
            return None
        for n in _walk_ordered(builder):
            if isinstance(n, ast.Return) and isinstance(n.value, ast.Call):
                decl = self._decl(info, attr, n.value, accept_unresolved=False)
                if decl is not None:
                    decl.line = call.lineno
                    return decl
        return None

    def _decl(self, info: _FileInfo, attr: str, call: ast.Call,
              accept_unresolved: bool) -> SubmoduleDecl | None:
        dotted = _dotted(call.func)
        if dotted is None:
            return None
        short = dotted.split(".")[-1]
        builtin = _is_builtin_nn(dotted)
        ref = None if builtin else self.resolve(info, call.func)
        if not builtin and ref is None and not accept_unresolved:
            return None
        decl = SubmoduleDecl(attr, short, call.lineno, ref)
        if builtin and short in CONTAINERS:
            decl.items = self._items(info, call)
        return decl

    def _items(self, info: _FileInfo, call: ast.Call) -> list[SubmoduleDecl]:
        elts: list[ast.AST] = []
        for a in call.args:
            if isinstance(a, (ast.List, ast.Tuple)):
                elts.extend(a.elts)
            else:
                elts.append(a)
        items: list[SubmoduleDecl] = []
        for i, e in enumerate(elts):
            star = False
            if isinstance(e, ast.Starred):
                e, star = e.value, True
            if isinstance(e, (ast.ListComp, ast.GeneratorExp)):
                e, star = e.elt, True
            if not isinstance(e, ast.Call):
                continue
            d = self._decl(info, "*" if star else str(i), e, accept_unresolved=True)
            if d is not None:
                d.repeated = star
                items.append(d)
        return items


# -- graph construction ---------------------------------------------------------------

def _module_node(index: TemplateIndex, decl: SubmoduleDecl, decl_file: str, prefix: str,
                 stack: tuple, node_id: str | None = None) -> Node:
    node_id = node_id or prefix + decl.attr
    tpl = None
    if decl.class_ref is not None and decl.class_ref not in stack:
        tpl = index.get(*decl.class_ref)
    node = Node(id=node_id, name=decl.attr, kind="module", type=decl.type, repeated=decl.repeated,
                source=tpl.source if tpl else SourceRange(decl_file, decl.line, decl.line))
    if tpl is not None:
        _fill_from_template(index, node, tpl, node_id + ".", stack + (decl.class_ref,))
    else:
        node.children = [_module_node(index, d, decl_file, node_id + ".", stack)
                         for d in decl.items]
    return node


def _fill_from_template(index: TemplateIndex, node: Node, tpl: ClassTemplate, prefix: str,
                        stack: tuple) -> None:
    """Children and edges of a module instance: its forward flow, then uncalled submodules."""
    used: set[str] = set()
    if tpl.flow is not None:
        node.children, node.edges = _instantiate_flow(
            index, tpl, tpl.flow, node.id, prefix, stack, used, ())
    for d in tpl.submodules:
        if d.attr not in used:
            node.children.append(_module_node(index, d, tpl.file, prefix, stack))


def _instantiate_flow(index: TemplateIndex, tpl: ClassTemplate, flow: FlowGraph, parent_id: str,
                      prefix: str, stack: tuple, used: set[str],
                      method_stack: tuple) -> tuple[list[Node], list[Edge]]:
    ids: list[str] = []
    children: list[Node] = []
    for fn in flow.nodes:
        line, col, _, _ = fn.key
        site = f"{fn.name}@{line}:{col}"
        source = SourceRange(tpl.file, fn.span[0], fn.span[1])
        decl = tpl.decl(fn.target) if fn.kind == "module" else None
        if decl is not None:
            first = decl.attr not in used
            used.add(decl.attr)
            # later call sites are named after their enclosing node, so every id stays unique
            node = _module_node(index, decl, tpl.file, prefix, stack,
                                node_id=None if first else f"{parent_id}/{site}")
        elif fn.kind == "group" and fn.target in tpl.methods:
            node = Node(id=f"{parent_id}/{site}", name=fn.name, kind="group", type=fn.name,
                        source=source)
            if fn.target not in method_stack:
                node.children, node.edges = _instantiate_flow(
                    index, tpl, tpl.methods[fn.target], node.id, prefix, stack, used,
                    method_stack + (fn.target,))
        else:
            node = Node(id=f"{parent_id}/{site}", name=fn.name, kind="op", type=fn.name,
                        source=source, shape_only=fn.shape_only)
        ids.append(node.id)
        children.append(node)
    edges = [Edge(e.src if isinstance(e.src, str) else ids[e.src],
                  e.dst if isinstance(e.dst, str) else ids[e.dst],
                  e.out_index, uncertain=e.uncertain) for e in flow.edges]
    return children, edges


def build_static_graph(index: TemplateIndex, file: str, entry: str) -> Graph:
    path = os.path.abspath(file)
    tpl = index.get(path, entry)
    if tpl is None:
        raise StaticError("not-found", f"No nn.Module class named '{entry}' in {path}")
    root = Node(id="root", name=entry, kind="module", type=entry, source=tpl.source)
    _fill_from_template(index, root, tpl, "", ((path, entry),))
    return Graph(Meta("static", __version__, path, entry), root)


# -- class listing --------------------------------------------------------------------

def _params(fn: ast.FunctionDef | None) -> list[dict]:
    if fn is None:
        return []
    a = fn.args
    positional = [*a.posonlyargs, *a.args][1:]  # drop self
    n_default = len(a.defaults)
    out = []
    for i, arg in enumerate(positional):
        has_default = i >= len(positional) - n_default
        out.append({"name": arg.arg, "hasDefault": has_default})
    for arg, default in zip(a.kwonlyargs, a.kw_defaults):
        out.append({"name": arg.arg, "hasDefault": default is not None})
    return out


def list_classes(file: str) -> list[dict]:
    path = os.path.abspath(file)
    index = TemplateIndex(os.path.dirname(path))
    info = index.file_info(path)
    module_classes = [n for n in info.classes if index.is_module_class(info, n)]
    out = []
    for name in module_classes:
        cls = info.classes[name]
        used_elsewhere = any(
            isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == name
            for other in module_classes if other != name
            for n in ast.walk(info.classes[other]))
        out.append({
            "name": name, "line": cls.lineno, "topLevel": not used_elsewhere,
            "initParams": _params(_method(cls, "__init__")),
            "forwardParams": _params(_method(cls, "forward")),
        })
    return out
