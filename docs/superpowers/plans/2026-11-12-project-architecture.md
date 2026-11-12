# Project Architecture View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One diagram with every main model of the project and its data flow, zoomed to the blocks the active file defines, with role-based block shapes and colours.

**Architecture:** Everything new is TypeScript on top of the existing analyzer commands (`scan`, `static`); the analyzer is not changed. Pure modules build the project graph (`project/projectGraph.ts`), decide looks (`look.ts`), find the active file's blocks (`locate.ts`) and ask the language model for class roles (`llm/roles.ts`). `DiagramController` gains a project mode; the webview draws looks and handles `locate`.

**Tech Stack:** TypeScript, vitest + jsdom, esbuild, ELK (unchanged), `vscode.lm` through the existing `LlmService`.

**Spec:** `docs/superpowers/specs/2026-11-12-project-architecture-design.md`

## Global Constraints

- The analyzer (`analyzer/`) is not modified. Nothing is imported or executed for the project view (static analysis only).
- The language model's output is never trusted: only class names that exist and values from the fixed lists are used.
- At most `MAX_PROJECT_MODELS = 12` main models; at most `MAX_ROLE_CLASSES = 150` classes in the role request; ancestors of at most `MAX_LOCATE_EXPAND = 20` targets are expanded.
- Shapes: `rect`, `rounded`, `trapezoid-narrow`, `trapezoid-wide`, `hexagon`, `circle`. Colours: `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink`, `gray`, `none`.
- Role table (role → shape, colour): encoder → trapezoid-narrow, blue; decoder → trapezoid-wide, green; discriminator → trapezoid-narrow, red; attention → hexagon, purple; sequence → rect, teal; embedding → rounded, yellow; head → rounded, orange; loss → rounded, pink; activation → circle, gray.
- Every user-facing string lives in `extension/src/messages.ts`. Command ids are not renamed.
- `controller.ts`, `look.ts`, `locate.ts`, `project/*`, `llm/*` (except `vscodeLmProvider.ts`) do not import `vscode`.
- Extension version becomes `0.3.0`. Commit messages end with the session's `Co-Authored-By` line.
- Run from `extension/`: one test file `npx vitest run test/<name>.test.ts`; whole suite `npx vitest run`; types `npx tsc --noEmit`.

## Review Focus

1. A button in the diagram (File, Project, Locate) is clicked while the webview has focus: `vscode.window.activeTextEditor` is undefined then. The last Python editor must be used; the user expects the file they were just editing. (Task 7, `lastPython`; manual checklist.)
2. Saving an entry (`saveEntry`) must not delete the user's `"styles"` from `.vscode/code-diagrammer.json`. (Task 2 test.)
3. The same class inside two main models, or two main models in one file: ids stay unique and Locate highlights every occurrence. (Task 1 and Task 4 tests.)
4. Windows / WSL paths: `source.file` and the active file may differ in slashes or drive-letter case; Locate must still match. (Task 4 test, via `normalizePath`.)
5. One model that cannot be analysed (syntax error, timeout) must not hide the others, and cancelling must leave the previous diagram. (Task 5 tests.)

---

### Task 1: Project graph builder

**Files:**
- Create: `extension/src/project/projectGraph.ts`
- Modify: `extension/src/ir.ts`
- Test: `extension/test/projectGraph.test.ts`

**Interfaces:**
- Produces in `ir.ts`:
  - `export type Shape = "rect" | "rounded" | "trapezoid-narrow" | "trapezoid-wide" | "hexagon" | "circle";`
  - `export type Color = "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink" | "gray" | "none";`
  - `export type Look = { role?: string; shape: Shape; color: Color };`
  - `Node.look?: Look`
  - `export type ProjectModelRef = { id: string; name: string; file: string; summary: string };`
  - `Meta.project?: { models: ProjectModelRef[] }`
- Produces in `projectGraph.ts`:
  - `export type ProjectPart = { name: string; file: string; line: number; summary: string; graph: Graph | null };` (`null` = analysis failed)
  - `export const MAX_PROJECT_MODELS = 12;`
  - `export function buildProjectGraph(projectName: string, parts: ProjectPart[]): Graph`
  - `export function modelIdOf(graph: Graph, nodeId: string): string | undefined` — id of the top-level model block that contains `nodeId` (or is it).

- [ ] **Step 1: Write the failing tests** (`projectGraph.test.ts`, graphs built with `g`, `n`, `e` from `test/helpers.ts`)

