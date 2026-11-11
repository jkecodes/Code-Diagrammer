# Code Diagrammer Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension that shows a PyTorch model as an expandable architecture diagram with tensor shapes, inside the IDE, validated on the Fast-SDE repo.

**Architecture:** A standalone Python package (`code_diagrammer`) turns a model file into a JSON graph (IR): Stage 1 parses the source with `ast` and executes nothing; Stage 2 runs one forward pass with hooks and merges real shapes in. A TypeScript extension spawns that package as a subprocess, holds the IR, and renders it in a Webview panel with ELK layout and SVG.

**Tech Stack:** Python >= 3.11 (stdlib `ast`; `torch` >= 2.0 for Stage 2 only), pytest. TypeScript, VS Code extension API (engine `^1.90.0`), esbuild, elkjs, vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-11-11-code-diagrammer-design.md`

## Global Constraints

- PyTorch only. No LLM calls, no export, no live mode.
- The diagram renders only in a VS Code Webview panel. No external browser, no local web server, no remote resources (strict CSP; all scripts bundled).
- Stage 1 never imports or executes user code and needs only the Python standard library.
- Stage 2 runs only when the user triggers "Trace Shapes", only in a trusted workspace, with the user's selected interpreter, under a timeout (default 60 s).
- Any Stage 2 failure falls back to the Stage 1 graph with `meta.traceError` set. The panel is never blank.
- Shape is optional in the IR; static and traced graphs use one format.
- Develop against the standard VS Code API only, so the extension also loads in Antigravity.
- This machine: Windows, Python 3.14 (3.13 and 3.10 also installed), Node 26, torch 2.12 CPU installed globally. Paths contain spaces (`Code Diagrammer`); never build shell command strings.
- Python commands use the repo venv: `.venv/Scripts/python`.

## Review Focus

Conditions the spec implies but does not spell out, most likely first. Each has a test in the task named.

1. **File has a syntax error (user is mid-edit when saving).** Expected: analyzer returns a structured error; the panel keeps the last good diagram and shows a warning. Tests: Task 6 `test_static_syntax_error`, Task 9 `keeps last good graph on analyzer error`.
2. **Model code prints to stdout on import or in forward.** Expected: the JSON response is still valid. Test: Task 6 `test_trace_survives_print`.
3. **Paths with spaces or non-ASCII characters.** Expected: analysis works. Tests: Task 6 `test_static_path_with_space_and_unicode`, Task 8 `analyzes a file in a path with spaces`.
4. **The same call site runs many times (loop over `nn.ModuleList`).** Expected: the layers appear chained in call order, not collapsed or duplicated. Test: Task 5 `test_loop_over_modulelist`.
5. **Forward has non-tensor or missing arguments.** Expected: literal values can be passed; a missing required argument gives an error naming it. Tests: Task 4 `test_literal_input`, `test_missing_input_named`.

## File Structure

```
.gitignore
analyzer/
  pyproject.toml
  code_diagrammer/
    __init__.py          __version__ = "0.1.0"
    ir.py                IR dataclasses + JSON conversion
    static_analysis.py   ast -> class templates -> static Graph
    tracing.py           run one forward, record modules and calls
    merge.py             templates + trace -> traced Graph
    cli.py, __main__.py  JSON-over-stdin command protocol
  tests/
    fixtures/simple_cnn.py, loop_net.py, noisy.py, broken.py, pkg/...
    test_ir.py, test_static_tree.py, test_static_flow.py,
    test_tracing.py, test_merge.py, test_cli.py, test_fastsde.py
    external/            (gitignored) FAST-SDE clone
