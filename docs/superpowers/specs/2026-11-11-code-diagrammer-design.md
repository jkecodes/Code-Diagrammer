# Code Diagrammer — Milestone 1 Design

Date: 2026-11-11
Status: Draft for user review

## 1. Goal

A VS Code extension (also loadable in Antigravity IDE, a VS Code fork) that turns PyTorch model code into an interactive architecture diagram with tensor shapes, shown entirely inside the IDE.

Intended users: AI/ML researchers and engineers who (a) read other people's model code, (b) draw architecture figures for papers, (c) debug shapes while developing, (d) want general architecture overviews.

### Decomposition

All four use cases share one core: code -> graph IR (with shapes) -> renderer. Work is split into sub-projects, each with its own spec -> plan -> implementation cycle:

| # | Sub-project | Status |
|---|---|---|
| 1 | Analyzer engine (code -> IR) | **Milestone 1 (this spec)** |
| 2 | VS Code viewer | **Milestone 1 (this spec)** |
| 3 | LLM layer (grouping, naming, "ask Claude about this block") | Later |
| 4 | Export (SVG/PNG for papers; draw.io/TikZ later) | Later |
| 5 | Live dev mode (update on save, flag shape mismatches) | Later |
| 6 | AI-assisted block editing ("Edit with Claude") | Later (depends on 3) |

Milestone 1 scope: PyTorch only. Draw the diagram, annotate shapes, double-click a block to open its source.

### Non-goals for Milestone 1
- No LLM calls. A right-click menu slot "Ask Claude about this block" is reserved but not implemented.
- No export, no live mode, no non-PyTorch frameworks.
- No browser or local web server. Everything renders in a VS Code Webview panel inside the IDE.

## 2. Architecture overview

Approach: TypeScript extension (UI) + standalone Python analyzer (subprocess), connected by a JSON IR contract.

- The analyzer uses the user's own Python environment, so it can import their real model and get real shapes.
- The IR is a stable contract; later sub-projects (LLM, export, live mode) build on it.
- The analyzer is also usable as a plain CLI.

## 3. IR (intermediate representation)

A tree of nodes plus data-flow edges.

**Node**
- `id`, `name` (e.g. `encoder.layers.0.attn`)
- `kind`: `module` | `op` | `group` (`group` = a helper method called from `forward`, see section 7)
- `type` (e.g. `MultiheadAttention`, `matmul`)
- `children`: expandable sub-nodes (hierarchical granularity)
- `source`: `{file, startLine, endLine}` (used for double-click navigation, and later as LLM context)
- `params`: total parameter count (including frozen parameters), and `trainableParams`: parameters with `requires_grad=True`. The viewer shows both when they differ, e.g. `339K params (75.8K trainable)`.

**Edge**
- `from`, `to`
- `shape`, `dtype` (optional; present only after tracing)
- `uncertain` flag (set when static analysis cannot determine the flow)

**Meta**
- `mode`: `static` | `traced`
- input spec used, analyzer version
- `traceError` (if tracing failed and the IR fell back to static)

Shape is optional so static and traced results share one format; the viewer has a single code path.

## 4. Python analyzer

CLI: input = model location, output = IR JSON. Two stages.

**Stage 1 — static structure (zero config, executes no user code)**
- Use `ast` to find `nn.Module` subclasses, read submodule assignments in `__init__`, build the module nesting tree.
- Read call order in `forward` to infer edges. On `if`, loops, or dynamic calls, mark edges `uncertain` rather than guessing.
- Functional tensor ops in `forward` (e.g. `mean`, `amax`, `torch.cat`) become top-level `op` nodes; helper methods called via `self.` become collapsible group nodes; shape-only ops (`view`, `permute`) are folded into edges by default (see section 7).
- Record `source` line ranges. Output `mode: "static"`.
- Runs automatically; needs only the Python standard library.

