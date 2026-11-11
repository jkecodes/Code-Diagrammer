# LLM layer: project model scan and paper-style grouping (sub-project 3)

Builds on `2026-11-11-code-diagrammer-design.md` (Milestone 1). The IR stays the single source of truth; the LLM only adds names and groupings on top of it.

## 1. Goals

1. **Project model list.** Scan the whole workspace, let a language model pick the "main models" and describe each in one sentence; clicking one opens the existing diagram.
2. **Paper-style grouping.** For one model, group its nodes into 5–8 named concept blocks (target: FAST-SDE's ~14 top-level nodes become ~7 blocks like the paper's Fig. 2). A toggle switches between "code view" (today's graph) and "paper view".

Non-goals: ask-about-a-block (sub-project 3b), editing code, any provider other than `vscode.lm` in this version, whole-project dataflow diagrams.

## 2. Provider

```ts
interface LlmProvider {
  listModels(): Promise<LlmModel[]>;            // {id, name, vendor}
  complete(prompt: string, opts: { modelId?: string; signal?: AbortSignal }): Promise<string>;
}
```

- One implementation, `VsCodeLmProvider`, over `vscode.lm.selectChatModels` / `sendRequest`. Claude and Gemini models are whatever the IDE exposes.
- The model is always chosen by the user. Setting `codeDiagrammer.llm.model` holds the chosen model id; a command `Code Diagrammer: Choose Language Model` lists `listModels()`. If no model is chosen yet (or the chosen one is no longer offered), the first LLM action shows the same picker; no model is ever selected silently, and dismissing the picker cancels the action.
- **Unverified assumption:** Antigravity exposes `vscode.lm`. If `listModels()` is empty or the API is absent, the extension shows "No language model available" and everything that does not need an LLM keeps working. The provider interface exists so another implementation (e.g. a Gemini API key) can be added without touching callers.
- First use shows a one-time consent: "Class signatures and code excerpts will be sent to <model>." The answer is remembered per workspace.

## 3. Project scan

- New analyzer command `scan` (static, never imports torch): every `nn.Module` class in the workspace with `{name, file, line, forwardParams, docstring, submoduleTypes, usedBy[]}`.
- A **candidate** is a class that has `forward` and is not a submodule type of another workspace class.
- `projectModels` (TS) sends only candidates (signature, docstring, submodule type names — no full files) and asks the model for JSON `{models: [{name, file, summary}]}`. Validation: each `name`+`file` must match a candidate; unknown entries are dropped.
- UI: command `Scan Project Models` opens a list view; click → existing open flow with that entry.
- No model available → the candidates are shown without summaries.

## 4. Paper-style grouping

Input to the model (built from the IR, never raw source): for the graph's top-level nodes — id, type, kind, params, in/out shapes, neighbor ids, and a ≤15-line source excerpt per node; plus the model's class docstring.

Output contract (JSON only):

```json
{"groups": [{"name": "Frequency Pooling", "description": "…", "nodeIds": ["root/mean@182:17", "root/amax@183:16", "root/add@184:19"]}]}
```

Validation (all in code, no trust in the model):
- every `nodeId` exists among the graph's top-level nodes;
- no node in two groups; groups need ≥2 nodes (singletons stay ungrouped);
- a group must be **contiguous** in the data flow (its nodes form a connected subgraph of the IR edges); non-contiguous groups are dropped;
- names are non-empty, ≤40 chars.
Invalid response → one retry with the validation errors appended; still invalid → keep the code view and show a notice.

Applying: the paper view is a pure transform of the IR — each valid group becomes a `kind: "concept"` node containing its members; edges between concept/ungrouped nodes are derived from the real IR edges and carry their real shapes. Nothing in the paper view can disagree with the code view about shapes. Expand/collapse, double-click (opens the first member's source) and cursor highlight work on concept nodes like on any node.

UI: a "Code view / Paper view" toggle in the diagram header. The paper view needs a stored grouping; if none, the button runs the grouping (with a progress indicator).

## 5. Caching and errors

- Cache directory `.code-diagrammer/cache/` in the workspace. Key = SHA-256 of (kind, model id, content that was sent). Same content + model → no LLM call. "Regenerate" bypasses the cache.
- Cancelling aborts the request (`AbortSignal`); stale responses (a newer request started) are discarded, like the diagram controller does today.
- Errors surface as notices with the cause (no model, consent declined, rate limit/other provider error, invalid output). The last good view is never replaced by a failure.
- `.code-diagrammer/` is added to the workspace's `.gitignore` suggestion in the README, not written automatically.

## 6. Testing

- Analyzer: `scan` on fixtures (candidate detection, not-a-submodule rule, files with syntax errors skipped).
- TS: a `FakeProvider` returns canned JSON. Tests cover validation (unknown id, overlap, non-contiguous group, singleton, retry then give up), the paper-view transform (edges and shapes equal the IR's), cache hit/miss/regenerate, consent flow, stale-response discard, "no model" fallback.
- Acceptance on FAST-SDE uses a recorded grouping fixture (grouping into ≥5 and ≤8 blocks, valid per the rules above, shapes of boundary edges equal Milestone 1's traced shapes).
- **Not testable automatically:** whether a live model's grouping is *good*, and whether Antigravity lists any model. These are manual checks on FAST-SDE, listed in the README checklist.

## 7. Open items for the user

- Which model(s) Antigravity actually exposes is unknown until run on the user's machine.
- Cache location and the consent wording can be changed on review.