```ts
const part = (name: string, graph: Graph | null, summary = ""): ProjectPart =>
  ({ name, file: `/ws/${name}.py`, line: 7, summary, graph });
const two = () => g([n("a"), n("b")], [e("$in", "a"), e("a", "b", [1, 2]), e("b", "$out")]);

test("each model becomes a top-level block with prefixed ids and no edges between models", () => {
  const out = buildProjectGraph("proj", [part("Gen", two(), "Makes audio."), part("Disc", two())]);
  expect(out.root).toMatchObject({ id: "root", name: "proj", kind: "group", type: "project", edges: [] });
  expect(out.root.children.map((c) => [c.id, c.name, c.description])).toEqual(
    [["m0/root", "Gen", "Makes audio."], ["m1/root", "Disc", undefined]]);
  expect(out.root.children[0].children.map((c) => c.id)).toEqual(["m0/a", "m0/b"]);
});
test("edge endpoints are prefixed, $in and $out are not; shapes are kept", () => {
  const edges = buildProjectGraph("p", [part("Gen", two())]).root.children[0].edges;
  expect(edges.map((x) => [x.from, x.to, x.shape])).toEqual(
    [["$in", "m0/a", null], ["m0/a", "m0/b", [1, 2]], ["m0/b", "$out", null]]);
});
test("ids are unique across models with equal structure, at every depth", () => { /* nested child inside a; collect all ids; new Set(ids).size === ids.length */ });
test("a failed model is a leaf block pointing at its class", () => {
  const leaf = buildProjectGraph("p", [part("Bad", null)]).root.children[0];
  expect(leaf).toMatchObject({ id: "m0/root", name: "Bad", type: "Bad", kind: "module", children: [],
    source: { file: "/ws/Bad.py", startLine: 7, endLine: 7 } });
});
test("meta: static mode, project model list, entry of the first model", () => {
  const meta = buildProjectGraph("p", [part("Gen", two(), "s")]).meta;
  expect(meta.mode).toBe("static");
  expect(meta.entry).toEqual({ file: "/ws/Gen.py", className: "Gen" });
  expect(meta.project).toEqual({ models: [{ id: "m0/root", name: "Gen", file: "/ws/Gen.py", summary: "s" }] });
});
test("inputs are not mutated", () => { /* JSON snapshot of the part's graph before === after */ });
test("modelIdOf: a nested id, a model id itself, the project root, an unknown id", () => {
  /* "m1/a" → "m1/root"; "m1/root" → "m1/root"; "root" → undefined; "nope" → undefined */
});
```

