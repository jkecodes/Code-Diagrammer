# Project architecture view (sub-project 4)

Builds on `2026-11-11-code-diagrammer-design.md` (Milestone 1) and `2026-11-11-llm-grouping-design.md` (sub-project 3). The IR stays the single source of truth.

## 1. Goal

The user opens any Python file of a project and asks for the project's architecture. They see every main model of the project in one diagram, each with its data flow, and the view is zoomed to the part that the open file defines.

What the user said: "分析整個 project 的架構，分析完再放大檢視到現在開的檔案的部分", with the data flow of the main models (not a class-composition chart), and all main models in one diagram.

Non-goals in this version: tensor shapes in the project view, edges between main models (e.g. generator → discriminator; that wiring lives in training code), tracing from the project view, multi-root workspaces (the folder of the active file is used, as Scan does today).

## 2. What the user sees

- Command `Code Diagrammer: Open Project Architecture`, and a `File | Project` switch in the diagram header. `File` is today's single-model diagram of the active file; `Project` is the new view. Both live in the same panel.
- The project diagram's top level has one block per main model, in the order the model list gives, laid out side by side with no edges between them. A model block shows the class name and file; its details panel shows the language model's one-sentence summary when there is one.
- Expanding a model block shows its forward data flow, exactly as the File view of that class would in static mode: nested modules can be expanded further, across files. Double-click opens the source, as today.
- **Locate.** When the project view opens, the diagram expands down to, highlights and zooms to the blocks that the active file defines (section 4). A `Locate` button repeats this for the file that is active now. Switching editors only moves the highlight; it never changes zoom or expansion on its own.
- If the active file defines no block of any main model: the whole diagram is shown fitted, with the notice "This file is not part of any main model."
- Model blocks have an "Open as single model" action that opens the existing File view for that class (where Trace Shapes is available).
- While the project is being analysed a cancellable progress notification is shown, like Scan.

## 3. Building the project graph

1. `scan` the workspace folder (exists).
2. `projectModels` picks the main models (exists; at most 12 are used). Without a language model, with declined consent or on a provider error, the plain candidate list is used, capped at 12, and its note is shown as a notice. The model list is cached as today.
3. For each main model, run the existing **static** analysis of `(file, className)`. Nothing is imported or executed. These run one after another through the existing analyzer client; a cancelled request stops the remaining ones.
4. `buildProjectGraph(parts)` (TypeScript, pure) combines them:
   - root: a synthetic node, `kind: "group"`, `type: "project"`, name = workspace folder name, no edges;
   - child *i*: model *i*'s static root node, with every id in its subtree (and every edge endpoint except `$in`/`$out`) prefixed `m<i>/` so ids stay unique;
   - `meta.mode = "static"`, `meta.entry` = the first model's entry, plus `meta.project = { models: [{ id, name, file, summary }] }`. A graph with `meta.project` is a project graph; everything else treats it as an ordinary graph.
5. A model whose static analysis fails becomes a leaf block (no children) and the failures are listed in one warning notice ("Could not analyse: A (syntax), B (…)"). The view fails as a whole only when scan fails or no model could be analysed.

The project graph is rebuilt when a source file of any of its models is saved (the same rule the File view uses for its own sources), with the same stale-request handling as today.

## 4. Locating the active file

Module blocks whose class is defined in the workspace already carry that class's definition range as `source`.

- Targets = blocks whose `source.file` is the active file and whose range contains the cursor line; if the cursor is in no such block, all blocks whose `source.file` is the active file and that are not inside another such block.
- `locate` expands every ancestor of each target, highlights the targets with the existing cursor highlight, and fits the viewport to the first target in diagram order with some margin (never zooming in beyond 100 %).
- A class used many times (e.g. a block repeated in every stage) highlights every occurrence; expansion is limited to the ancestors of the first 20 targets so a huge model does not explode.
- Pure function `locateTargets(graph, file, line): string[]` in the webview's cursor module; the host sends `{ type: "locate", file, line }`.

## 5. Stages (the former "Paper" view)