**Stage 2 — meta-device tracing (explicit user action only)**
- User specifies entry (e.g. `models.py:MyModel`), optional constructor arguments, and input spec (e.g. `{"x": [1, 3, 224, 224]}`).
- Import the model, construct it on `torch.device("meta")`, attach forward hooks and `torch.fx` / dispatch interception, run one forward with dummy input. No GPU or real memory used.
- Merge per-edge shape/dtype and op-level detail into the Stage 1 tree. Output `mode: "traced"`.
- On failure (missing package, constructor needs weight files, unsupported op): fall back to the Stage 1 result and record the reason in `meta.traceError`. The viewer shows a notice instead of breaking.

**Safety boundary (Stage 2 executes user code):**
- Requires a trusted workspace (VS Code workspace trust).
- Only runs when the user explicitly triggers "Trace Shapes".
- Uses the Python interpreter the user selected.
- Enforces a timeout.
- Stage 1 never executes user code.

## 5. VS Code viewer (TypeScript)

**Components (single responsibility each)**
- **AnalyzerClient**: spawns the Python subprocess, passes args, parses IR JSON. No UI.
- **IR Store**: holds the current IR, notifies the viewer; re-runs Stage 1 on file save.
- **Graph Webview**: the diagram panel. Consumes IR only; unaware of the analyzer.
- **Commands**: "Open Architecture Diagram", "Trace Shapes", "Select Entry Model".

**Rendering**
- Runs only in a VS Code Webview panel (an editor tab inside the IDE). No external browser, no local server.
- Auto layout via an existing library (ELK or dagre); SVG rendering.
- Default view is module level; each node is a block, edges are labeled with shape (e.g. `[B, 197, 768]`).
- If no shape is available (Stage 1 only), edges show no shape and the panel offers a "Trace shapes" prompt.

**Interaction**
- **Single click**: select the block and show details (shape, parameter count, type).
- **Double click**: open the block's source in the editor, jumping to and highlighting `startLine`–`endLine`.
- **Expand/collapse button on the block**: expand to child modules / ops in place; click again to collapse. (A separate button avoids conflict with double-click.)
- **Cursor highlight**: moving the editor cursor highlights the innermost node whose source range contains that line. If a class has several instances in the diagram, all are highlighted. If the node is inside a collapsed block, the nearest visible ancestor is highlighted; the diagram never expands by itself.
- Reserved: right-click menu slot for "Ask Claude about this block" (empty in Milestone 1).

**Error handling**
- Python or torch not found: the panel shows clear guidance; Stage 1 still works (needs only `ast`).
- Analysis failure: show the error with a copyable log; never a blank panel.

## 6. Testing

- Analyzer: snapshot tests on the IR for small sample models (simple CNN, Transformer block, forward with `if`).
- Extension: IR -> graph conversion as pure-function unit tests; a few Webview rendering integration tests.
- Compatibility: develop against the standard VS Code API; during implementation, verify that the extension installs and the Webview renders in Antigravity (not assumed).

## 7. Validation target: Fast-SDE

Milestone 1 is validated against a real paper repo: https://github.com/JiangWAV/FAST-SDE (paper: arXiv 2606.12339, Fig. 2). Model file: `models/fastsde.py`, entry class `SeldNetSubbandFast` (constructor defaults equal the paper's Fast-SDE config), input `wav: [1, 3200]`.

### What this repo forces into the design

Reading the model showed that only part of the paper figure exists as `nn.Module`s:

| Paper block | In the code |
|---|---|
| STFT | `self.STFT` (third-party `torchlibrosa` module) plus inline ops in the helper method `extract_features` |
| Norm | static method `normalize_tensor` (not a module) |
| Subband Split | `self.split` (module) |
| Shared Subband Encoder | `self.enc` (module; contains `proj` + `blocks` of `FastFilterBlock`) |
| Frequency Pooling | inline ops in `forward` (`mean`, `amax`, average) |
| 1x1 Conv1D (BN+PReLU) | `self.fuse` (`nn.Sequential`) |
| Regression Head | **not one module**: `self.gru` + inline temporal pooling + `self.head` |