extension/
  package.json, tsconfig.json, esbuild.mjs, vitest.config.ts
  src/
    ir.ts                TS mirror of the IR
    protocol.ts          host <-> webview messages
    messages.ts          every user-facing string
    analyzerClient.ts    spawn Python, parse response
    entryConfig.ts       .vscode/code-diagrammer.json
    controller.ts        open / trace / on-save logic (no vscode import)
    extension.ts         activate, commands, vscode glue
    graphPanel.ts        Webview panel host
    webview/view.ts      IR + view state -> visible graph (pure)
    webview/layout.ts    visible graph -> ELK -> positions
    webview/render.ts    positions -> SVG + interactions
    webview/main.ts      message wiring
  test/*.test.ts
```

## Shared Definitions

Every task relies on these. They are defined once here.

**IR JSON** (Python field names are snake_case; JSON keys are exactly as below):

```
Graph  { version: 1, meta: Meta, root: Node }
Meta   { mode: "static"|"traced", analyzerVersion: string,
         entry: { file: string, className: string },
         ctorKwargs: object|null, inputs: object|null,
         device: "meta"|"cpu"|null, traceError: string|null }
Node   { id: string, name: string, kind: "module"|"op"|"group", type: string,
         source: { file: string, startLine: int, endLine: int }|null,
         params: int|null, shapeOnly: bool, repeated: bool,
         children: Node[], edges: Edge[] }
Edge   { from: string, to: string, outIndex: int,
         shape: int[]|null, dtype: string|null, uncertain: bool }
```

- A node's `edges` connect its direct children. The node's own inputs and outputs are the reserved endpoints `"$in"` and `"$out"`. For a `"$in"` edge, `outIndex` is the forward parameter position (excluding `self`).
- `edge.shape` is the shape of output number `outIndex` of the `from` node.
- Ids: root is `"root"`. Module: dotted attribute path (`enc.blocks.0`). Op and group: `<parentId>/<name>@<line>:<col>`.
- `name`: attribute name for modules (`"0"`, `"1"` inside containers), torch function name for ops (`mean`, `add`, `getitem`), method name for groups.
- `source` of a module node is its class definition range when the class is in the workspace, otherwise the `self.x = ...` assignment line. For ops and groups it is the expression's lines.
- `SHAPE_ONLY = {view, reshape, permute, transpose, contiguous, squeeze, unsqueeze, flatten, unflatten, expand, movedim}`.
- Operator names: `+ - * / // % ** @` -> `add sub mul div floordiv mod pow matmul`; unary `-` -> `neg`; subscript -> `getitem`.

**CLI protocol:** `python -m code_diagrammer` reads one JSON request from stdin and writes one JSON response to stdout (UTF-8), exit code 0 whenever a response was written.

```
{"command":"list","file":F}
  -> {"ok":true,"classes":[{"name","line","topLevel":bool,
       "initParams":[{"name","hasDefault"}],"forwardParams":[{"name","hasDefault"}]}]}
{"command":"static","file":F,"entry":C,"workspaceRoot":R}        -> {"ok":true,"graph":Graph}
{"command":"trace","file":F,"entry":C,"workspaceRoot":R,
 "ctorKwargs":{},"inputs":{},"device":"auto"|"meta"|"cpu"}         -> {"ok":true,"graph":Graph}
any failure -> {"ok":false,"error":{"kind":"syntax"|"not-found"|"bad-request"|"internal","message","log"}}
```

`trace` never returns `ok:false` for a tracing failure; it returns the static graph with `meta.traceError`.

**Input spec** (`inputs` maps forward parameter name to one of): `[1, 3, 224, 224]` (float32 tensor of that shape); `{"shape":[...],"dtype":"int64"}`; `{"value": <any JSON>}` (passed literally).

**Test fixture** `analyzer/tests/fixtures/simple_cnn.py` (create in Task 2, exactly this):

```python
import torch
import torch.nn as nn
import torch.nn.functional as F


class Block(nn.Module):
    def __init__(self, ch):
        super().__init__()
        self.conv = nn.Conv2d(ch, ch, 3, padding=1)
        self.bn = nn.BatchNorm2d(ch)

    def forward(self, x):
        return F.relu(self.bn(self.conv(x))) + x


class SimpleCNN(nn.Module):
    def __init__(self, n_blocks=2):
        super().__init__()
        self.stem = nn.Sequential(nn.Conv2d(3, 8, 1), nn.ReLU())
        self.blocks = nn.Sequential(*[Block(8) for _ in range(n_blocks)])
        self.fc = nn.Linear(8, 10)

    def pool(self, x):
        return x.mean(dim=(2, 3))

    def forward(self, x, flag=False):
        x = self.stem(x)
        x = self.blocks(x)
        if flag:
            x = x * 2
        v = self.pool(x)
        v = v.view(v.shape[0], -1)
        return self.fc(v)
```

Tests use helpers defined in `analyzer/tests/conftest.py` (Task 2): `FIXTURES: Path`; `child(node, name) -> Node` (first direct child with that name); `names(node) -> list[str]` (direct child names in order); `edges(node) -> list[tuple]` returning `(from_name, to_name, shape, uncertain)` with ids translated to names and `$in`/`$out` kept.

---

### Task 1: Repo scaffold and IR model

**Files:**
- Create: `.gitignore`, `analyzer/pyproject.toml`, `analyzer/code_diagrammer/__init__.py`, `analyzer/code_diagrammer/ir.py`
- Test: `analyzer/tests/test_ir.py`

**Interfaces:**
- Produces: `ir.SourceRange(file, start_line, end_line)`, `ir.Edge(from_, to, out_index=0, shape=None, dtype=None, uncertain=False)`, `ir.Node(id, name, kind, type, source=None, params=None, shape_only=False, repeated=False, children=[], edges=[])`, `ir.Meta(mode, analyzer_version, entry_file, entry_class, ctor_kwargs=None, inputs=None, device=None, trace_error=None)`, `ir.Graph(meta, root)`; `Graph.to_dict() -> dict` and `Graph.from_dict(d) -> Graph` using the JSON keys in Shared Definitions.

- [ ] **Step 1: Set up the repo**

Run `git init` in the project root. `.gitignore`: `.venv/`, `node_modules/`, `__pycache__/`, `*.pyc`, `extension/dist/`, `extension/python/`, `*.vsix`, `analyzer/tests/external/`. `pyproject.toml`: package `code_diagrammer`, version `0.1.0`, `requires-python = ">=3.11"`, no runtime dependencies, optional extra `dev = ["pytest"]`. Then:

```
python -m venv --system-site-packages .venv
.venv/Scripts/python -m pip install -e "analyzer[dev]"
```

- [ ] **Step 2: Write the failing test**

```python
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
```

- [ ] **Step 3: Run it; expect FAIL** (`.venv/Scripts/python -m pytest analyzer/tests/test_ir.py -v`, "No module named code_diagrammer.ir")
- [ ] **Step 4: Implement `ir.py`** as plain dataclasses with hand-written `to_dict`/`from_dict`.
- [ ] **Step 5: Run it; expect PASS**
- [ ] **Step 6: Commit** (`chore: scaffold analyzer package and IR model`)

---

### Task 2: Static analysis: classes and module tree

**Files:**
- Create: `analyzer/code_diagrammer/static_analysis.py`, `analyzer/tests/conftest.py`, `analyzer/tests/fixtures/simple_cnn.py`, `analyzer/tests/fixtures/pkg/__init__.py`, `analyzer/tests/fixtures/pkg/layers.py`, `analyzer/tests/fixtures/pkg/model.py`
- Test: `analyzer/tests/test_static_tree.py`

**Interfaces:**
- Produces:
  - `class StaticError(Exception)` with `.kind` (`"syntax"` | `"not-found"`) and `.message`.
  - `list_classes(file: str) -> list[dict]` in the `list` response shape.
  - `class TemplateIndex` with `TemplateIndex(workspace_root: str)`, `.get(file: str, class_name: str) -> ClassTemplate | None` (parses and caches files on demand; `None` when the class is not an `nn.Module` subclass found in a workspace file).
  - `ClassTemplate` fields: `file`, `name`, `source: SourceRange`, `submodules: list[SubmoduleDecl]`, plus the flow fields Task 3 adds.
  - `SubmoduleDecl` fields: `attr: str`, `type: str`, `line: int`, `class_ref: tuple[str, str] | None` (file, class name when the class resolves into the workspace), `items: list[SubmoduleDecl]` (for `Sequential`/`ModuleList` literals), `repeated: bool`.
  - `build_static_graph(index: TemplateIndex, file: str, entry: str) -> Graph` (after this task: module children only, no edges).

Rules the code must follow:
- A class is a module class if any base is `nn.Module`, `torch.nn.Module`, `Module`, or another module class resolved in the workspace.
- `self.<attr> = <Call>` anywhere in `__init__` declares a submodule when the callee is `nn.<X>`, `torch.nn.<X>`, or a name that resolves to a module class. Other assignments are ignored.
- Class names resolve through the file's own classes, then `from X import Y` / `import X` / relative imports, looked up relative to the file's directory, then the workspace root. Unresolved names are leaf modules with `class_ref=None`.
- `nn.Sequential(a, b)` / `nn.ModuleList([a, b])` literal: `items` named `"0"`, `"1"`. A starred or comprehension argument (`*[Block(8) for ...]`) yields one item named `"*"` with `repeated=True`.
- `topLevel` in `list_classes` is true when no other class in the file instantiates the class.

Fixture `pkg/layers.py`: a module class `Scale(nn.Module)` with a `forward`. `pkg/model.py`: `from .layers import Scale`, class `Wrapper(nn.Module)` with `self.scale = Scale()` and `self.lin = nn.Linear(4, 4)`.

- [ ] **Step 1: Write the failing tests**

```python
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
```

(`SourceRange` attribute access in tests uses the JSON names via properties `startLine`/`endLine`; add those two read-only properties to `ir.SourceRange`.)

- [ ] **Step 2: Run; expect FAIL** (`.venv/Scripts/python -m pytest analyzer/tests/test_static_tree.py -v`)
- [ ] **Step 3: Implement** `conftest.py` helpers, the fixtures, and the functions above.
- [ ] **Step 4: Run; expect PASS**
- [ ] **Step 5: Commit** (`feat: static module tree from ast`)

---

### Task 3: Static analysis: forward data flow

**Files:**
- Modify: `analyzer/code_diagrammer/static_analysis.py`
- Test: `analyzer/tests/test_static_flow.py`

**Interfaces:**
- Consumes: Task 2's `ClassTemplate`, `TemplateIndex`, `build_static_graph`.
- Produces: `ClassTemplate.flow: FlowGraph` for `forward`, and `ClassTemplate.methods: dict[str, FlowGraph]` for helper methods. `FlowGraph` fields: `params: list[str]`, `nodes: list[FlowNode]`, `edges: list[Edge]`. `FlowNode` fields: `key: tuple[int, int, int, int]` (`lineno, col_offset, end_lineno, end_col_offset` of the AST expression; Task 5 joins trace records on it), `kind`, `name`, `target: str | None` (submodule attr or method name), `shape_only: bool`, `conditional: bool`, `source: SourceRange`. `build_static_graph` now emits op/group nodes and edges.

Rules the code must follow (walk `forward` statements in order, tracking for each variable the set of nodes that may have produced it):
- Tensor values: every `forward` parameter except `self`, and the result of every node.
- A node is created for: a call to `self.<submodule>` (module node, reusing the Task 2 child); a call to `self.<method>` defined on the class (group node whose children/edges are that method's `FlowGraph`); a call to `torch.<f>` or `F.<f>`; a method call on a tensor value; a binary/unary operator or subscript with a tensor operand.
- No node for: attribute access on a tensor (`x.shape`), calls on non-tensor values (`math.ceil`), anything whose operands are all non-tensors.
- Tuple-unpack targets map to the same node with `outIndex` equal to their position.
- `for v in self.<attr>:` makes `v(...)` a call to that submodule's node.
- Statements inside `if`/`for`/`while`/`try`, and both arms of a conditional expression, are `conditional`. An edge is `uncertain` when its target is conditional or its variable has more than one possible producer.
- `return` expressions produce edges to `"$out"`.
- A module called at two call sites yields two nodes; the second and later get id `<attr>@<line>:<col>`.
- A module node lives in the flow that calls it: a submodule called only inside a helper method appears inside that group, not at the parent's top level. A submodule that is declared but never called stays a direct child with no edges.

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement the flow analysis.**
- [ ] **Step 4: Run all analyzer tests; expect PASS** (`.venv/Scripts/python -m pytest analyzer -v`)
- [ ] **Step 5: Commit** (`feat: static forward data flow`)

---

### Task 4: Tracing recorder

**Files:**
- Create: `analyzer/code_diagrammer/tracing.py`, `analyzer/tests/fixtures/loop_net.py`
- Test: `analyzer/tests/test_tracing.py`

**Interfaces:**
- Produces:
  - `class TraceError(Exception)` with `.kind` (`"import"` | `"construct"` | `"input"` | `"forward"`), `.message`, `.log` (traceback text).
  - `ModuleInfo`: `path: str` (`""` for the root), `type: str`, `params: int` (total, including children), `class_file: str | None` and `class_line: int | None` (set only when the class source is under the workspace root), `in_shapes`, `out_shapes`: `list[list[int] | None] | None` from the first call (`None` if never called), `out_dtypes: list[str | None] | None`.
  - `CallRecord`: `module_path: str` (the module whose user-defined method is executing), `key: tuple[int, int, int, int]` (position of the user-code expression, same convention as `FlowNode.key`), `file: str`, `kind: "module" | "op"`, `name: str` (callee module path for modules, torch function name for ops), `out_shapes`, `out_dtypes`.
  - `TraceResult`: `modules: list[ModuleInfo]` (in `named_modules` order), `calls: list[CallRecord]` (in execution order), `device: str`.
  - `trace(file, entry, ctor_kwargs, inputs, device="auto", workspace_root=None) -> TraceResult`.

Rules the code must follow:
- Requires Python >= 3.11 and torch >= 2.0; otherwise raise `TraceError("import", ...)` saying so.
- Import the file without running its `__main__` block. Put the workspace root and the file's directory on `sys.path`. If the file sits inside packages (parent directories with `__init__.py`) under the workspace root, import it by its dotted module name so relative imports work; otherwise load it by path.
- Redirect `sys.stdout` to `sys.stderr` for the whole of import, construction and forward.
- Construct inside `with torch.device(dev):`, call `.eval()`, run under `torch.no_grad()`. Tensors from the input spec are `torch.empty(shape, dtype=..., device=dev)` on meta and `torch.randn`/`torch.zeros` (float/int) on cpu.
- `device="auto"`: try `"meta"`; on any exception during construct or forward, retry once on `"cpu"`. Report the device that succeeded.
- Module shapes: forward pre/post hooks on every module; keep the first call only. A stack of executing module paths is pushed/popped by these hooks.
- Op records: a `torch.overrides.TorchFunctionMode` records a call only when the immediate caller frame's file is under the workspace root and outside `site-packages`. The key comes from that frame's current instruction via `frame.f_code.co_positions()` and `frame.f_lasti`.
- An op is recorded only when its result contains at least one tensor (so `x.shape` and other property reads are skipped). Op names are normalized by stripping dunder underscores and the reflected/in-place prefix: `__add__`, `__radd__`, `__iadd__` -> `add`; `__getitem__` -> `getitem`; `__truediv__` -> `div`.
- Module call records: in the pre-hook, skip frames belonging to `torch/nn/modules/module.py`; if the next frame is a workspace file, record with that frame's instruction position.
- Missing required forward argument: `TraceError("input", "Missing input for forward argument 'NAME'")`. Unknown key in `inputs`: `TraceError("input", "forward has no argument 'NAME'")`.

Fixture `loop_net.py`:

```python
import torch.nn as nn


class LoopNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = nn.ModuleList([nn.Linear(4, 4) for _ in range(3)])

    def forward(self, x):
        for layer in self.layers:
            x = layer(x)
        return x
```

- [ ] **Step 1: Write the failing tests**

```python
import ast, pytest
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
    r = trace(CNN, "SimpleCNN", {"n_blocks": 3}, {"x": [1, 3, 8, 8]}, device="cpu", workspace_root=ROOT)
    assert "blocks.2" in [m.path for m in r.modules] and r.device == "cpu"

def test_relative_import_package():
    r = trace(str(FIXTURES / "pkg" / "model.py"), "Wrapper", {}, {"x": [1, 4]}, workspace_root=ROOT)
    assert [m.path for m in r.modules][:1] == [""]

def test_loop_records_each_layer():
    r = trace(str(FIXTURES / "loop_net.py"), "LoopNet", {}, {"x": [2, 4]}, workspace_root=ROOT)
    assert [c.name for c in r.calls if c.kind == "module"] == ["layers.0", "layers.1", "layers.2"]
    assert len({c.key for c in r.calls}) == 1

def test_constructor_failure_is_trace_error():
    with pytest.raises(TraceError) as e:
        trace(CNN, "SimpleCNN", {"nope": 1}, {"x": [1, 3, 8, 8]}, workspace_root=ROOT)
    assert e.value.kind == "construct" and "nope" in e.value.log
```

(`pkg/model.py`'s `Wrapper.forward` must accept one tensor `x` of shape `[1, 4]`.)

- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement `tracing.py`.**
- [ ] **Step 4: Run; expect PASS.** If `test_call_keys_match_ast_positions` cannot pass because instruction positions do not line up with AST spans for some expression kind, stop and report which kind, with the two position tuples. Do not weaken the assertion.
- [ ] **Step 5: Commit** (`feat: forward tracing recorder`)

---

### Task 5: Merge trace into a traced graph

**Files:**
- Create: `analyzer/code_diagrammer/merge.py`
- Test: `analyzer/tests/test_merge.py`

**Interfaces:**
- Consumes: `TemplateIndex.get`, `ClassTemplate.flow/.methods`, `FlowNode.key`, `TraceResult`, `ModuleInfo`, `CallRecord`.
- Produces: `build_traced_graph(index: TemplateIndex, result: TraceResult, file: str, entry: str, ctor_kwargs: dict, inputs: dict) -> Graph` with `meta.mode == "traced"` and `meta.device` set.

Rules the code must follow:
- The module tree comes from `result.modules` (real instances), not from the static declarations. `params` comes from `ModuleInfo.params`.
- A module whose class has a template (`class_file` set and `index.get` finds it) gets that template's flow: its op/group nodes and edges, with module-call nodes bound to the real child instances.
- A flow node is kept only if a `CallRecord` exists with the same `module_path` and `key`. Dropped nodes take their edges with them. In a traced graph every remaining edge has `uncertain == False`.
- Several records with the same `(module_path, key)`: for ops, use the first. For module calls (a loop over a container), the container node's children are the called instances chained in call order: `$in -> first -> ... -> last -> $out`.
- `nn.Sequential` without a template: children chained in declaration order. Any other module without a template is a leaf (its real children are not shown).
- Edge shapes: `from` a module -> that module's `out_shapes[outIndex]` / `out_dtypes[outIndex]`; `from` an op -> its record's; `from` a group -> the shape of the edge feeding the group's `$out`; `from "$in"` -> the parent module's `in_shapes[outIndex]` (for a group, the shape of the edge entering it).

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement `merge.py`.**
- [ ] **Step 4: Run all analyzer tests; expect PASS**
- [ ] **Step 5: Commit** (`feat: merge trace into graph with shapes`)

---

### Task 6: CLI protocol

**Files:**
- Create: `analyzer/code_diagrammer/cli.py`, `analyzer/code_diagrammer/__main__.py`, `analyzer/tests/fixtures/noisy.py`, `analyzer/tests/fixtures/broken.py`
- Test: `analyzer/tests/test_cli.py`

**Interfaces:**
- Consumes: `list_classes`, `TemplateIndex`, `build_static_graph`, `StaticError`, `trace`, `TraceError`, `build_traced_graph`.
- Produces: `cli.handle(request: dict) -> dict` (the protocol in Shared Definitions) and `python -m code_diagrammer`.

Rules: stdin/stdout are read and written as UTF-8 bytes regardless of console code page. `StaticError("syntax")` -> error kind `syntax` with the line number in `message`. A `TraceError`, or any exception in merge, returns `{"ok": true, "graph": <static graph>}` with `meta.traceError = "<kind>: <message>"` and the traceback in a top-level `"log"` field. An unexpected exception anywhere else returns kind `internal` with the traceback in `log`.

Fixtures: `noisy.py` is a one-`Linear(4, 2)` module `Noisy` that calls `print("loading...")` at import time and in `forward`. `broken.py` is a file with a deliberate syntax error on line 3.

- [ ] **Step 1: Write the failing tests**

```python
import json, shutil, subprocess, sys
from conftest import FIXTURES

def call(req):
    p = subprocess.run([sys.executable, "-m", "code_diagrammer"],
                       input=json.dumps(req).encode("utf-8"), capture_output=True)
    assert p.returncode == 0, p.stderr.decode("utf-8", "replace")
    return json.loads(p.stdout.decode("utf-8"))

CNN = str(FIXTURES / "simple_cnn.py")
BASE = {"file": CNN, "entry": "SimpleCNN", "workspaceRoot": str(FIXTURES)}

def test_list():
    out = call({"command": "list", "file": CNN})
    assert out["ok"] and [c["name"] for c in out["classes"]] == ["Block", "SimpleCNN"]

def test_static():
    out = call({"command": "static", **BASE})
    assert out["ok"] and out["graph"]["meta"]["mode"] == "static"

def test_trace():
    out = call({"command": "trace", **BASE, "ctorKwargs": {}, "inputs": {"x": [2, 3, 16, 16]}, "device": "auto"})
    g = out["graph"]
    assert g["meta"]["mode"] == "traced" and g["meta"]["traceError"] is None
    assert g["meta"]["inputs"] == {"x": [2, 3, 16, 16]}

def test_trace_failure_falls_back_to_static():
    out = call({"command": "trace", **BASE, "ctorKwargs": {}, "inputs": {}, "device": "auto"})
    assert out["ok"] and out["graph"]["meta"]["mode"] == "static"
    assert out["graph"]["meta"]["traceError"].startswith("input: ") and "'x'" in out["graph"]["meta"]["traceError"]

def test_trace_survives_print():
    noisy = str(FIXTURES / "noisy.py")
    out = call({"command": "trace", "file": noisy, "entry": "Noisy", "workspaceRoot": str(FIXTURES),
                "ctorKwargs": {}, "inputs": {"x": [1, 4]}, "device": "auto"})
    assert out["graph"]["meta"]["mode"] == "traced"

def test_static_syntax_error():
    out = call({"command": "static", "file": str(FIXTURES / "broken.py"), "entry": "X",
                "workspaceRoot": str(FIXTURES)})
    assert out["ok"] is False and set(out["error"]) == {"kind", "message", "log"}
    assert out["error"]["kind"] == "syntax" and "line 3" in out["error"]["message"]

def test_static_path_with_space_and_unicode(tmp_path):
    d = tmp_path / "my models 模型"
    d.mkdir()
    shutil.copy(CNN, d / "simple_cnn.py")
    out = call({"command": "static", "file": str(d / "simple_cnn.py"), "entry": "SimpleCNN",
                "workspaceRoot": str(d)})
    assert out["ok"] and out["graph"]["root"]["children"][0]["source"]["file"].endswith("simple_cnn.py")

def test_bad_request():
    assert call({"command": "nope"})["error"]["kind"] == "bad-request"
```

- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement `cli.py` and `__main__.py`.**
- [ ] **Step 4: Run all analyzer tests; expect PASS**
- [ ] **Step 5: Commit** (`feat: analyzer JSON CLI`)

---

### Task 7: Fast-SDE acceptance

**Files:**
- Test: `analyzer/tests/test_fastsde.py`
- Modify: analyzer source only as needed to make the acceptance pass

**Interfaces:**
- Consumes: `cli.handle`.

- [ ] **Step 1: Fetch the repo and its one extra dependency**

```
git clone https://github.com/JiangWAV/FAST-SDE analyzer/tests/external/FAST-SDE
git -C analyzer/tests/external/FAST-SDE checkout 024c7f3b94f5c390a253db5b88fce023760c6a1b
.venv/Scripts/python -m pip install torchlibrosa
.venv/Scripts/python -c "from torchlibrosa import STFT; print('ok')"
```

If `torchlibrosa` will not install or import on Python 3.14 (it depends on `librosa`/`numba`), create a second venv with `py -3.13 -m venv .venv313`, install `torch`, `torchlibrosa`, `pytest` and `-e analyzer` there, and use `.venv313/Scripts/python` for this task. If that also fails, stop and report the exact error. Do not stub out `STFT`.

- [ ] **Step 2: Write the acceptance tests**

```python
import pytest
from pathlib import Path
from conftest import child, names, edges
from code_diagrammer.cli import handle
from code_diagrammer.ir import Graph

REPO = Path(__file__).parent / "external" / "FAST-SDE"
FILE = REPO / "models" / "fastsde.py"
pytestmark = pytest.mark.skipif(not FILE.exists(), reason="FAST-SDE not cloned")
BASE = {"file": str(FILE), "entry": "SeldNetSubbandFast", "workspaceRoot": str(REPO)}

def lines(start_text):
    src = FILE.read_text(encoding="utf-8").splitlines()
    return next(i for i, l in enumerate(src, 1) if start_text in l)

def test_static_structure():
    g = Graph.from_dict(handle({"command": "static", **BASE})["graph"])
    root = g.root
    mods = [c.name for c in root.children if c.kind == "module"]
    for m in ["split", "enc", "fuse", "gru", "head"]:
        assert m in mods
    assert child(root, "extract_features").kind == "group"
    assert "STFT" in names(child(root, "extract_features"))
    enc = child(root, "enc")
    assert [c.name for c in enc.children if c.kind == "module"] == ["proj", "blocks"]
    ffb = child(enc, "blocks").children[0]
    assert ffb.type == "FastFilterBlock" and ffb.repeated
    assert [c.name for c in ffb.children] == ["pw1", "dw_a", "dw_b", "cat", "pw2", "add"]
    assert enc.source.startLine == lines("class SharedSubbandEncoder")
    assert ffb.source.startLine == lines("class FastFilterBlock")
    assert child(root, "split").source.startLine == lines("class SubbandSplitNoOverlap")

def test_traced_shapes_match_paper_figure():
    out = handle({"command": "trace", **BASE, "ctorKwargs": {}, "inputs": {"wav": [1, 3200]}, "device": "auto"})
    g = Graph.from_dict(out["graph"])
    assert g.meta.trace_error is None, out.get("log")
    got = [(a, b, s) for a, b, s, _ in edges(g.root)]
    for expected in [
        ("extract_features", "split", [1, 3, 26, 256]),   # 3 x T x F
        ("split", "view", [1, 8, 3, 26, 32]),
        ("view", "enc", [8, 3, 26, 32]),                  # N x 3 x T x (F/N)
        ("enc", "view", [8, 24, 26, 32]),                 # N x C x T x (F/N)
        ("mul", "view", [1, 8, 24, 26]),                  # N x C x T
        ("view", "fuse", [1, 192, 26]),
        ("fuse", "permute", [1, 64, 26]),                 # C_Fuse x T
        ("gru", "mean", [1, 26, 96]),
        ("mul", "head", [1, 96]),
        ("head", "$out", [1, 1]),
    ]:
        assert expected in got, f"missing {expected}; got {got}"
    assert len(child(child(g.root, "enc"), "blocks").children) == 3
    assert "squeeze" not in names(g.root)   # the return_seq branch did not run
```

- [ ] **Step 3: Run** (`.venv/Scripts/python -m pytest analyzer/tests/test_fastsde.py -v`)

Fix analyzer bugs the tests expose (add a fixture-level regression test in the owning task's test file for each bug fixed). The expected shapes were derived by reading the code. **If the trace succeeds but reports different numbers, do not edit the expected values: stop and report the actual shapes**, because the spec says the table must be confirmed with the user.

- [ ] **Step 4: Run the whole analyzer suite; expect PASS**
- [ ] **Step 5: Commit** (`test: Fast-SDE acceptance for the analyzer`)

---

### Task 8: Extension scaffold, IR types, AnalyzerClient

**Files:**
- Create: `extension/package.json`, `extension/tsconfig.json`, `extension/esbuild.mjs`, `extension/vitest.config.ts`, `extension/src/ir.ts`, `extension/src/analyzerClient.ts`, `extension/test/fixtures/sleeper/__main__.py`
- Test: `extension/test/analyzerClient.test.ts`

**Interfaces:**
- Produces:
  - `ir.ts`: types `Graph`, `Meta`, `Node`, `Edge`, `SourceRange`, `ClassInfo`, `InputSpec` exactly mirroring Shared Definitions.
  - `analyzerClient.ts`:
    ```ts
    export type AnalyzerError = { kind: "python-not-found" | "timeout" | "bad-output" | "syntax" | "not-found" | "bad-request" | "internal"; message: string; log: string };
    export type Result<T> = { ok: true; value: T; log?: string } | { ok: false; error: AnalyzerError };
    export type TraceRequest = { file: string; entry: string; workspaceRoot: string; ctorKwargs: Record<string, unknown>; inputs: Record<string, InputSpec>; device: "auto" | "meta" | "cpu" };
    export class AnalyzerClient {
      constructor(opts: { pythonPath: string; analyzerDir: string; timeoutMs: number; moduleName?: string });
      listClasses(file: string): Promise<Result<ClassInfo[]>>;
      analyzeStatic(req: { file: string; entry: string; workspaceRoot: string }): Promise<Result<Graph>>;
      trace(req: TraceRequest): Promise<Result<Graph>>;
    }
    ```

Decisions:
- `package.json`: name `code-diagrammer`, `engines.vscode: "^1.90.0"`, `main: "./dist/extension.js"`, `capabilities.untrustedWorkspaces: { supported: "limited", description: "Tracing shapes runs your model code and is disabled in untrusted workspaces." }`. Commands `codeDiagrammer.open` ("Code Diagrammer: Open Architecture Diagram"), `codeDiagrammer.traceShapes` ("Code Diagrammer: Trace Shapes"), `codeDiagrammer.selectEntry` ("Code Diagrammer: Select Entry Model"). Settings `codeDiagrammer.pythonPath` (string, default `""`) and `codeDiagrammer.traceTimeoutSeconds` (number, default `60`). Dev dependencies: `typescript`, `esbuild`, `vitest`, `jsdom`, `@types/vscode`, `@types/node`, `@vscode/vsce`. Dependency: `elkjs`.
- `esbuild.mjs` builds two bundles, `dist/extension.js` (node, external `vscode`) and `dist/webview.js` (browser, iife), and copies `analyzer/code_diagrammer` to `extension/python/code_diagrammer`. Scripts: `build`, `test` (`vitest run`), `package` (`vsce package`).
- The client spawns `pythonPath` with args `["-X", "utf8", "-m", moduleName ?? "code_diagrammer"]`, `shell: false`, env `PYTHONPATH = analyzerDir` (prepended to any existing value), writes the request to stdin, and kills the process at `timeoutMs`. `ENOENT` -> `python-not-found`. Unparseable stdout -> `bad-output` with stderr in `log`. An `ok:false` response -> its `error`. A response's top-level `log` is passed through on success.

- [ ] **Step 1: Write the failing tests** (vitest; `analyzerDir` points at `../analyzer`, python at `../.venv/Scripts/python.exe`)

```ts
const fixtures = path.resolve(__dirname, "../../analyzer/tests/fixtures");
const cnn = path.join(fixtures, "simple_cnn.py");
const make = (o = {}) => new AnalyzerClient({ pythonPath: PY, analyzerDir: ANALYZER, timeoutMs: 30000, ...o });

test("lists classes", async () => {
  const r = await make().listClasses(cnn);
  expect(r.ok && r.value.map(c => c.name)).toEqual(["Block", "SimpleCNN"]);
});
test("static graph", async () => {
  const r = await make().analyzeStatic({ file: cnn, entry: "SimpleCNN", workspaceRoot: fixtures });
  expect(r.ok && r.value.meta.mode).toBe("static");
});
test("traced graph has shapes", async () => {
  const r = await make().trace({ file: cnn, entry: "SimpleCNN", workspaceRoot: fixtures, ctorKwargs: {}, inputs: { x: [2, 3, 16, 16] }, device: "auto" });
  expect(r.ok && r.value.root.edges[0].shape).toEqual([2, 3, 16, 16]);
});
test("analyzes a file in a path with spaces", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cd test "));
  fs.copyFileSync(cnn, path.join(dir, "simple_cnn.py"));
  const r = await make().analyzeStatic({ file: path.join(dir, "simple_cnn.py"), entry: "SimpleCNN", workspaceRoot: dir });
  expect(r.ok).toBe(true);
});
test("python not found", async () => {
  const r = await make({ pythonPath: "no-such-python-xyz" }).listClasses(cnn);
  expect(!r.ok && r.error.kind).toBe("python-not-found");
});
test("timeout kills the process", async () => {
  const r = await make({ timeoutMs: 300, analyzerDir: path.resolve(__dirname, "fixtures"), moduleName: "sleeper" }).listClasses(cnn);
  expect(!r.ok && r.error.kind).toBe("timeout");
});
test("syntax error is passed through", async () => {
  const r = await make().analyzeStatic({ file: path.join(fixtures, "broken.py"), entry: "X", workspaceRoot: fixtures });
  expect(!r.ok && r.error.kind).toBe("syntax");
});
```

(`sleeper/__main__.py` sleeps 30 seconds.)

- [ ] **Step 2: Run `npm install` then `npm test` in `extension/`; expect FAIL**
- [ ] **Step 3: Implement the scaffold, `ir.ts`, `analyzerClient.ts`.**
- [ ] **Step 4: Run `npm test` and `npm run build`; expect PASS and both bundles in `dist/`**
- [ ] **Step 5: Commit** (`feat: extension scaffold and analyzer client`)

---

### Task 9: Entry config and controller

**Files:**
- Create: `extension/src/messages.ts`, `extension/src/protocol.ts`, `extension/src/entryConfig.ts`, `extension/src/controller.ts`
- Test: `extension/test/entryConfig.test.ts`, `extension/test/controller.test.ts`

**Interfaces:**
- Consumes: `AnalyzerClient` (through the structural type `Pick<AnalyzerClient, "listClasses" | "analyzeStatic" | "trace">`), `Graph`, `ClassInfo`.
- Produces:
  - `protocol.ts`:
    ```ts
    export type NoticeAction = "trace" | "copyLog" | "editInputs" | "selectPython";
    export type HostMessage = { type: "graph"; graph: Graph } | { type: "notice"; level: "info" | "warn" | "error"; text: string; action?: NoticeAction } | { type: "clearNotice" };
    export type WebviewMessage = { type: "ready" } | { type: "openSource"; source: SourceRange } | { type: "action"; action: NoticeAction };
    ```
  - `entryConfig.ts`: `type EntryConfig = { className: string; ctorKwargs: Record<string, unknown>; inputs: Record<string, InputSpec> }`; `loadEntry(workspaceRoot: string, file: string): EntryConfig | undefined`; `saveEntry(workspaceRoot: string, file: string, entry: EntryConfig): void`; `templateFor(cls: ClassInfo): EntryConfig` (every forward parameter without a default gets `[1, 3, 224, 224]`; `ctorKwargs` is `{}`). Storage: `<workspaceRoot>/.vscode/code-diagrammer.json`, shape `{ "entries": { "<file relative to root, forward slashes>": EntryConfig } }`. A malformed file is treated as empty.
  - `controller.ts`:
    ```ts
    export interface Host {
      isTrusted(): boolean;
      pickClass(names: string[]): Promise<string | undefined>;
      post(msg: HostMessage): void;
      openConfigFile(): Promise<void>;
    }
    export class DiagramController {
      constructor(client: AnalyzerClientLike, host: Host, workspaceRoot: string);
      readonly graph: Graph | undefined;   // last good graph
      readonly lastLog: string;            // log of the last failure, for "copy log"
      open(file: string): Promise<void>;        // list, choose entry, static analyze
      selectEntry(): Promise<void>;             // always asks, then re-analyzes
      traceShapes(): Promise<void>;
      onFileSaved(file: string): Promise<void>; // only reacts to the open file
    }
    ```
  - `messages.ts` exports these exact strings:
    - `UNTRUSTED = "Trace Shapes runs your model code, so it is disabled until you trust this workspace."`
    - `NO_SHAPES = "Showing structure only. Run Trace Shapes to add tensor shapes."`
    - `NEED_INPUTS = "Set the input shapes for this model in .vscode/code-diagrammer.json, then run Trace Shapes again."`
    - `SHAPES_CLEARED = "Shapes cleared after edit. Run Trace Shapes to refresh."`
    - `TRACE_FAILED = (reason: string) => "Could not trace shapes (" + reason + "). Showing structure only."`
    - `ANALYSIS_FAILED = (reason: string) => "Could not analyze this file (" + reason + "). Showing the last good diagram."`
    - `PYTHON_NOT_FOUND = "Python was not found. Set codeDiagrammer.pythonPath to your interpreter."`
    - `NO_MODELS = "No nn.Module classes found in this file."`

Behavior:
- `open`: one top-level class -> use it; several -> `host.pickClass`; a saved entry for the file wins over both. Saves the choice. On success posts `graph` then notice `info NO_SHAPES` with action `trace`.
- `traceShapes`: untrusted -> notice `warn UNTRUSTED`, analyzer not called. No inputs saved -> write `templateFor` into the config, `host.openConfigFile()`, notice `info NEED_INPUTS` with action `editInputs`, analyzer not called. Otherwise call `trace`; if `meta.traceError` is set, post the graph and notice `warn TRACE_FAILED(traceError)` with action `copyLog`; else post the graph and `clearNotice`.
- Any `ok:false`: keep `graph` unchanged, set `lastLog`, post `error PYTHON_NOT_FOUND` with action `selectPython` for `python-not-found`, otherwise `warn ANALYSIS_FAILED(error.message)` with action `copyLog`.
- `onFileSaved` for the open file: re-run static. If the previous graph was traced, the notice is `info SHAPES_CLEARED` with action `trace`.

- [ ] **Step 1: Write the failing tests**

`entryConfig.test.ts`: `saveEntry` then `loadEntry` round-trips in a temp dir and the JSON key is `"sub/model.py"` for a file in `sub\model.py`; malformed JSON -> `loadEntry` returns `undefined`; `templateFor({ forwardParams: [{name:"x",hasDefault:false},{name:"flag",hasDefault:true}], ... })` -> `inputs` equals `{ x: [1, 3, 224, 224] }`.

`controller.test.ts` uses a fake client returning canned `Result`s and a fake host that records `post` calls:

```ts
test("open with one top-level class posts graph and NO_SHAPES", ...)          // posts [{type:"graph"}, {type:"notice", level:"info", text: NO_SHAPES, action:"trace"}]
test("open with two top-level classes asks pickClass", ...)                    // pickClass called with both names
test("trace in untrusted workspace is refused", ...)                           // client.trace not called; notice text === UNTRUSTED
test("trace without saved inputs writes template and opens config", ...)       // openConfigFile called once; notice text === NEED_INPUTS; client.trace not called
test("trace failure keeps structure and offers the log", ...)                  // graph posted; notice text === TRACE_FAILED("input: ..."), action "copyLog"
test("keeps last good graph on analyzer error", ...)                           // after a good open, onFileSaved with a syntax error: controller.graph unchanged; notice text === ANALYSIS_FAILED(message)
test("save after trace clears shapes", ...)                                    // notice text === SHAPES_CLEARED
test("python not found", ...)                                                  // notice level "error", text === PYTHON_NOT_FOUND, action "selectPython"
test("save of a different file is ignored", ...)                               // no client call
```

Write each as a full test with the assertions in its comment.

- [ ] **Step 2: Run `npm test`; expect FAIL**
- [ ] **Step 3: Implement the four files.** `controller.ts` must not import `vscode`.
- [ ] **Step 4: Run `npm test`; expect PASS**
- [ ] **Step 5: Commit** (`feat: entry config and diagram controller`)

---

### Task 10: Webview view model and layout

**Files:**
- Create: `extension/src/webview/view.ts`, `extension/src/webview/layout.ts`
- Test: `extension/test/view.test.ts`, `extension/test/layout.test.ts`

**Interfaces:**
- Consumes: `Graph`, `Node`, `Edge`.
- Produces:
  ```ts
  // view.ts
  export type ViewState = { expanded: Set<string>; showShapeOps: boolean };
  export type VEdge = { from: string; to: string; label: string; uncertain: boolean };
  export type VNode = { id: string; label: string; sublabel: string; kind: "module" | "op" | "group" | "terminal"; expandable: boolean; expanded: boolean; node: Node | null; children: VNode[]; edges: VEdge[] };
  export function formatShape(shape: number[] | null): string;            // [1, 3, 26, 256] -> "[1, 3, 26, 256]"; null -> ""
  export function formatParams(n: number | null): string;                 // 1322 -> "1.3K params"; 75800 -> "75.8K params"; 2500000 -> "2.5M params"; 90 -> "90 params"; null -> ""
  export function buildView(graph: Graph, state: ViewState): VNode;       // the root is always expanded
  // layout.ts
  export type Box = { id: string; x: number; y: number; width: number; height: number; v: VNode; children: Box[] };
  export type Path = { points: { x: number; y: number }[]; label: string; labelAt: { x: number; y: number }; uncertain: boolean };
  export type Laid = { width: number; height: number; root: Box; paths: Path[] };
  export function toElk(v: VNode): ElkNode;
  export function layoutView(v: VNode): Promise<Laid>;                    // absolute coordinates
  ```

Rules for `buildView`:
- `label`: `node.name` for modules and groups inside containers, with `sublabel = node.type` for modules (`enc` / `SharedSubbandEncoder`); for ops `label = node.name`, `sublabel = ""`; a `repeated` node's label is `node.type + " x N"`.
- A node is `expandable` when it has children. Collapsed nodes have `children: []` and `edges: []`.
- An expanded node gets two terminal children with ids `<id>/$in` and `<id>/$out` (kind `terminal`, empty label), and its `$in`/`$out` edges attach to them. Terminals with no edges are omitted.
- Edge `label` is `formatShape(edge.shape)`.
- With `showShapeOps: false`, a maximal chain of `shapeOnly` nodes each having exactly one incoming and one outgoing edge is removed and replaced by one edge from the chain's source to its target, labeled `"<shape entering the chain> → <shape leaving it>"`, or the single shape when both are equal, `uncertain` if any replaced edge was. Shape-only nodes with fan-in or fan-out other than 1 stay as nodes.

`toElk`: algorithm `layered`, direction `RIGHT`, `elk.hierarchyHandling: INCLUDE_CHILDREN`, edge labels as ELK labels. Leaf size: width `max(96, 8 * longest label line + 24)`, height `44` (`28` for ops, `12x12` for terminals).

- [ ] **Step 1: Write the failing tests**

`view.test.ts` builds small `Graph` literals by hand:

```ts
test("formatShape / formatParams", () => {
  expect(formatShape([1, 3, 26, 256])).toBe("[1, 3, 26, 256]"); expect(formatShape(null)).toBe("");
  expect(formatParams(1322)).toBe("1.3K params"); expect(formatParams(75800)).toBe("75.8K params");
  expect(formatParams(2500000)).toBe("2.5M params"); expect(formatParams(90)).toBe("90 params"); expect(formatParams(null)).toBe("");
});
test("root is expanded, children collapsed by default", ...)   // ids of root children: ["root/$in","stem","blocks","root/$out"]; stem.expandable true, stem.children []
test("expanding a node reveals its children and terminals", ...) // state.expanded = {"stem"} -> stem.children ids ["stem/$in","stem.0","stem.1","stem/$out"]
test("shape-only chain folds into one labeled edge", ...)
// graph: a -[1,8,3,26,32]-> view -[8,3,26,32]-> b, view.shapeOnly; showShapeOps false
// -> no "view" child; one edge {from:"a", to:"b", label:"[1, 8, 3, 26, 32] → [8, 3, 26, 32]"}
test("two shape-only nodes in a row fold together", ...)        // fuse -[1,64,26]-> permute -[1,26,64]-> contiguous -[1,26,64]-> gru => "[1, 64, 26] → [1, 26, 64]"
test("equal shapes fold to a single label", ...)                // "[2, 8]"
test("showShapeOps true keeps the node", ...)
test("shape-only node with two consumers is kept", ...)
test("module label and sublabel", ...)                          // {label:"enc", sublabel:"SharedSubbandEncoder"}
```

`layout.test.ts`: `toElk` of a three-node view returns 3 children and 2 edges with `layoutOptions["elk.direction"] === "RIGHT"`; `await layoutView(...)` gives every box a positive width and boxes in a chain `a -> b -> c` strictly increasing `x`; a child box lies inside its expanded parent's box.

- [ ] **Step 2: Run `npm test`; expect FAIL**
- [ ] **Step 3: Implement `view.ts` and `layout.ts`** (import `elkjs/lib/elk.bundled.js`).
- [ ] **Step 4: Run `npm test`; expect PASS**
- [ ] **Step 5: Commit** (`feat: diagram view model and layout`)

---

### Task 11: Rendering, interactions, and panel wiring

**Files:**
- Create: `extension/src/webview/render.ts`, `extension/src/webview/main.ts`, `extension/src/webview/style.css`, `extension/src/graphPanel.ts`, `extension/src/extension.ts`
- Test: `extension/test/render.test.ts` (vitest environment `jsdom`)

**Interfaces:**
- Consumes: `Laid`, `Box`, `VNode`, `buildView`, `layoutView`, `HostMessage`, `WebviewMessage`, `DiagramController`, `Host`, `AnalyzerClient`.
- Produces:
  ```ts
  // render.ts
  export type Handlers = { onSelect(id: string): void; onOpen(id: string): void; onToggle(id: string): void };
  export function renderDiagram(svg: SVGSVGElement, laid: Laid, selectedId: string | null, handlers: Handlers): void;
  export function renderDetails(el: HTMLElement, v: VNode | null, inShapes: string[], outShapes: string[]): void;
  export function renderNotice(el: HTMLElement, notice: { level: string; text: string; action?: NoticeAction } | null, onAction: (a: NoticeAction) => void): void;
  // graphPanel.ts
  export class GraphPanel { static show(context: vscode.ExtensionContext, onMessage: (m: WebviewMessage) => void): GraphPanel; post(m: HostMessage): void; }
  ```

Rendering decisions:
- Each node is `<g class="node node-<kind>" data-id="<id>">` with a `<rect>`, a label `<text class="label">`, and a sublabel `<text class="sublabel">` when present. Expandable nodes have `<g class="toggle" data-id="<id>">` showing `+` when collapsed and `−` when expanded. Edges are `<path class="edge">` (class `uncertain` adds a dashed stroke) plus `<text class="edge-label">`. The selected node has class `selected`.
- Single click on a node -> `onSelect`. Double click -> `onOpen`. Click on the toggle -> `onToggle` only (stop propagation so it neither selects nor opens). Terminals are not interactive.
- Details pane for the selected node: name, type, kind, `formatParams`, the labels of its incoming and outgoing edges, and `file:startLine`.
- Right-click on a node shows a small menu with two items: "Open source" (same as double click) and "Ask Claude about this block", which is rendered disabled with the title "Coming in a later version".
- A toolbar holds a "Show reshape ops" checkbox bound to `ViewState.showShapeOps` and a "Trace Shapes" button that posts `{ type: "action", action: "trace" }`.
- Colors come from VS Code theme CSS variables (`--vscode-editor-background`, `--vscode-editor-foreground`, `--vscode-focusBorder`, `--vscode-descriptionForeground`) so the panel follows light and dark themes. Pan with drag, zoom with ctrl+wheel, via the SVG `viewBox`.
- `main.ts` keeps `ViewState` and the selected id, re-runs `buildView` -> `layoutView` -> `renderDiagram` on every graph message and every toggle, posts `ready` on load, and posts `openSource` with the node's `source` on open. Expanded ids that no longer exist after a new graph are dropped; the rest are kept.

Host decisions:
- `GraphPanel` creates `vscode.window.createWebviewPanel("codeDiagrammer", "Architecture: <class>", vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] })`. HTML has CSP `default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource};` and loads only `dist/webview.js` and the stylesheet. The last `graph` message is re-sent when the webview posts `ready`.
- `extension.ts`: Python path is the `codeDiagrammer.pythonPath` setting, else the `python.defaultInterpreterPath` setting, else `"python"`. `analyzerDir` is `<extensionPath>/python`. Timeout from `codeDiagrammer.traceTimeoutSeconds`. `Host.isTrusted` is `vscode.workspace.isTrusted`. `openSource` opens the file in `ViewColumn.One` and selects lines `startLine..endLine` (revealed in center). Notice actions: `trace` -> `traceShapes()`; `copyLog` -> copy `controller.lastLog` to the clipboard; `editInputs` -> open `.vscode/code-diagrammer.json`; `selectPython` -> open settings filtered to `codeDiagrammer.pythonPath`. `onDidSaveTextDocument` calls `controller.onFileSaved`. `codeDiagrammer.open` uses the active editor's file and requires it to be a `.py` file inside a workspace folder.

- [ ] **Step 1: Write the failing tests** (`render.test.ts`, hand-built `Laid` values)

```ts
test("renders one group per node with labels", ...)      // 3 boxes -> 3 g.node; text.label contents ["stem","blocks","fc"]; sublabel "Sequential"
test("edge label and uncertain class", ...)               // text.edge-label "[2, 8, 16, 16]"; path.edge.uncertain exists for an uncertain path
test("click selects, double click opens", ...)            // dispatch click -> onSelect("fc") once; dispatch dblclick -> onOpen("fc") once
test("toggle click only toggles", ...)                    // click g.toggle -> onToggle("blocks") once; onSelect and onOpen not called
test("terminals are not interactive", ...)                // click on terminal -> no handler called
test("selected node has the selected class", ...)
test("details show params, shapes and location", ...)     // text contains "1.3K params", "[2, 8, 16, 16]", "simple_cnn.py:19"
test("notice renders text and action button", ...)        // button click -> onAction("trace"); null notice empties the element
```

- [ ] **Step 2: Run `npm test`; expect FAIL**
- [ ] **Step 3: Implement the files above.**
- [ ] **Step 4: Run `npm test` and `npm run build`; expect PASS**
- [ ] **Step 5: Manual smoke test.** Press F5 in `extension/` (add `.vscode/launch.json` with an `extensionHost` configuration), open `analyzer/tests/fixtures/simple_cnn.py` in the dev host, run "Code Diagrammer: Open Architecture Diagram". Expected: a panel beside the editor showing `stem -> blocks -> mul -> pool -> fc`, no browser window. Double-click `fc`: the editor jumps to the `self.fc =` line.
- [ ] **Step 6: Commit** (`feat: diagram webview with interactions`)

---

### Task 11b: Cursor-to-node highlight

**Files:**
- Create: `extension/src/webview/cursor.ts`
- Modify: `extension/src/protocol.ts`, `extension/src/webview/render.ts`, `extension/src/webview/main.ts`, `extension/src/webview/style.css`, `extension/src/extension.ts`
- Test: `extension/test/cursor.test.ts`, `extension/test/render.test.ts`

**Interfaces:**
- Consumes: `Graph`, `Node`, `VNode`.
- Produces:
  ```ts
  // protocol.ts: add to HostMessage
  | { type: "cursor"; file: string; line: number }      // line is 1-based
  // cursor.ts
  export function nodesAtLine(graph: Graph, file: string, line: number): string[];
  export function visibleTargets(graph: Graph, view: VNode, ids: string[]): string[];
  // render.ts
  export function applyCursorHighlight(svg: SVGSVGElement, ids: string[]): void;   // sets class "cursor" on exactly those nodes
  ```

Rules:
- `nodesAtLine`: among nodes whose `source.file` equals `file` (compare normalized paths, case-insensitive on Windows) and whose range contains `line`, return every node with the smallest range (`endLine - startLine`). Several instances of one class share a range, so all are returned. No match -> `[]`.
- `visibleTargets`: for each id, the id itself if it is in `view`, otherwise its nearest ancestor that is; de-duplicated, order preserved. The view is never changed.
- `extension.ts` posts `cursor` on `onDidChangeTextEditorSelection` for any workspace `.py` file, debounced 100 ms. `main.ts` re-applies the highlight after every re-render.
- The `cursor` class uses a dashed outline in `--vscode-editorCursor-foreground`, visually distinct from `selected`.

- [ ] **Step 1: Write the failing tests**

```ts
// graph: root(class lines 14-31) > stem(line 17), blocks > [blocks.0, blocks.1] (both class Block, lines 6-13)
//        each Block > conv (line 9), bn (line 10), add (line 13, kind op)
test("line inside a class returns all its instances", () => {
  expect(nodesAtLine(g, FILE, 12)).toEqual(["blocks.0", "blocks.1"]);
});
test("innermost node wins", () => {
  expect(nodesAtLine(g, FILE, 13)).toEqual(["blocks.0/add@13:15", "blocks.1/add@13:15"]);
  expect(nodesAtLine(g, FILE, 17)).toEqual(["stem"]);
});
test("no match and other file", () => {
  expect(nodesAtLine(g, FILE, 99)).toEqual([]);
  expect(nodesAtLine(g, "other.py", 12)).toEqual([]);
});
test("path comparison ignores case and slash direction on Windows", ...)   // "C:\\A\\m.py" matches "c:/a/m.py"
test("collapsed nodes map to nearest visible ancestor, de-duplicated", () => {
  const view = buildView(g, { expanded: new Set(), showShapeOps: false });
  expect(visibleTargets(g, view, ["blocks.0", "blocks.1"])).toEqual(["blocks"]);
});
test("visible nodes map to themselves", ...)                               // expanded {"blocks"} -> ["blocks.0","blocks.1"]
// render.test.ts
test("applyCursorHighlight sets and clears the cursor class", ...)         // apply ["fc"] then ["stem"]: only stem has class "cursor"
```

- [ ] **Step 2: Run `npm test`; expect FAIL**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run build`; expect PASS**
- [ ] **Step 5: Commit** (`feat: highlight the diagram node under the editor cursor`)

---

### Task 12: Package and end-to-end verification

**Files:**
- Create: `README.md`, `extension/.vscodeignore`
- Modify: whatever the verification below shows to be broken

- [ ] **Step 1: Package.** In `extension/`: `npm run build` then `npm run package`. Expected: `code-diagrammer-0.1.0.vsix` containing `dist/` and `python/code_diagrammer/`, and no `node_modules` or tests (check with `npx vsce ls`).

- [ ] **Step 2: Verify in VS Code with Fast-SDE.** `code --install-extension extension/code-diagrammer-0.1.0.vsix`, open the folder `analyzer/tests/external/FAST-SDE`, open `models/fastsde.py`, and check each line:
  1. "Open Architecture Diagram" shows the structure in a panel inside the IDE; no browser opens.
  2. The panel shows the `NO_SHAPES` notice and no shape labels.
  3. "Trace Shapes" opens `.vscode/code-diagrammer.json` with a `wav` input; set it to `[1, 3200]`, run again.
  4. Edge labels read `[1, 3, 26, 256]` into `split`, `[1, 8, 3, 26, 32] → [8, 3, 26, 32]` into `enc`, `[1, 64, 26] → [1, 26, 64]` into `gru`, and `[1, 1]` at the output.
  5. Expanding `enc`, then `blocks`, then `0` shows `pw1`, `dw_a`, `dw_b`, `cat`, `pw2`, `add`.
  6. Double-clicking `enc` opens `class SharedSubbandEncoder` with the class highlighted.
  7. Single-clicking `gru` shows its parameter count and shapes in the details pane.
  8. Editing and saving the file shows `SHAPES_CLEARED`; introducing a syntax error and saving keeps the diagram and shows the warning.
  10. Placing the cursor inside `class FastFilterBlock` highlights `enc` while it is collapsed, and all three blocks once `enc` and `blocks` are expanded.
  9. In a Restricted Mode window, "Trace Shapes" shows the `UNTRUSTED` notice and runs nothing.

- [ ] **Step 3: Verify in Antigravity.** Install the same `.vsix` in Antigravity (Extensions view -> "Install from VSIX") and repeat checks 1, 4 and 6. This step needs the user at the keyboard if Antigravity has no CLI on this machine; record the result either way. If the Webview does not render there, capture the developer-tools console error and report it rather than marking the task done.

- [ ] **Step 4: Write `README.md`**: what it does, requirements (Python >= 3.11 with torch in the selected interpreter), the three commands, the input-spec forms, and the safety note that Trace Shapes executes model code.

- [ ] **Step 5: Run both suites one last time** (`.venv/Scripts/python -m pytest analyzer -v`; `npm test` in `extension/`); expect all PASS. Commit (`chore: package and document milestone 1`).

---

## Deferred from the spec

- Sub-projects 3 to 6 (LLM grouping and questions, export, live mode, editing with Claude) each get their own spec and plan.