- The `Code | Paper` switch is renamed `Blocks | Stages` in the UI and README; commands keep their ids, the title becomes "Toggle Stages View". Behaviour in the File view is unchanged.
- `groupGraph` gains an optional scope: the id of the block whose children are grouped (default: today's rule, root with wrapper descent). The wrapper descent applies from the scope.
- In the Project view, `Stages` applies to **one** main model: the one containing the selected block, else the one containing the located blocks, else the first. Its block is replaced by the grouped version in place; other models are untouched. One request per model, cached per model as today. Choosing `Blocks` restores the ungrouped project graph.

## 6. Roles: block shapes and colours

Papers draw blocks by role (an encoder narrows, a decoder widens, discriminators such as MPD/MSD are trapezoids). Blocks get a **role**; each role has a fixed shape and colour.

| role | shape (flow runs left → right) | colour |
|---|---|---|
| `encoder` | trapezoid, narrowing to the right | blue |
| `decoder` | trapezoid, widening to the right | green |
| `discriminator` | trapezoid, narrowing to the right | red |
| `attention` | hexagon | purple |
| `sequence` (RNN, state-space, Mamba, transformer stack) | rectangle | teal |
| `embedding` | rounded rectangle | yellow |
| `head` (classifier, regression, output projection) | rounded rectangle | orange |
| `loss` | rounded rectangle | pink |
| `activation` | circle | gray |
| `other` / none | rectangle (today's look) | none |

- **Who decides.** Roles are assigned per **class name**, so every block of that class looks the same at any depth and in both views. One language-model request per project: the workspace classes found by `scan` (name, docstring, submodule types, forward parameters; at most 150, main models first) → JSON `{"roles": [{"name": "ClassName", "role": "encoder"}]}`. Validation in code: unknown class names and roles outside the table are dropped; a class listed twice keeps its first role. Cached like every other request; uses the same consent.
- **Activations.** Activation functions are always their own block with the `activation` role, decided by rule, not by the language model: torch activation modules (`ReLU`, `LeakyReLU`, `PReLU`, `ELU`, `SELU`, `GELU`, `SiLU`, `Mish`, `Sigmoid`, `Tanh`, `Softmax`, `LogSoftmax`, `Softplus`, `Hardswish`, `Hardtanh`, `Hardsigmoid`, `ReLU6`) and the function or tensor-method ops of the same names (`F.relu`, `torch.sigmoid`, `x.tanh()`, …). This works without a language model. An override for one of these names still wins.
- **When.** The request is made while the Project view is built (after the model list). The File view only uses roles already cached for the workspace; it never asks on its own. Stage blocks (section 5) may carry an optional `role` per group in the grouping answer, validated against the same table.
- **Overrides.** `.vscode/code-diagrammer.json` gains `"styles": { "MultiPeriodDiscriminator": { "role": "discriminator" }, "MyBlock": { "shape": "trapezoid-wide", "color": "purple" } }`. An entry may give a `role`, or a `shape` and/or `color`; overrides always win over the language model, and work without any language model. Shapes: `rect`, `rounded`, `trapezoid-narrow`, `trapezoid-wide`, `hexagon`, `circle`. Colours: `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink`, `gray`, `none`. Unknown values are ignored and reported in one warning notice.
- **Applying.** A pure function `applyStyles(graph, roles, overrides)` sets an optional `look: { role?, shape, color }` on module and concept nodes, and on activation ops. The analyzer and the IR it produces are unchanged.
- **Drawing.** The shape is drawn inside the block's existing layout box, so layout does not change. Collapsed blocks get the shape and a tinted fill; expanded blocks keep a rectangular frame with a tinted border and title. Ops other than activations keep today's look. Colours are theme variables with light and dark values; text contrast must hold in both. Selection and cursor highlights still show on shaped blocks. The details panel shows "Role".
- Without a language model and without overrides, only activations look different from today.

## 7. Errors

- No workspace folder, Python not found, scan failure: the same notices and actions as Scan/Open today; the last good diagram stays.
- Zero candidates: notice "No PyTorch models found in this folder."
- Cancelling the progress leaves the panel as it was.

## 8. Testing

- `buildProjectGraph`: id prefixing (nodes and edges, `$in`/`$out` untouched), no id collisions between two models with equal structure, failed model → leaf, `meta.project` contents, inputs not mutated.
- `locateTargets`: cursor inside a class; cursor outside any class; class used several times; file with no block; nested classes of the same file (outermost only).
- Webview: `locate` expands ancestors and fits; a cursor message alone does not change expansion or zoom; `File | Project` switch requests the right view; the "not part of any main model" notice.
- Controller: project request posts progress → graph → locate; one model failing still posts a graph plus a warning; stale and cancelled requests post nothing; a save of a model's source file rebuilds; `Stages` in the project view groups only the chosen model.
- Analyzer client: static analysis of two classes in sequence on the existing fixtures.
- Roles: parsing and validation of the role answer (unknown class, unknown role, duplicate); override parsing (role, shape/colour, unknown values → warning); `applyStyles` precedence (override > model > none), same class at several depths, concept nodes, activation modules and activation ops get the `activation` look without any model answer, input not mutated; rendering of each shape inside the layout box, tinted expanded frame, highlight classes still applied; File view uses cached roles and sends no request.
- **Not testable automatically:** layout quality with many large models, whether a live model's roles are sensible, how the shapes and colours look in real light and dark themes, performance on a real project (twelve static analyses in a row), behaviour in Antigravity/WSL. These go to the README manual checklist.

## 9. Open items for the user

- Twelve models and twenty expanded targets are guesses; both are constants.
- Tensor shapes in the project view would need each model's input configuration; left for a later version.
- The role table (names, shapes, colours) is a first proposal and is easy to change before implementation.