Resulting requirements:
1. **Functional ops in `forward` appear at the top level**, next to module nodes, not only when a module is expanded. Otherwise Norm, Frequency Pooling and the temporal pooling would be missing.
2. **Helper methods called from `forward`** (`self.extract_features`, `self.normalize_tensor`) become collapsible group nodes named after the method.
3. **Shape-only ops** (`view`, `permute`, `contiguous`, `squeeze`) are folded into the edge by default (the edge shows the shape before and after) so they do not clutter the diagram; a toggle shows them as nodes.
4. **Entry config carries constructor arguments**, not only the input spec (this repo's `__main__` builds a different variant than the defaults).
5. **Branches depending on config or arguments** (`use_gru`, `return_seq`, `info`): Stage 1 marks them `uncertain`; Stage 2 shows only the path actually executed.
6. **Tracing fallback**: if the meta device fails (complex-number ops and third-party modules are a risk here), Stage 2 may retry on CPU with a real dummy tensor. Same trust/timeout rules apply.

### Acceptance criteria

Stage 1 (static, no execution) on `models/fastsde.py`:
- Finds `SeldNetSubbandFast` and its submodules `STFT`, `split`, `enc`, `fuse`, `gru`, `head`; `enc` expands to `proj` and `blocks`, and a `FastFilterBlock` expands to `pw1`, `dw_a`, `dw_b`, `pw2` with the residual add.
- Double-clicking each of these opens the correct line range.

Stage 2 (traced, input `[1, 3200]`, default constructor args) shows these shapes. They are derived by reading the code and must be confirmed by the first real trace:

| After | Shape | Paper notation |
|---|---|---|
| `extract_features` (STFT, features, norm) | `[1, 3, 26, 256]` | 3xTxF |
| `split` | `[1, 8, 3, 26, 32]` | Nx3xTx(F/N) |
| `enc` (input viewed as `[8, 3, 26, 32]`) | `[8, 24, 26, 32]` | NxCxTx(F/N) |
| frequency pooling | `[1, 8, 24, 26]` | NxCxT |
| `fuse` (input viewed as `[1, 192, 26]`) | `[1, 64, 26]` | C_FusexT |
| `gru` | `[1, 26, 96]` | |
| temporal pooling | `[1, 96]` | |
| `head` | `[1, 1]` | |

### Known limit for Milestone 1

The diagram will have the same data flow and shapes as Fig. 2, but **not the same block grouping or names**: "Regression Head", "Frequency Pooling" and "Q-Blocks" are conceptual groupings that do not exist as modules. Milestone 1 shows the true code structure (roughly 14 top-level nodes with shape-only ops folded, because each pooling is three ops: `mean`, `amax`, and the average). Producing the paper-style 7 blocks is the job of sub-project 3 (LLM grouping/naming), and Fig. 2 is its target.

## 8. Future work (informed by this design)

- **Ask Claude about a block**: click a block, ask what it does. The node's `source` range, input/output shapes, and neighbors are sent as context. Needs only the IR already defined here.
- **Edit a block with Claude** (sub-project 6): select a block, right-click "Edit with Claude", enter an instruction (e.g. "change this attention to multi-query").
  - Claude may only modify the block's `source` range, and is instructed to preserve input/output shapes unless the user asks otherwise.
  - The result is shown in VS Code's built-in diff preview and is **never applied automatically**; the user confirms before the file is written.
  - After applying, re-run Stage 1 to refresh the diagram; if shapes were traced before, prompt the user to re-trace to confirm shapes still line up.
  - Manual editing already exists in Milestone 1 (double-click opens the source); this adds AI assistance on top.
  - Shares the Claude client and context-building with "Ask Claude about a block".
- **Auto grouping/naming** of layers into meaningful blocks (e.g. "Encoder Block").
- **Paper export** (SVG/PNG, later draw.io/TikZ).
- **Live mode**: refresh on save, highlight shape mismatches.
