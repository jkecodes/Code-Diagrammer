# LLM Project Scan and Paper-Style Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a language model exposed by the IDE (Claude or Gemini via `vscode.lm`) list a project's main models and group one model's diagram into named, paper-style concept blocks.

**Architecture:** The Python analyzer gains a static `scan` command. The extension gains an `LlmProvider` interface (one implementation over `vscode.lm`), an `LlmService` (consent, cache, model choice), and two pure features on top: `projectModels` (pick + describe main models) and `grouping` (validate the model's groups, then transform the IR into a "paper view" graph). The model only ever returns names and node ids; edges and shapes always come from the IR.

**Tech Stack:** Python `ast` (analyzer), TypeScript, VS Code API (`vscode.lm`), vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-11-11-llm-grouping-design.md` (builds on `2026-11-11-code-diagrammer-design.md`).

## Global Constraints

- The only provider is `vscode.lm`. No API keys, no network code of our own.
- The model's output is never trusted: every id, name and file is validated against the IR / scan result; shapes and edges are never taken from it.
- A failure of any LLM step never replaces the last good view; without a model everything from Milestone 1 keeps working.
- `scan` must not import torch or execute user code.
- Nothing is sent to a model before the one-time consent ("Class signatures and code excerpts will be sent to <model>.") is accepted for the workspace.
- Cache lives in `<workspace>/.code-diagrammer/cache/`, key = SHA-256 of (kind, model id, prompt). `.gitignore` is not modified.
- No `vscode` import outside `extension.ts`, `graphPanel.ts` and `vscodeLmProvider.ts` (keeps everything else unit-testable).
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Test commands: `.venv/Scripts/python -m pytest analyzer -q` (repo root) and `npx vitest run` (in `extension/`).

## Review Focus

1. The model wraps its JSON in prose or a ``` fence, or returns two JSON objects → the first balanced object is parsed; anything else counts as invalid output (retry once for grouping).
2. A group that is connected but would create a cycle once collapsed (A → x → A, x outside the group) → dropped, so the paper view stays a DAG.
3. The graph changes (file saved, shapes traced) while a grouping request is in flight → the stale grouping is discarded, never applied to the newer graph.
4. A workspace with a file that has a syntax error or a non-UTF-8 byte → `scan` skips that file and still returns the others.
5. The chosen model id is no longer offered by the IDE → falls back to the first available model and says which one was used; no models at all → "No language model available" notice, candidates still listed.

## File Structure

| File | Responsibility |
|---|---|
| `analyzer/code_diagrammer/scan.py` (new) | Workspace-wide static list of module classes and candidates |
| `analyzer/code_diagrammer/cli.py` | `scan` command |
| `extension/src/llm/provider.ts` (new) | `LlmProvider`, `LlmModel`, `LlmError` |
| `extension/src/llm/vscodeLmProvider.ts` (new) | `vscode.lm` implementation (only file besides glue that imports `vscode`) |
| `extension/src/llm/service.ts` (new) | `LlmService`: model choice, consent, cache, `extractJson` |
| `extension/src/llm/projectModels.ts` (new) | Prompt + validation for the main-model list |
| `extension/src/llm/grouping.ts` (new) | Graph description, prompt, `validateGroups`, `applyGrouping` |
| `extension/src/controller.ts`, `protocol.ts`, `ir.ts`, `messages.ts`, `extension.ts`, `package.json` | Wiring: commands, paper-view flow |
| `extension/src/webview/main.ts`, `view.ts`, `style.css` | View toggle, concept node look |

---

### Task 1: `scan` command in the analyzer

**Files:**
- Create: `analyzer/code_diagrammer/scan.py`, `analyzer/tests/test_scan.py`, `analyzer/tests/fixtures/scanproj/{models.py,blocks.py,broken.py,latin1.py,train.py}`
- Modify: `analyzer/code_diagrammer/cli.py`, `extension/src/analyzerClient.ts`, `extension/src/ir.ts`, `extension/test/analyzerClient.test.ts`

**Interfaces:**
- Consumes: `TemplateIndex(workspace_root)`, `TemplateIndex.file_info`, `TemplateIndex.is_module_class`, `TemplateIndex.get(file, cls).submodules` (existing).
- Produces:
  - Python `scan_workspace(root: str) -> list[dict]`, each `{"name", "file" (absolute), "line", "forwardParams": [str], "docstring": str (first paragraph, ≤300 chars, "" if none), "submoduleTypes": [str] (workspace + nn type names, deduped, declaration order), "candidate": bool}`.
  - CLI: `{"command": "scan", "workspaceRoot": ...}` → `{"ok": true, "classes": [...]}`.
  - TS: `type ScannedClass = { name: string; file: string; line: number; forwardParams: string[]; docstring: string; submoduleTypes: string[]; candidate: boolean }` in `ir.ts`; `AnalyzerClient.scan(workspaceRoot: string): Promise<Result<ScannedClass[]>>`.

Fixtures: `blocks.py` defines `Block(nn.Module)` (has forward) and `Unused(nn.Module)` without `forward`; `models.py` imports `Block` and defines `Net(nn.Module)` with docstring `"""A tiny net.\n\nMore text."""`, `self.block = Block()`, `self.fc = nn.Linear(4, 2)`, `forward(self, x, mask=None)`; `train.py` has a non-module class `Trainer`; `broken.py` is `class X(:`; `latin1.py` contains the byte `0xE9` in a comment and a module `Latin(nn.Module)` with forward.

- [ ] **Step 1: Write the failing tests** in `test_scan.py`:

```python
def by_name(root=SCANPROJ):
    return {c["name"]: c for c in scan_workspace(str(root))}

def test_lists_module_classes_across_files_and_skips_other_classes():
    assert set(by_name()) == {"Block", "Unused", "Net"} | ({"Latin"} if "Latin" in by_name() else set())
    assert "Trainer" not in by_name() and "X" not in by_name()

def test_candidate_has_forward_and_is_nobodys_submodule():
    c = by_name()
    assert c["Net"]["candidate"] is True
    assert c["Block"]["candidate"] is False      # used by Net
    assert c["Unused"]["candidate"] is False     # no forward

def test_class_details():
    net = by_name()["Net"]
    assert net["forwardParams"] == ["x", "mask"]
    assert net["docstring"] == "A tiny net."
    assert net["submoduleTypes"] == ["Block", "Linear"]
    assert os.path.isabs(net["file"]) and net["line"] > 0

def test_unreadable_files_are_skipped():      # broken.py, latin1.py must not raise
    assert "Net" in by_name()

def test_ignored_directories(tmp_path):       # .venv, node_modules, __pycache__, .git, hidden dirs
    (tmp_path / ".venv").mkdir(); (tmp_path / ".venv" / "m.py").write_text(MODULE_SRC)
    (tmp_path / "ok.py").write_text(MODULE_SRC)
    assert [c["file"] for c in scan_workspace(str(tmp_path))] == [str(tmp_path / "ok.py")]

def test_cli_scan():
    out = call({"command": "scan", "workspaceRoot": str(SCANPROJ)})
    assert out["ok"] and any(c["name"] == "Net" and c["candidate"] for c in out["classes"])
```

- [ ] **Step 2:** Run `.venv/Scripts/python -m pytest analyzer/tests/test_scan.py -q`. Expected: FAIL (`No module named 'code_diagrammer.scan'`).
- [ ] **Step 3: Implement `scan_workspace`.** Walk `root` with `os.walk`, pruning directory names starting with `.` and `{"node_modules", "__pycache__", "venv", "env", "build", "dist", "site-packages"}`; at most 2000 `.py` files (sorted paths, deterministic). For each file use `TemplateIndex.file_info` inside `try/except (StaticError, OSError, UnicodeDecodeError, ValueError)` → skip. A class is listed when `index.is_module_class(info, name)`. `submoduleTypes` from `index.get(file, name).submodules` type names; a class is "used" when its name appears as a resolved workspace submodule type of another listed class. Add the `scan` branch to `cli.handle`.
- [ ] **Step 4:** Run the same command. Expected: PASS. Then the full analyzer suite. Expected: all pass (59 existing + new).
- [ ] **Step 5: TS client.** Add `ScannedClass` and `scan`; test in `analyzerClient.test.ts`:

```ts
test("scans a workspace", async () => {
  const r = await make().scan(path.join(fixtures, "scanproj"));
  expect(r.ok && r.value.filter((c) => c.candidate).map((c) => c.name)).toEqual(["Net"]);
});
```
(If `Latin` is listed as a candidate on this platform, the fixture's `latin1.py` must be made undecodable as UTF-8 so it is skipped — the expectation `["Net"]` is the contract.) Run `npx vitest run test/analyzerClient.test.ts`: FAIL first (no `scan`), then PASS.
- [ ] **Step 6: Commit** `feat: scan command lists module classes of a workspace`.

---

### Task 2: LLM provider, service, cache, consent

**Files:**
- Create: `extension/src/llm/provider.ts`, `extension/src/llm/service.ts`, `extension/src/llm/vscodeLmProvider.ts`, `extension/test/llmService.test.ts`, `extension/test/fakeProvider.ts`
- Modify: `extension/package.json` (setting `codeDiagrammer.llm.model`, string, default `""`; command `codeDiagrammer.chooseModel` "Code Diagrammer: Choose Language Model"), `extension/src/messages.ts`

**Interfaces:**
- Produces (`provider.ts`):

```ts
export type LlmModel = { id: string; name: string; vendor: string };
export type LlmErrorKind = "no-model" | "consent-declined" | "cancelled" | "provider" | "invalid-output";
export class LlmError extends Error { constructor(readonly kind: LlmErrorKind, message: string) }
export interface LlmProvider {
  listModels(): Promise<LlmModel[]>;
  complete(prompt: string, opts: { modelId: string; signal?: AbortSignal }): Promise<string>;
}
```
- Produces (`service.ts`):

```ts
export interface LlmHost {
  preferredModelId(): string;                       // the setting, "" if unset
  hasConsent(): boolean;
  askConsent(modelName: string): Promise<boolean>;  // must persist a "yes" itself
}
export type AskOptions = { kind: string; regenerate?: boolean; signal?: AbortSignal };
export type Answer = { text: string; model: LlmModel; cached: boolean };
export class LlmService {
  constructor(provider: LlmProvider, host: LlmHost, cacheDir: string);
  /** Throws LlmError. */
  ask(prompt: string, opts: AskOptions): Promise<Answer>;
  /** Cache lookup only: never calls the provider, never asks consent. */
  cached(prompt: string, kind: string): Promise<Answer | undefined>;
}
export function extractJson(text: string): unknown;   // throws LlmError("invalid-output")
```
- `test/fakeProvider.ts`: `class FakeProvider implements LlmProvider { constructor(models: LlmModel[], replies: (string | Error)[]); prompts: string[] }` — replies are consumed in order, the last one repeats.
- Messages: `M.NO_LANGUAGE_MODEL = "No language model available in this IDE."`, `M.CONSENT(model) = \`Class signatures and code excerpts will be sent to ${model}.\``, `M.MODEL_FALLBACK(name)`.

- [ ] **Step 1: Write the failing tests** (`llmService.test.ts`, temp cache dir per test):

```ts
test("asks the preferred model and returns its text")              // modelId passed == preferred
test("falls back to the first model when the preferred one is gone") // answer.model.id === models[0].id
test("no models → LlmError no-model, consent never asked")
test("declined consent → LlmError consent-declined, provider not called")
test("consent is asked once: second ask with hasConsent()=true does not ask")
test("same prompt+kind+model is served from the cache")              // provider.prompts.length === 1, cached === true
test("a different model id or kind misses the cache")
test("regenerate bypasses and then overwrites the cache")
test("cached() returns undefined on a miss and never calls the provider")
test("an aborted signal → LlmError cancelled and nothing is cached")
test("a provider error → LlmError provider with its message; nothing cached")
test("extractJson", () => {
  expect(extractJson('Sure!\n```json\n{"a": {"b": 1}}\n```\nDone {"c":2}')).toEqual({ a: { b: 1 } });
  expect(extractJson('{"s": "a } brace"}')).toEqual({ s: "a } brace" });
  expect(() => extractJson("no json here")).toThrow(LlmError);
});
```
- [ ] **Step 2:** `npx vitest run test/llmService.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** Cache file `<cacheDir>/<sha256(kind + "\n" + modelId + "\n" + prompt)>.json` holding `{text, model}`; write via temp file + rename; a corrupt cache file is a miss. `cached()` resolves the model the same way as `ask()` (preferred, else first) and returns `undefined` when there are no models. `extractJson` scans for the first `{`, then the matching `}` respecting JSON strings and escapes.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: `VsCodeLmProvider`.** `listModels`: `typeof vscode.lm?.selectChatModels === "function"` else `[]`; map `{id, name, vendor}`. `complete`: select by `{ id }`, `sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token)` with a `CancellationTokenSource` tied to the `AbortSignal`, concatenate `response.text`; wrap failures in `LlmError("provider", ...)`, cancellation in `LlmError("cancelled", ...)`. No unit test (needs a live IDE): verify with `npx tsc --noEmit -p .` — Expected: no errors. Bump `engines.vscode` in `package.json` to `^1.90.0` if it is lower (the `vscode.lm` API) and `@types/vscode` to match.
- [ ] **Step 6: Commit** `feat: language model service with consent and cache`.

---

### Task 3: Project model list

**Files:**
- Create: `extension/src/llm/projectModels.ts`, `extension/test/projectModels.test.ts`
- Modify: `extension/src/extension.ts`, `extension/package.json` (command `codeDiagrammer.scanProject` "Code Diagrammer: Scan Project Models"), `extension/src/messages.ts`, `extension/test/manifest.test.ts`

**Interfaces:**
- Consumes: `ScannedClass` (Task 1), `LlmService.ask`, `extractJson`, `LlmError` (Task 2).
- Produces:

```ts
export type ProjectModel = { name: string; file: string; line: number; summary: string };
export function projectPrompt(candidates: ScannedClass[], root: string): string;
export function parseProjectModels(text: string, candidates: ScannedClass[], root: string): ProjectModel[];
export async function projectModels(
  classes: ScannedClass[], root: string, llm: LlmService, opts?: { regenerate?: boolean },
): Promise<{ models: ProjectModel[]; note?: string }>;
```
- Prompt contract: lists each candidate as `relative/path.py::Name(forward params) — docstring — uses: types` and asks for `{"models": [{"name": "...", "file": "relative/path.py", "summary": "one sentence"}]}`, most important first, at most 12, JSON only. Paths in the prompt are workspace-relative with `/`.

- [ ] **Step 1: Failing tests:**

```ts
test("prompt lists only candidates, with relative paths")
test("parse keeps the model's order and drops unknown name/file pairs")
test("parse matches files case-insensitively on Windows-style separators") // "models\\Net.py" vs "models/net.py"
test("summary is trimmed to one line and 200 chars")
test("no candidates → empty list, the model is not asked")
test("LlmError no-model → all candidates, empty summaries, note = M.NO_LANGUAGE_MODEL")
test("invalid output → all candidates without summaries, note mentions invalid output")
test("zero valid entries in a valid JSON → falls back to all candidates")
test("consent-declined and cancelled are rethrown")        // the command then does nothing
test("at most 60 candidates are sent; the rest are appended unsummarised")
```
- [ ] **Step 2:** `npx vitest run test/projectModels.test.ts` → FAIL.
- [ ] **Step 3:** Implement (`kind: "project-models"`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Wire the command** in `extension.ts`: needs a workspace folder (the active editor's, else the first) → `client.scan(root)` under `withProgress` → `projectModels(...)` → `showQuickPick` with `label: name`, `description: relative file`, `detail: summary`, plus a last item "↻ Regenerate" → on pick: open the document at `line` and run the existing open flow with that class pre-selected (`saveEntry` only if the file has no saved entry or a different class, keeping existing `ctorKwargs`/`inputs` when the class is unchanged). A `note` is shown with `showWarningMessage`. Extend `manifest.test.ts`: the three new commands (`chooseModel`, `scanProject`, `togglePaperView` — the last is added in Task 5; assert only the ones that exist at this task) are declared. `chooseModel`: QuickPick over `provider.listModels()`, writes `codeDiagrammer.llm.model` (workspace target); empty list → `M.NO_LANGUAGE_MODEL`.
- [ ] **Step 6:** `npx tsc --noEmit -p . && npx vitest run` → all pass. **Commit** `feat: scan project models with a language model`.

---

### Task 4: Grouping — describe, validate, transform

**Files:**
- Create: `extension/src/llm/grouping.ts`, `extension/test/grouping.test.ts`, `extension/test/fixtures/fastsde-traced.json` (the traced FAST-SDE graph, produced once with the analyzer CLI and committed), `extension/test/fixtures/fastsde-groups.json` (a hand-written grouping of it into 7 groups mirroring the paper's Fig. 2)
- Modify: `extension/src/ir.ts` (`Node.kind` gains `"concept"`; optional `description?: string` on `Node`)

**Interfaces:**
- Consumes: `Graph`, `Node`, `Edge`, `IN`, `OUT` (`ir.ts`); `LlmService`, `extractJson`, `LlmError`.
- Produces:

```ts
export type Group = { name: string; description: string; nodeIds: string[] };
export type Rejection = { name: string; reason: string };
export function describeGraph(graph: Graph, readLines: (file: string, start: number, end: number) => string[]): string;
export function groupingPrompt(description: string, errors?: Rejection[]): string;
export function validateGroups(raw: unknown, graph: Graph): { groups: Group[]; rejected: Rejection[] };
export function applyGrouping(graph: Graph, groups: Group[]): Graph;   // pure; input is not mutated
export async function groupGraph(
  graph: Graph, llm: LlmService, readLines: ..., opts?: { regenerate?: boolean; signal?: AbortSignal; cacheOnly?: boolean },
): Promise<{ paper: Graph; groups: Group[] } | undefined>;   // undefined only for a cacheOnly miss
```
- Rules for `validateGroups` (operate on `graph.root.children` / `graph.root.edges` only):
  1. `raw.groups` must be an array, else throw `LlmError("invalid-output")`.
  2. Per group, in order: name trimmed, non-empty, ≤40 chars (longer → truncated to 40); ids not among top-level children are removed from the group; ids already taken by an earlier accepted group are removed; fewer than 2 ids left → rejected "needs at least two blocks".
  3. Not connected through root edges among its members (undirected) → rejected "blocks are not adjacent in the data flow".
  4. Collapsing it together with the already accepted groups makes the top-level graph cyclic → rejected "would create a cycle".
  5. Duplicate names get a ` 2`, ` 3` suffix.
  6. Zero accepted groups, or one group covering every top-level node → throw `LlmError("invalid-output")`.
- `applyGrouping`: each group becomes `{ id: "root/concept:" + index, name, kind: "concept", type: "concept", description, source: first member's source, params/trainableParams: sum of members (null if all null), children: members in original order, edges: internal edges + "$in"→member for each entering edge + member→"$out" for each leaving edge (shape/dtype/uncertain copied, deduped) }`. Root edges: endpoints replaced by the concept id, edges internal to a group removed, then deduped on `(from, to, outIndex, JSON shape)`. Root children: the concept takes the position of its first member. `meta` is copied unchanged.
- `describeGraph`: class name; then per top-level node one block: `id`, `kind`, `type`, params, `in:`/`out:` shapes from root edges, `from:`/`to:` neighbor ids, and ≤15 source lines (via `readLines`, missing file → no excerpt). Capped at 150 nodes (beyond that, excerpts are dropped first).
- `groupGraph`: `kind: "grouping"`; on `invalid-output` or when `rejected.length > 0 && groups.length < 2`, one retry with `groupingPrompt(description, rejected)` (`regenerate: true`); still invalid → throw `LlmError("invalid-output")`. A graph with fewer than 4 top-level nodes → throw `LlmError("invalid-output", "Too small to group")` without asking.

- [ ] **Step 1: Failing tests** (`grouping.test.ts`; small graphs built with `test/helpers.ts` `g/n/op/e`; chain `a→b→c→d→e` plus a skip edge `a→d` where noted):

```ts
test("accepts a contiguous group and reports nothing")
test("drops unknown ids, then rejects a group left with one node")
test("a node claimed twice stays in the first group")
test("rejects non-adjacent blocks")                    // {a, c}
test("rejects a group that would create a cycle")     // chain with skip a→d: group {a, d} → b,c sit between
test("truncates long names and de-duplicates equal names")
test("not an object / groups not an array → invalid-output")
test("one group covering everything → invalid-output")
test("applyGrouping: concept replaces members at the first member's position")
test("applyGrouping: boundary edges keep shape, dtype and uncertainty; internal edges move inside")
test("applyGrouping: parallel boundary edges are deduped, different shapes are kept")
test("applyGrouping: concept inner $in/$out edges mirror the crossing edges")
test("applyGrouping: params are summed; all-null stays null; input graph is not mutated")
test("applyGrouping: every non-concept node id and every edge shape of the paper view exists in the code view")
test("groupGraph retries once with the rejection reasons, then succeeds")  // FakeProvider replies: bad, good
test("groupGraph gives up after the retry → LlmError invalid-output")
test("groupGraph cacheOnly: miss → undefined without calling the provider; hit → paper graph")
test("groupGraph refuses graphs with fewer than four top-level nodes")
test("describeGraph includes ids, shapes, neighbors and at most 15 source lines per node")
test("FAST-SDE fixture: the recorded grouping is valid, gives 5–8 top-level blocks, keeps the paper's boundary shapes", () => {
  // validateGroups(fixtureGroups, fixtureGraph).rejected === []
  // top-level children of applyGrouping(...): between 5 and 8
  // edges of the paper view include shapes [1,3,26,256], [8,24,26,32], [1,64,26], [1,26,96], [1,1]
});
```
- [ ] **Step 2:** `npx vitest run test/grouping.test.ts` → FAIL (module missing). Generate `fastsde-traced.json` with: `echo '{"command":"trace","file":"<abs>/analyzer/tests/external/FAST-SDE/models/fastsde.py","entry":"<entry from analyzer/tests/test_fastsde.py BASE>","workspaceRoot":"<abs>/analyzer/tests/external/FAST-SDE","ctorKwargs":{},"inputs":{"wav":[1,3200]},"device":"auto"}' | .venv/Scripts/python -m code_diagrammer` (run in `analyzer/`), keep only `.graph`, and rewrite absolute `source.file` paths to the relative form `models/fastsde.py` so the fixture is machine-independent.
- [ ] **Step 3:** Implement `grouping.ts`; add `"concept"` and `description` to `ir.ts`.
- [ ] **Step 4:** Run → PASS; `npx tsc --noEmit -p .` → no errors (fix any exhaustive `kind` switch the new member breaks).
- [ ] **Step 5: Commit** `feat: validated paper-style grouping of a diagram`.

---

### Task 5: Paper view in the diagram, docs, packaging

**Files:**
- Modify: `extension/src/protocol.ts`, `extension/src/controller.ts`, `extension/src/extension.ts`, `extension/src/messages.ts`, `extension/src/webview/{main.ts,view.ts,style.css}`, `extension/package.json` (command `codeDiagrammer.togglePaperView` "Code Diagrammer: Toggle Paper View"), `extension/test/{controller,main,view,manifest}.test.ts`, `README.md`, `extension/README.md`

**Interfaces:**
- Consumes: `groupGraph`, `LlmError` (Tasks 2, 4); controller request sequencing (`begin`/`stale`, existing).
- Produces:
  - `protocol.ts`: `HostMessage` gains `{ type: "paper"; graph: Graph | null }` and `{ type: "busy"; text: string | null }`; `WebviewMessage` gains `{ type: "requestPaper"; regenerate: boolean }`; `NoticeAction` gains `"chooseModel"`.
  - `controller.ts`: `Host` gains `group(graph: Graph, opts: { regenerate?: boolean; cacheOnly?: boolean; signal: AbortSignal }): Promise<Graph | undefined>` (the extension binds it to `groupGraph(...).paper`); `DiagramController.requestPaper(regenerate = false): Promise<void>`.
  - Controller behavior: after every successful `graph` post it posts `{type: "paper", graph: null}` and then tries `host.group(graph, {cacheOnly: true})`; a hit posts `{type: "paper", graph}` (only if not stale). `requestPaper`: posts `busy` with `M.GROUPING`, calls `host.group`, then `busy: null`; success → `paper`; `LlmError` kinds map to notices: `no-model` → warn `M.NO_LANGUAGE_MODEL` with action `chooseModel`; `invalid-output` → warn `M.GROUPING_FAILED(message)`; `provider` → warn with the provider's message; `consent-declined`/`cancelled` → no notice. A newer graph or a second `requestPaper` aborts the previous one (`AbortController`) and its result is discarded. The code-view graph (`controller.graph`) is never replaced by the paper graph.
  - Webview: header toggle "Code | Paper". Paper selected with a paper graph → render it (own expanded-set, concept nodes collapsed by default); without one → send `requestPaper`. A `paper: null` message while in paper view switches back to code view. A small "↻" next to the toggle sends `requestPaper` with `regenerate: true`. `busy` text shows next to the toggle. Concept nodes: dashed rounded border, name as title, `description` in the details pane; double-click opens the first member's source; cursor highlight lights a collapsed concept when any member matches.
  - `view.ts`: `labels()` for `kind === "concept"` → label = name, sublabel = `"<n> blocks · <params>"`.

- [ ] **Step 1: Failing tests.**
  - `controller.test.ts` (extend `setup` with a `group` stub recording calls):

```ts
test("after a graph is posted, a cached grouping is posted as the paper view")
test("no cached grouping → paper:null only, and the model is not asked")
test("requestPaper posts busy, the paper graph, then busy:null")
test("requestPaper without a language model offers Choose Language Model")
test("invalid model output keeps the code view and reports it")
test("declined consent is silent")
test("a save during grouping discards the stale grouping")       // gate the group stub, save, release → no paper for old graph
test("a second requestPaper aborts the first")                   // first call's signal.aborted === true
test("tracing shapes re-checks the cache for the traced graph")
```
  - `view.test.ts`: `test("a concept node shows its name and member count")`.
  - `main.test.ts` (jsdom): `test("toggle to Paper without a grouping asks the host")`, `test("a paper message while Paper is selected renders concept nodes")`, `test("a new graph falls back to the code view")`, `test("regenerate asks with regenerate:true")`.
  - `manifest.test.ts`: all three commands and the `codeDiagrammer.llm.model` setting are declared.
- [ ] **Step 2:** `npx vitest run` → the new tests FAIL, existing 74+ pass.
- [ ] **Step 3:** Implement controller, protocol, webview, CSS; wire `host.group`, the `togglePaperView` command (posts a message that flips the toggle) and `chooseModel` notice action in `extension.ts`. `readLines` reads the file with `fs.readFileSync(..., "utf8")`, errors → `[]`.
- [ ] **Step 4:** `npx tsc --noEmit -p . && npx vitest run` → all pass. `.venv/Scripts/python -m pytest analyzer -q` → all pass.
- [ ] **Step 5: Docs.** README sections: choosing a model (Claude/Gemini via the IDE), Scan Project Models, Paper view, what is sent to the model, cache folder (suggest adding `.code-diagrammer/cache/` to `.gitignore`), and a manual checklist — *not verifiable by tests*: (1) `Choose Language Model` lists models in VS Code and in Antigravity (incl. WSL), (2) Scan Project Models on FAST-SDE, (3) Paper view on FAST-SDE gives sensible blocks, (4) Regenerate, (5) toggling back shows the unchanged code view.
- [ ] **Step 6:** `npm run build` then `npx vsce package --no-dependencies --allow-missing-repository` in `extension/` → a `.vsix` is produced (version bumped to `0.2.0` in `package.json`). **Commit** `feat: paper view toggle with language-model grouping`.