- [ ] **Step 2: Run** `npx vitest run test/projectGraph.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the `ir.ts` types and `projectGraph.ts`. Prefix is `m<i>/` on every node id of the subtree and on every edge endpoint other than `IN`/`OUT`. `meta` of the result: `{ mode: "static", analyzerVersion: first analysed part's or "", entry: first part, ctorKwargs: null, inputs: null, device: null, traceError: null, project }`. An empty `parts` array is a caller error (throw `Error`).
- [ ] **Step 4: Run** the file again — Expected: PASS. Run `npx tsc --noEmit` — Expected: no output.
- [ ] **Step 5: Commit** `feat: build one graph from the project's main models`

---

### Task 2: Looks (roles, shapes, colours) and style overrides

**Files:**
- Create: `extension/src/look.ts`
- Modify: `extension/src/entryConfig.ts`
- Test: `extension/test/look.test.ts`, `extension/test/entryConfig.test.ts` (extend)

**Interfaces:**
- Consumes: `Look`, `Shape`, `Color`, `Graph`, `Node` from `ir.ts`.
- Produces in `look.ts`:
  - `export const SHAPES: readonly Shape[]`, `export const COLORS: readonly Color[]`
  - `export const ROLE_LOOKS: Record<string, { shape: Shape; color: Color }>` (the table in Global Constraints)
  - `export const MAX_ROLE_NAME = 20;`
  - `export type RoleEntry = { role: string; shape?: string; color?: string };` (unvalidated, as the model or the config gave it)
  - `export type RoleMap = Record<string, Look>;` (class name → look)
  - `export function resolveLook(entry: RoleEntry, invented: Map<string, Look>): Look | undefined` — table role → table look (entry's shape/colour ignored); otherwise an invented role: name trimmed and cut to 20 chars, look taken from `invented` when the name is already there, else built from the entry (`rect` / `none` for a missing or unknown part) and stored in `invented`; empty role name → `undefined`.
  - `export type StyleOverride = { role?: string; shape?: string; color?: string };`
  - `export function overrideLook(o: StyleOverride, base: Look | undefined): { look?: Look; problems: string[] }` — a `role` in the table gives the table look; `shape` / `color` replace that part of (role look ?? base ?? rect/none); unknown values are reported, not applied.
  - `export function isActivation(node: Node): boolean`
  - `export function applyStyles(graph: Graph, roles: RoleMap, overrides: Record<string, StyleOverride>): { graph: Graph; problems: string[] }` — pure; precedence override > existing `node.look` on concept nodes / model role by `node.type` > activation rule > none; applies to `module` and `concept` nodes and activation ops; override keys match `node.type` (and op `name` for activations).
- Produces in `entryConfig.ts`: `export function loadStyles(workspaceRoot: string): Record<string, StyleOverride>` (missing/malformed → `{}`; non-object entries dropped).

- [ ] **Step 1: Write the failing tests**

```ts
// look.test.ts
test("a table role always uses the table's look", () => {
  expect(resolveLook({ role: "encoder", shape: "circle", color: "pink" }, new Map()))
    .toEqual({ role: "encoder", shape: "trapezoid-narrow", color: "blue" });
});
test("an invented role uses the model's shape and colour", () => {
  expect(resolveLook({ role: "vocoder", shape: "hexagon", color: "teal" }, new Map()))
    .toEqual({ role: "vocoder", shape: "hexagon", color: "teal" });
});
test("an invented role with a bad shape or colour falls back per part", () => {
  expect(resolveLook({ role: "x", shape: "star", color: "teal" }, new Map())).toEqual({ role: "x", shape: "rect", color: "teal" });
  expect(resolveLook({ role: "x2", shape: "hexagon" }, new Map())).toEqual({ role: "x2", shape: "hexagon", color: "none" });
});
test("the same invented role keeps its first look", () => {
  const seen = new Map();
  resolveLook({ role: "vocoder", shape: "hexagon", color: "teal" }, seen);
  expect(resolveLook({ role: "vocoder", shape: "circle", color: "red" }, seen)).toMatchObject({ shape: "hexagon", color: "teal" });
});
test("role names are trimmed and cut to 20 characters; an empty one gives nothing", () => { /* " a".repeat(30) → length 20; "  " → undefined */ });
test("isActivation: modules by type, ops by name, trailing underscore, others not", () => {
  /* n("x",{type:"GELU"}) true; op("y","relu") true; op("z","relu_") true; op("s","sigmoid") true;
     n("l",{type:"Linear"}) false; op("a","add") false; n("c",{kind:"concept",type:"concept",name:"relu"}) false */
});
test("applyStyles: model role by class name at every depth", () => { /* two nodes of type Enc, one nested → both look.role === "encoder" */ });
test("applyStyles: activations get the activation look without any role", () => {
  /* op relu → { role: "activation", shape: "circle", color: "gray" } */
});
test("applyStyles: an override wins over the model and over the activation rule", () => {
  /* roles {Enc: encoder look}, overrides {Enc: {role:"decoder"}, relu: {color:"red"}} → Enc decoder look; relu circle/red */
});
test("applyStyles: shape/colour-only override on a class without a role", () => { /* {Blk:{shape:"hexagon"}} → {shape:"hexagon", color:"none"} */ });
test("applyStyles: unknown override values are reported once each and not applied", () => {
  /* {Blk:{shape:"star", color:"blue"}} → look {shape:"rect", color:"blue"}; problems toEqual(['Blk: unknown shape "star"']) */
});
test("applyStyles: a concept node keeps the look it already has; plain nodes get no look; input not mutated", () => {});

// entryConfig.test.ts
test("loadStyles reads the styles object; missing file or wrong type → {}", () => {});
test("saveEntry keeps the styles (and any other top-level key) already in the file", () => {
  /* write {entries:{}, styles:{A:{role:"encoder"}}, other: 1}; saveEntry(...); parsed.styles and parsed.other unchanged */
});
```

- [ ] **Step 2: Run** both files — Expected: FAIL (`look` module missing; `loadStyles` missing; the `saveEntry` test fails because `styles` is dropped).
- [ ] **Step 3: Implement.** Activation module types: `ReLU, ReLU6, LeakyReLU, PReLU, ELU, SELU, GELU, SiLU, Mish, Sigmoid, Tanh, Softmax, LogSoftmax, Softplus, Hardswish, Hardtanh, Hardsigmoid`; op names (after stripping one trailing `_`): `relu, relu6, leaky_relu, prelu, elu, selu, gelu, silu, mish, sigmoid, tanh, softmax, log_softmax, softplus, hardswish, hardtanh, hardsigmoid`. In `entryConfig.ts`, `read` keeps the whole parsed object so `saveEntry` writes every other top-level key back unchanged.
- [ ] **Step 4: Run** both files — Expected: PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat: block looks from roles, activation rule and style overrides`

---

### Task 3: Class roles from the language model; grouping scope

**Files:**
- Create: `extension/src/llm/roles.ts`
- Modify: `extension/src/llm/grouping.ts`
- Test: `extension/test/roles.test.ts`, `extension/test/grouping.test.ts` (extend)

**Interfaces:**
- Consumes: `LlmService.ask`, `extractJson`, `LlmError`, `ScannedClass`, `resolveLook`, `RoleMap`, `ROLE_LOOKS`, `SHAPES`, `COLORS`.
- Produces in `roles.ts`:
  - `export const MAX_ROLE_CLASSES = 150;`
  - `export function rolesPrompt(classes: ScannedClass[]): string` — one line per class `- Name(forward params) — docstring — uses: A, B`; lists the table roles, the shapes and the colours; asks for `{"roles": [{"name", "role", "shape"?, "color"?}]}`; no file paths.
  - `export function parseRoles(text: string, classes: ScannedClass[]): RoleMap` — throws `LlmError("invalid-output")` without a `roles` array; unknown names dropped; first entry per class wins.
  - `export async function classRoles(classes: ScannedClass[], llm: LlmService, opts?: { regenerate?: boolean; signal?: AbortSignal }): Promise<RoleMap>` — candidates first, capped at 150; kind `"roles"`; `{}` for an empty class list (no request); throws `LlmError` otherwise (the caller decides what to show).
- Changes in `grouping.ts`:
  - `Group` gains `look?: Look`; `validateGroups` fills it from an optional `role` / `shape` / `color` on the entry via `resolveLook` (one `invented` map per call); `applyGrouping` copies it to the concept node's `look`; the prompt mentions the optional `role`.
  - `describeGraph`, `validateGroups`, `applyGrouping` take a last optional parameter `scopeId?: string`; `groupGraph`'s options gain `scope?: string`. With a scope the grouped block is the node with that id, then the existing wrapper descent; an unknown id → `LlmError("invalid-output", "Too small to group")`. Concept ids stay `${scopeNode.id}/concept:${i}`.

- [ ] **Step 1: Write the failing tests**

```ts
// roles.test.ts (service() helper as in projectModels.test.ts)
test("prompt lists classes without paths and names the allowed roles, shapes and colours", () => {});
test("parse: table role, invented role with look, unknown class dropped, first entry per class wins", () => {
  /* [{name:"Enc",role:"encoder",shape:"circle"}, {name:"Voc",role:"vocoder",shape:"hexagon",color:"teal"},
      {name:"Ghost",role:"encoder"}, {name:"Enc",role:"decoder"}]
     → { Enc: {role:"encoder",shape:"trapezoid-narrow",color:"blue"}, Voc: {role:"vocoder",shape:"hexagon",color:"teal"} } */
});
test("parse: two classes with the same invented role share the first look", () => {});
test("parse: not JSON / no roles array → LlmError invalid-output", () => {});
test("classRoles: no classes → {} and no request", () => {});
test("classRoles: candidates come first and at most 150 classes are sent", () => { /* 160 classes, the last one candidate → prompt contains it, not class #150 */ });
test("classRoles: a second call is served from the cache; regenerate asks again", () => {});
test("classRoles: no model → LlmError no-model is thrown", () => {});

// grouping.test.ts
test("a group may carry a role: the concept node gets its look", () => {
  /* raw({name:"Stem", description:"d", nodeIds:["a","b"], role:"encoder"}) → paper.root.children[0].look.role === "encoder" */
});
test("scope: only the named block's children are grouped, ids are relative to it", async () => {
  /* project-like graph: root children [m0 (chain inside), m1 (chain inside, ids prefixed differently)];
     groupGraph(graph, llm, noSource, { scope: "m1/root" }) → m0 untouched, m1's children [".../concept:0", "c", ".../concept:1"] */
});
test("scope: an unknown id is refused without a request", async () => {});
```

- [ ] **Step 2: Run** both files — Expected: FAIL (module missing / `look` undefined / scope ignored).
- [ ] **Step 3: Implement.** `scopeOf(graph, scopeId?)` starts from the node with `scopeId` (depth-first search recording the index path) instead of the root.
- [ ] **Step 4: Run** both files, then `npx vitest run` — Expected: all PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat: class roles from the language model; grouping inside a chosen block`

---

### Task 4: Locating the active file

**Files:**
- Create: `extension/src/locate.ts`, `extension/src/webview/viewport.ts`
- Modify: `extension/src/webview/cursor.ts` (re-export `normalizePath` from `locate.ts`, where it moves)
- Test: `extension/test/locate.test.ts`, `extension/test/viewport.test.ts`

**Interfaces:**
- Produces in `locate.ts`:
  - `export function normalizePath(p: string): string` (moved, unchanged)
  - `export const MAX_LOCATE_EXPAND = 20;`
  - `export function locateTargets(graph: Graph, file: string, line: number): string[]` — in diagram (depth-first) order. Candidates = `module` nodes with `source.file` equal to `file` (normalised), excluding the graph root. If any candidate's range contains `line`: the candidates with the smallest such range. Otherwise: candidates that have no candidate ancestor.
  - `export function ancestorsOf(graph: Graph, ids: string[]): string[]` — every proper ancestor id (root excluded) of the first `MAX_LOCATE_EXPAND` ids, no duplicates.
- Produces in `viewport.ts`:
  - `export type Rect = { x: number; y: number; width: number; height: number };`
  - `export function focusBox(box: Rect, viewport: { width: number; height: number }, margin = 80): Rect` — a view box centred on `box`, at least `box + 2·margin` in both directions, at least the viewport's size (never zooms in past 100 %), with the viewport's aspect ratio when the viewport is not 0×0.

- [ ] **Step 1: Write the failing tests**

```ts
// locate.test.ts — graph: root(file m.py 1-99) → enc (type Enc, source enc.py 10-40) → blk1, blk2 (type Blk, source enc.py 50-60); dec (source dec.py 1-9)
test("cursor inside a class: every block of that class", () => { /* (enc.py, 55) → ["blk1","blk2"] */ });
test("cursor inside the outer class picks it, not the nested ones", () => { /* (enc.py, 12) → ["enc"] */ });
test("cursor outside any class: the outermost blocks the file defines", () => { /* (enc.py, 45) → ["enc"] */ });
test("a file no block comes from → []", () => {});
test("the graph root is never a target", () => { /* (m.py, 5) → [] */ });
test("ops and groups are not targets", () => {});
test("paths match across slashes and drive-letter case", () => { /* source "C:\\ws\\enc.py", asked "c:/ws/enc.py" */ });
test("the same class in two models of a project graph: both, in diagram order", () => {});
test("ancestorsOf: parents of the targets without the root, deduplicated, first 20 targets only", () => {});

// viewport.test.ts
test("a small box is centred and the view is not smaller than the viewport", () => {
  expect(focusBox({ x: 100, y: 100, width: 50, height: 20 }, { width: 800, height: 400 }))
    .toEqual({ x: -275, y: -90, width: 800, height: 400 });
});
test("a big box gets the margin and the viewport's aspect ratio", () => {
  const v = focusBox({ x: 0, y: 0, width: 2000, height: 300 }, { width: 800, height: 400 });
  expect(v.width).toBe(2160); expect(v.height).toBe(1080);
  expect(v.x + v.width / 2).toBe(1000); expect(v.y + v.height / 2).toBe(150);
});
test("a 0×0 viewport (not laid out yet) still returns box plus margin", () => {
  expect(focusBox({ x: 10, y: 10, width: 100, height: 40 }, { width: 0, height: 0 })).toEqual({ x: -70, y: -70, width: 260, height: 200 });
});
```

- [ ] **Step 2: Run** both files — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** both modules; `cursor.ts` imports `normalizePath` from `../locate` and re-exports it.
- [ ] **Step 4: Run** `npx vitest run` — Expected: all PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat: find the blocks the active file defines`

---

### Task 5: Controller project mode and protocol

**Files:**
- Modify: `extension/src/controller.ts`, `extension/src/protocol.ts`, `extension/src/messages.ts`
- Test: `extension/test/controller.test.ts` (extend; reuse its `setup` / `gated` helpers)

**Interfaces:**
- Consumes: `buildProjectGraph`, `ProjectPart`, `MAX_PROJECT_MODELS`, `modelIdOf`, `applyStyles`, `RoleMap`, `StyleOverride`, `locateTargets`, `ScannedClass`, `ProjectModel`.
- `protocol.ts`:
  - `HostMessage` adds `{ type: "locate"; ids: string[] }`.
  - `WebviewMessage` adds `{ type: "switchView"; view: "file" | "project" }`, `{ type: "locate" }`, `{ type: "openModel"; file: string; className: string }`; `requestPaper` gains `scopeId?: string`.
- `controller.ts`:
  - `AnalyzerClientLike` adds `"scan"`.
  - `Host` adds:
    - `pickModels(classes: ScannedClass[], signal: AbortSignal): Promise<{ models: ProjectModel[]; note?: string }>` (may throw `LlmError("cancelled")`)
    - `roles(classes: ScannedClass[], signal: AbortSignal): Promise<RoleMap>` (never throws for model problems: returns the saved roles or `{}`; rethrows only `cancelled`)
    - `savedRoles(): RoleMap`
    - `styles(): Record<string, StyleOverride>`
  - `Host.group` options gain `scope?: string`.
  - `async openProject(active: { file: string; line: number } | undefined, signal: AbortSignal): Promise<void>`
  - `locate(active: { file: string; line: number } | undefined): void` — posts `locate` for the current graph; in project mode with no target also posts the info notice `M.NOT_IN_PROJECT`.
  - `get isProject(): boolean`
  - `requestPaper(regenerate = false, scopeId?: string)`.
- `messages.ts` adds: `PROJECT_SCANNING = "Code Diagrammer: analysing the project…"`, `NOT_IN_PROJECT = "This file is not part of any main model."`, `MODELS_FAILED = (list: string) => "Could not analyse: " + list + "."`, `STYLE_PROBLEMS = (list: string) => "Ignored in \"styles\": " + list + "."`, `PROJECT_INFO = "Showing structure only. Open a model on its own to trace tensor shapes."`. `NO_PROJECT_MODELS` is reused for zero candidates.

**Behaviour of `openProject`:** `begin()` a token; `client.scan(root)` (failure → `fail`); `host.pickModels` (candidates empty → warn `NO_PROJECT_MODELS`); the first 12 models; `client.analyzeStatic` for each in order, stopping when `signal.aborted` or the token is stale; all failed → `fail` with the first error; `host.roles(classes, signal)`; `buildProjectGraph(basename(root), parts)`; `applyStyles(graph, roles, host.styles())`; then exactly as a successful `analyze` does: `cancelPaper()`, `file = undefined`, project mode on, `_graph` set, post `graph`; one notice by priority: failed models (warn, `MODELS_FAILED("A (syntax), B (timeout)")`) > the model list's `note` (warn) > style problems (warn) > `PROJECT_INFO` (info); then `locate(active)`. A cancelled or stale request posts nothing. No cached-paper offer in project mode.

**Other changes:** `analyze` and `traceShapes` pass their graph through `applyStyles(graph, host.savedRoles(), host.styles())` before storing and posting it (style problems do not replace their notices). `onFileSaved` in project mode: when the saved file is shown in the graph, `openProject(lastActive, new AbortController().signal)`. `requestPaper` in project mode passes `scope: scopeId ?? first model id` to `host.group`; in file mode `scopeId` is ignored. `traceShapes` / `selectEntry` already return early without `file`.

- [ ] **Step 1: Write the failing tests** (fake client `scan` returns two candidates `Gen` in `gen.py`, `Disc` in `disc.py`; `analyzeStatic` returns a small graph per entry, with `source.file` of one inner module = `blocks.py`)

```ts
test("openProject posts one graph with both models, the info notice and a locate", async () => {
  /* posts: graph (root.children ids ["m0/root","m1/root"], meta.project.models names ["Gen","Disc"]),
     notice info PROJECT_INFO, locate { ids: [...] } for active { file: blocks.py, line: 1 } (non-empty) */
});
test("the active file is in no model: locate has no ids and the notice says so", async () => { /* last notice text === M.NOT_IN_PROJECT */ });
test("no active file: graph, info notice, locate with no ids, no NOT_IN_PROJECT", async () => {});
test("one model fails: the graph still has both blocks, the failed one is a leaf, a warning names it", async () => {
  /* notice level warn, text M.MODELS_FAILED("Disc (syntax)") */
});
test("every model fails: no graph is posted, the analysis-failed notice is", async () => {});
test("scan fails: no graph, analysis-failed notice; python-not-found keeps its action", async () => {});
test("no candidates: warn NO_PROJECT_MODELS, no graph", async () => {});
test("more than 12 models: only the first 12 are analysed", async () => {});
test("the model list's note is shown when no model failed", async () => {});
test("aborting between two analyses posts nothing and analyses nothing further", async () => {});
test("a newer request makes an older project request stale", async () => {});
test("roles and style overrides are applied to the project graph", async () => {
  /* host.roles → { Gen: encoder look }; host.styles → { Disc: { role: "discriminator" } } → looks on m0/root and m1/root */
});
test("style problems are reported when nothing more important is", async () => { /* styles { Gen: { shape: "star" } } → warn STYLE_PROBLEMS('Gen: unknown shape "star"') */ });
test("file view: saved roles and overrides are applied to the graph of open() and traceShapes()", async () => {});
test("project mode: requestPaper passes the scope, defaulting to the first model", async () => {
  /* requestPaper(false, "m1/root") → host.group opts.scope === "m1/root"; requestPaper() → "m0/root" */
});
test("project mode: saving a file a model shows rebuilds the project; another file does not", async () => {});
test("project mode: traceShapes and selectEntry do nothing", async () => {});
test("locate() in file mode posts the targets and no notice", async () => {});
test("opening a file after a project leaves project mode", async () => { /* isProject false; onFileSaved analyses the file again */ });
```

- [ ] **Step 2: Run** `npx vitest run test/controller.test.ts` — Expected: FAIL (`openProject` is not a function; existing tests still pass after the fake host gains the new members).
- [ ] **Step 3: Implement** as described above.
- [ ] **Step 4: Run** `npx vitest run` — Expected: all PASS; `npx tsc --noEmit` reports errors only in `extension.ts` (the `Host` object lacks the new members) — those are fixed in Task 7; add the four members there now as the minimal stubs that Task 7 replaces only if needed to keep `tsc` clean (`pickModels`/`roles` wired for real in Task 7).
- [ ] **Step 5: Commit** `feat: project mode in the diagram controller`

---

### Task 6: Webview — looks, locate, view switches

**Files:**
- Modify: `extension/src/webview/render.ts`, `view.ts`, `main.ts`, `style.css`, `extension/src/graphPanel.ts`
- Test: `extension/test/render.test.ts` (create if absent, else extend), `extension/test/main.test.ts`, `extension/test/view.test.ts` (extend)

**Interfaces:**
- Consumes: `Node.look`, `Meta.project`, `HostMessage.locate`, the new `WebviewMessage`s, `ancestorsOf`, `focusBox`, `modelIdOf`.
- `render.ts`: `export function shapeElement(look: Look | undefined, kind: VNode["kind"], expanded: boolean, box: Rect): SVGElement` — always has class `shape`. Collapsed with a look: `rounded` → `rect` with `rx = height / 2`; `trapezoid-narrow` → `polygon` `x,y  x+w,y+0.2h  x+w,y+0.8h  x,y+h`; `trapezoid-wide` → the mirror image; `hexagon` → `polygon` with inset `min(14, w / 5)`; `circle` → `ellipse`; `rect` and every expanded block → today's `rect`. The node group gets class `look-<color>` when the colour is not `none`. `renderDetails` shows a `Role` row when `look.role` is set.
- `graphPanel.ts` toolbar: buttons `#viewFile` / `#viewProject` (segmented, labels `File` / `Project`), `#viewCode` / `#viewPaper` keep their ids with labels `Blocks` / `Stages`, `#locate` (label `Locate`); panel title `Architecture: project` for a project graph.
- `main.ts`:
  - a graph with `meta.project` is a project graph: title = root name + `" · N models"`; `#trace` hidden, `#locate` shown, `#viewProject` pressed; otherwise the reverse. A change between project and file graph refits and clears per-mode expansion.
  - `locate` message: `located = ids`; add `ancestorsOf(graph, ids)` to the current mode's expanded set; render; then set the view box to `focusBox(box of ids[0], svg client size)`; with no ids, `fit()`. Highlight: the cursor targets when there are any, else `located`.
  - a `cursor` message only changes the highlight.
  - `#viewFile` / `#viewProject` send `switchView`; `#locate` sends `locate`.
  - Stages request carries `scopeId` in a project graph: `modelIdOf(graph, selectedId)` ?? `modelIdOf(graph, located[0])` ?? first model id.
  - context menu on a top-level model block of a project graph has `Open as single model` → `openModel` with that model's `file` and `name` from `meta.project.models`.
- `style.css`: `--look-<color>` variables with values for `body.vscode-light` and `body.vscode-dark` / `vscode-high-contrast`; `.node.look-<color> > .shape` gets the colour as stroke and a tinted fill (`color-mix` with the editor background); `.selected` and `.cursor` outlines still win (declared after the look rules); `[hidden]` toolbar buttons are not displayed.

- [ ] **Step 1: Write the failing tests**

```ts
// render.test.ts
test("each shape draws the right element inside the box", () => {
  /* box {x:10,y:20,width:100,height:40}; trapezoid-narrow → polygon points "10,20 110,28 110,52 10,60";
     trapezoid-wide → "10,28 110,20 110,60 10,52"; hexagon → polygon with 6 points, first "24,20";
     circle → ellipse cx 60 cy 40 rx 50 ry 20; rounded → rect rx 20; rect → rect rx 6; all have class "shape" */
});
test("an expanded block is a rectangle whatever its look, and keeps the colour class", () => {});
test("renderDiagram puts look-<color> on the node group; none adds no class", () => {});
test("details show the role", () => {});
// main.test.ts
test("locate expands the ancestors, highlights the targets and does not fit to the whole diagram", async () => {
  /* nested graph; post locate {ids:["deep"]} → until ids() includes "deep"; g.node[data-id=deep] has class cursor */
});
test("a cursor message alone does not expand anything", async () => {});
test("locate with no ids keeps the expansion and fits", async () => {});
test("a project graph hides Trace, shows Locate and presses Project", () => {});
test("File / Project / Locate buttons send switchView and locate", () => {});
test("Stages in a project graph sends the selected block's model as scopeId; without a selection the first model", () => {});
test("the model block's context menu offers Open as single model and sends openModel", () => {});
test("the view switch is labelled Blocks and Stages", () => {});
```

- [ ] **Step 2: Run** the three files — Expected: FAIL.
- [ ] **Step 3: Implement.** The toolbar HTML that `main.test.ts` builds must be taken from the same source as `graphPanel.ts` if the test already does so; otherwise update the test's copy of the toolbar together with `graphPanel.ts`.
- [ ] **Step 4: Run** `npx vitest run` — Expected: all PASS; `npx tsc --noEmit` clean (apart from Task 7's glue if stubs were not added).
- [ ] **Step 5: Commit** `feat: role shapes and colours, locate and project switch in the diagram`

---

### Task 7: Extension glue, manifest, README, package

**Files:**
- Modify: `extension/src/extension.ts`, `extension/package.json`, `extension/README.md`, `extension/test/manifest.test.ts`
- Create: nothing

**Interfaces:**
- Consumes everything above; `classRoles`, `projectModels`, `loadStyles`.
- `package.json`: version `0.3.0`; command `codeDiagrammer.openProject` titled `Code Diagrammer: Open Project Architecture`; `codeDiagrammer.togglePaperView` title becomes `Code Diagrammer: Toggle Stages View`.
- `extension.ts`:
  - `lastPython: { file: string; line: number } | undefined`, updated from `onDidChangeTextEditorSelection` and `onDidChangeActiveTextEditor` for Python files in a workspace folder; used whenever `activeTextEditor` is not such a file.
  - `open(context, file?: string)`: the explicit file, else the active Python editor, else `lastPython`.
  - `openProject(context)`: folder of the active/last Python file, else the first workspace folder (`M.NO_WORKSPACE` otherwise); creates the panel, host and controller like `open`; runs `controller.openProject(lastPython-or-active, signal)` inside a cancellable `withProgress` notification titled `M.PROJECT_SCANNING`.
  - Host members: `pickModels` → `projectModels(classes, root, llm, { signal })`; `roles` → `classRoles` then write `<root>/.code-diagrammer/roles.json`; on an `LlmError` other than `cancelled`, return `savedRoles()`; `savedRoles` reads that file (`{}` when missing or malformed); `styles` → `loadStyles(root)`; `group` passes `scope`.
  - Messages: `switchView` → `openProject(context)` / `open(context)`; `locate` → `controller.locate(lastPython)`; `openModel` → save the entry for that class if it differs, then `open(context, file)`; `requestPaper` passes `scopeId`.
- README: section "Project architecture" (what it shows, Locate, shapes and colours table, `"styles"` example, what is sent for roles), `Paper` renamed to `Stages`, manual checklist extended with: project view on a real project; Locate from the diagram while the webview has focus; File/Project buttons; a model that fails to analyse; `styles` override; light and dark theme colours; Antigravity WSL window.

- [ ] **Step 1: Write the failing test** in `manifest.test.ts`

```ts
test("the project command is contributed and the version is 0.3.0", () => {
  /* commands include codeDiagrammer.openProject with title "Code Diagrammer: Open Project Architecture";
     togglePaperView title "Code Diagrammer: Toggle Stages View"; version "0.3.0" */
});
```

- [ ] **Step 2: Run** `npx vitest run test/manifest.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the glue, manifest and README.
- [ ] **Step 4: Run** `npx vitest run` (Expected: all PASS), `npx tsc --noEmit` (Expected: no output), `npm run build` (Expected: `built dist/ and python/`), `npx vsce package --no-dependencies` (Expected: `Packaged: …code-diagrammer-0.3.0.vsix`). From the repository root: `.venv/Scripts/python -m pytest analyzer -q` (Expected: 68 passed — the analyzer is untouched).
- [ ] **Step 5: Commit** `feat: Open Project Architecture command; 0.3.0`
