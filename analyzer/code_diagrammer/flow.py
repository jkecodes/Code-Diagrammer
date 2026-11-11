"""Data-flow analysis of one method body (forward or a helper), from the AST only.

Walks statements in order and tracks, for each variable, which nodes may have
produced it. Produces a FlowGraph of module-call / op / group nodes and edges.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field

SHAPE_ONLY = {"view", "reshape", "permute", "transpose", "contiguous", "squeeze", "unsqueeze",
              "flatten", "unflatten", "expand", "movedim"}

BINOPS = {ast.Add: "add", ast.Sub: "sub", ast.Mult: "mul", ast.Div: "div",
          ast.FloorDiv: "floordiv", ast.Mod: "mod", ast.Pow: "pow", ast.MatMult: "matmul"}

IN = "$in"
OUT = "$out"

Key = tuple[int, int, int, int]
Value = tuple[object, int]  # (node index or "$in", output index)


@dataclass
class FlowNode:
    key: Key  # lineno, col_offset, end_lineno, end_col_offset of the AST expression
    kind: str  # "module" | "op" | "group"
    name: str
    target: str | None  # submodule attr (module) or method name (group)
    shape_only: bool
    conditional: bool
    span: tuple[int, int] = (0, 0)  # first and last source line of the expression


@dataclass
class FlowEdge:
    src: object  # node index or "$in"
    dst: object  # node index or "$out"
    out_index: int  # which output of `src` is used
    uncertain: bool
    arg_pos: int | None = None  # for edges into a helper-method call: which parameter receives it


@dataclass
class FlowGraph:
    params: list[str]
    nodes: list[FlowNode] = field(default_factory=list)
    edges: list[FlowEdge] = field(default_factory=list)


def call_key(call: ast.Call) -> Key:
    """The position CPython reports for this call's CALL instruction.

    A method call whose receiver and attribute name are on different lines (a multi-line chain)
    starts at the attribute name, not at the receiver.
    """
    f = call.func
    if isinstance(f, ast.Attribute) and f.value.end_lineno != f.end_lineno:
        return (f.end_lineno, f.end_col_offset - len(f.attr), call.end_lineno, call.end_col_offset)
    return (call.lineno, call.col_offset, call.end_lineno, call.end_col_offset)


def _key(n: ast.AST) -> Key:
    if isinstance(n, ast.Call):
        return call_key(n)
    return (n.lineno, n.col_offset, n.end_lineno, n.end_col_offset)


def _self_attr(expr: ast.AST) -> str | None:
    if (isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name)
            and expr.value.id == "self"):
        return expr.attr
    return None


def _dotted(expr: ast.AST) -> str | None:
    if isinstance(expr, ast.Name):
        return expr.id
    if isinstance(expr, ast.Attribute):
        head = _dotted(expr.value)
        return f"{head}.{expr.attr}" if head else None
    return None


def _sort_values(values: list[Value]) -> list[Value]:
    uniq = list(dict.fromkeys(values))
    return sorted(uniq, key=lambda v: (-1 if v[0] == IN else v[0], v[1]))


def _is_static(fn: ast.FunctionDef) -> bool:
    return any(isinstance(d, ast.Name) and d.id == "staticmethod" for d in fn.decorator_list)


def method_params(fn: ast.FunctionDef) -> list[ast.arg]:
    args = [*fn.args.posonlyargs, *fn.args.args]
    if not _is_static(fn):
        args = args[1:]
    return [*args, *fn.args.kwonlyargs]


class FlowBuilder:
    def __init__(self, fn: ast.FunctionDef, submodules: set[str], methods: dict[str, list[str]]):
        self.submodules = submodules
        self.methods = methods  # helper method name -> its parameter names (without self)
        self.alias: dict[str, str] = {}  # local variable -> submodule attr
        self.lists: set[str] = set()  # local variables holding a Python list of tensors
        params = method_params(fn)
        self.graph = FlowGraph(params=[a.arg for a in params])
        self.env: dict[str, list[Value]] = {}
        positional = [*fn.args.posonlyargs, *fn.args.args]
        defaults = dict(zip([a.arg for a in positional[len(positional) - len(fn.args.defaults):]],
                            fn.args.defaults))
        defaults.update({a.arg: d for a, d in zip(fn.args.kwonlyargs, fn.args.kw_defaults)
                         if d is not None})
        for i, a in enumerate(params):
            d = defaults.get(a.arg)
            scalar_default = isinstance(d, ast.Constant) and d.value is not None
            if not scalar_default:
                self.env[a.arg] = [(IN, i)]
        self._block(fn.body, False)

    # -- nodes and edges -------------------------------------------------------------

    def _connect(self, dst: object, cond: bool, groups: list[list[Value]],
                 positions: list[int | None] | None = None) -> None:
        """`groups` holds one value list per operand; several producers for one operand = uncertain."""
        seen = set()
        for gi, values in enumerate(groups):
            multi = len(values) > 1
            pos = positions[gi] if positions is not None else None
            for src, out_index in values:
                if (src, out_index, pos) in seen:
                    continue
                seen.add((src, out_index, pos))
                src_cond = src != IN and self.graph.nodes[src].conditional
                self.graph.edges.append(
                    FlowEdge(src, dst, out_index, cond or multi or src_cond, pos))

    def _make(self, expr, kind, name, target, operand_groups: list[list[Value]], cond,
              positions: list[int | None] | None = None) -> list[Value]:
        idx = len(self.graph.nodes)
        self.graph.nodes.append(FlowNode(_key(expr), kind, name, target,
                                         kind == "op" and name in SHAPE_ONLY, cond,
                                         (expr.lineno, expr.end_lineno)))
        self._connect(idx, cond, operand_groups, positions)
        return [(idx, 0)]

    # -- expressions -----------------------------------------------------------------

    def _args(self, call: ast.Call, cond: bool) -> list[list[Value]]:
        groups = [self._eval(a, cond) for a in call.args]
        groups += [self._eval(k.value, cond) for k in call.keywords]
        return [g for g in groups if g]

    def _args_with_positions(self, call: ast.Call, cond: bool, params: list[str]):
        """Like `_args`, but also says which parameter of the callee each operand feeds."""
        groups: list[list[Value]] = []
        positions: list[int | None] = []
        for i, a in enumerate(call.args):
            values = self._eval(a, cond)
            if values:
                groups.append(values)
                positions.append(i)
        for k in call.keywords:
            values = self._eval(k.value, cond)
            if values:
                groups.append(values)
                positions.append(params.index(k.arg) if k.arg in params else None)
        return groups, positions

    def _is_function_path(self, dotted: str) -> bool:
        """`nn.functional.relu`, `einops.rearrange`: a dotted name that is not a local value."""
        head = dotted.split(".")[0]
        return (head != "self" and head not in self.env and head not in self.alias
                and head not in self.lists)

    def _eval(self, e: ast.AST, cond: bool) -> list[Value]:
        if isinstance(e, ast.Name):
            return list(self.env.get(e.id, []))
        if isinstance(e, ast.Call):
            return self._call(e, cond)
        if isinstance(e, ast.BinOp):
            left, right = self._eval(e.left, cond), self._eval(e.right, cond)
            if not left and not right:
                return []
            name = BINOPS.get(type(e.op))
            if name is None:
                return _sort_values(left + right)
            return self._make(e, "op", name, None, [g for g in (left, right) if g], cond)
        if isinstance(e, ast.UnaryOp):
            operand = self._eval(e.operand, cond)
            if operand and isinstance(e.op, ast.USub):
                return self._make(e, "op", "neg", None, [operand], cond)
            return operand if isinstance(e.op, ast.UAdd) else []
        if isinstance(e, ast.Subscript):
            value = self._eval(e.value, cond)
            index = self._eval(e.slice, cond)
            if not value:
                return []
            if isinstance(e.value, ast.Name) and e.value.id in self.lists:
                return value  # picking an element of a list of tensors is not an op
            # constant index into a module/group result selects one of its outputs
            if (len(value) == 1 and value[0][0] != IN and value[0][1] == 0
                    and self.graph.nodes[value[0][0]].kind in ("module", "group")
                    and isinstance(e.slice, ast.Constant) and isinstance(e.slice.value, int)
                    and e.slice.value >= 0):
                return [(value[0][0], e.slice.value)]
            return self._make(e, "op", "getitem", None, [g for g in (value, index) if g], cond)
        if isinstance(e, (ast.Tuple, ast.List, ast.Set)):
            out: list[Value] = []
            for elt in e.elts:
                out += self._eval(elt, cond)
            return _sort_values(out)
        if isinstance(e, ast.Starred):
            return self._eval(e.value, cond)
        if isinstance(e, ast.Dict):
            out = []
            for key, value in zip(e.keys, e.values):
                if key is not None:
                    self._eval(key, cond)
                out += self._eval(value, cond)
            return _sort_values(out)
        if isinstance(e, ast.IfExp):
            self._eval(e.test, cond)
            return _sort_values(self._eval(e.body, True) + self._eval(e.orelse, True))
        if isinstance(e, ast.NamedExpr):
            values = self._eval(e.value, cond)
            self._assign(e.target, values, e.value, cond)
            return values
        if isinstance(e, (ast.Compare, ast.BoolOp)):
            for c in ast.iter_child_nodes(e):
                if isinstance(c, ast.expr):
                    self._eval(c, cond)
            return []
        if isinstance(e, ast.Slice):
            out = []
            for part in (e.lower, e.upper, e.step):
                if part is not None:
                    out += self._eval(part, cond)
            return _sort_values(out)
        if isinstance(e, ast.Attribute):
            self._eval(e.value, cond)  # e.g. `self.enc(x).shape`: keep the call's node
            return []
        if isinstance(e, (ast.ListComp, ast.GeneratorExp, ast.SetComp)):
            for gen in e.generators:
                self._eval(gen.iter, cond)
                self._bind_loop(gen.target, gen.iter)
            return self._eval(e.elt, True)
        return []

    def _call(self, e: ast.Call, cond: bool) -> list[Value]:
        func = e.func
        attr = _self_attr(func)
        # loop variable bound to a container: `for layer in self.layers: layer(x)`
        if isinstance(func, ast.Name) and func.id in self.alias:
            return self._make(e, "module", self.alias[func.id], self.alias[func.id],
                              self._args(e, cond), cond)
        # `self.blocks[i](x)`: some member of a container submodule is called
        if isinstance(func, ast.Subscript) and _self_attr(func.value) in self.submodules:
            container = _self_attr(func.value)
            self._eval(func.slice, cond)
            return self._make(e, "module", container, container, self._args(e, cond), cond)
        if attr is not None:
            if attr in self.methods:
                groups, positions = self._args_with_positions(e, cond, self.methods[attr])
                return self._make(e, "group", attr, attr, groups, cond, positions)
            groups = self._args(e, cond)
            if attr in self.submodules:
                return self._make(e, "module", attr, attr, groups, cond)
            return self._make(e, "op", attr, None, groups, cond) if groups else []
        dotted = _dotted(func)
        if dotted and "." in dotted and self._is_function_path(dotted):
            groups = self._args(e, cond)
            return self._make(e, "op", dotted.split(".")[-1], None, groups, cond) if groups else []
        if (isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name)
                and func.value.id in self.lists):
            added: list[Value] = []
            for group in self._args(e, cond):
                added += group
            if func.attr in ("append", "extend", "insert"):
                self.env[func.value.id] = _sort_values(self.env.get(func.value.id, []) + added)
            return []
        if isinstance(func, ast.Attribute):
            receiver = self._eval(func.value, cond)
            groups = self._args(e, cond)
            if receiver:
                return self._make(e, "op", func.attr, None, [receiver, *groups], cond)
            return []
        if isinstance(func, ast.Name):
            groups = self._args(e, cond)
            if groups and func.id not in _NON_TENSOR_BUILTINS:
                return self._make(e, "op", func.id, None, groups, cond)
            return []
        self._args(e, cond)
        return []

    # -- statements ------------------------------------------------------------------

    def _assign(self, target: ast.AST, values: list[Value], value_expr: ast.AST | None,
                cond: bool) -> None:
        if isinstance(target, ast.Name):
            if values:
                self.env[target.id] = values
            else:
                self.env.pop(target.id, None)
                self.alias.pop(target.id, None)
        elif isinstance(target, (ast.Tuple, ast.List)):
            single = len(values) == 1 and values[0][0] != IN and values[0][1] == 0
            for i, elt in enumerate(target.elts):
                if isinstance(elt, ast.Starred):
                    elt = elt.value
                if single:
                    self._assign(elt, [(values[0][0], i)], None, cond)
                else:
                    self._assign(elt, [], None, cond)

    def _stmt(self, s: ast.stmt, cond: bool) -> bool:
        """Execute one statement. Returns True if it ends the block (return/raise/...)."""
        if isinstance(s, ast.Assign):
            if (isinstance(s.value, ast.Tuple) and len(s.targets) == 1
                    and isinstance(s.targets[0], ast.Tuple)
                    and len(s.targets[0].elts) == len(s.value.elts)):
                evaluated = [self._eval(v, cond) for v in s.value.elts]
                for t, v in zip(s.targets[0].elts, evaluated):
                    self._assign(t, v, None, cond)
            elif _self_attr(s.value) in self.submodules and all(
                    isinstance(t, ast.Name) for t in s.targets):
                for t in s.targets:  # `m = self.block`: m(...) now calls that submodule
                    self.env.pop(t.id, None)
                    self.alias[t.id] = _self_attr(s.value)
            else:
                values = self._eval(s.value, cond)
                is_list = isinstance(s.value, (ast.List, ast.ListComp))
                for t in s.targets:
                    self._assign(t, values, s.value, cond)
                    if isinstance(t, ast.Name):
                        if is_list:
                            self.lists.add(t.id)
                            self.env[t.id] = values
                        else:
                            self.lists.discard(t.id)
        elif isinstance(s, ast.AnnAssign):
            if s.value is not None:
                self._assign(s.target, self._eval(s.value, cond), s.value, cond)
        elif isinstance(s, ast.AugAssign):
            left = self._eval(s.target, cond) if isinstance(s.target, ast.Name) else []
            right = self._eval(s.value, cond)
            name = BINOPS.get(type(s.op))
            if isinstance(s.target, ast.Name) and s.target.id in self.lists:
                self.env[s.target.id] = _sort_values(left + right)  # list += [more tensors]
            elif (left or right) and name:
                values = self._make(s, "op", name, None, [g for g in (left, right) if g], cond)
                self._assign(s.target, values, None, cond)
        elif isinstance(s, ast.Expr):
            self._eval(s.value, cond)
        elif isinstance(s, ast.Return):
            if s.value is not None:
                elts = s.value.elts if isinstance(s.value, ast.Tuple) else [s.value]
                groups = [g for g in (self._eval(x, cond) for x in elts) if g]
                self._connect(OUT, cond, groups)
            return True
        elif isinstance(s, (ast.Raise, ast.Continue, ast.Break)):
            return True
        elif isinstance(s, ast.If):
            self._eval(s.test, cond)
            self._branches([s.body, s.orelse])
        elif isinstance(s, (ast.For, ast.AsyncFor)):
            self._eval(s.iter, cond)
            self._bind_loop(s.target, s.iter)
            self._block(s.body, True)
        elif isinstance(s, ast.While):
            self._eval(s.test, cond)
            self._block(s.body, True)
        elif isinstance(s, (ast.With, ast.AsyncWith)):
            for item in s.items:
                self._eval(item.context_expr, cond)
            return self._block(s.body, cond)
        elif isinstance(s, ast.Try):
            self._branches([s.body + s.orelse, *[h.body for h in s.handlers]])
            self._block(s.finalbody, cond)
        return False

    def _block(self, body: list[ast.stmt], cond: bool) -> bool:
        for s in body:
            if self._stmt(s, cond):
                return True
        return False

    def _branches(self, bodies: list[list[ast.stmt]]) -> None:
        """Run alternative blocks from the same starting env; merge those that fall through."""
        start_env, start_alias = dict(self.env), dict(self.alias)
        surviving: list[dict[str, list[Value]]] = []
        for body in bodies:
            self.env, self.alias = dict(start_env), dict(start_alias)
            if not self._block(body, True):
                surviving.append(self.env)
        self.alias = start_alias
        if not surviving:
            self.env = start_env
            return
        merged: dict[str, list[Value]] = {}
        for env in surviving:
            for name, values in env.items():
                merged[name] = _sort_values(merged.get(name, []) + values)
        self.env = merged

    def _bind_loop(self, target: ast.AST, it: ast.AST) -> None:
        sources: list[ast.AST] = [it]
        targets: list[ast.AST] = [target]
        if isinstance(it, ast.Call) and isinstance(it.func, ast.Name):
            if it.func.id == "enumerate" and it.args and isinstance(target, ast.Tuple) \
                    and len(target.elts) == 2:
                sources, targets = [it.args[0]], [target.elts[1]]
            elif it.func.id == "zip" and isinstance(target, ast.Tuple) \
                    and len(target.elts) == len(it.args):
                sources, targets = list(it.args), list(target.elts)
        for src, tgt in zip(sources, targets):
            attr = _self_attr(src)
            if attr in self.submodules and isinstance(tgt, ast.Name):
                self.alias[tgt.id] = attr
                self.env.pop(tgt.id, None)


_NON_TENSOR_BUILTINS = {"len", "int", "float", "bool", "str", "range", "isinstance", "print",
                        "type", "list", "tuple", "dict", "set", "enumerate", "zip", "max", "min",
                        "getattr", "hasattr", "repr", "id", "sorted", "reversed", "any", "all"}


def build_flow(fn: ast.FunctionDef, submodules: set[str], methods: set[str]) -> FlowGraph:
    return FlowBuilder(fn, submodules, methods).graph
