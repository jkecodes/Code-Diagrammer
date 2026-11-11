# Code Diagrammer

See a PyTorch model as an architecture diagram with tensor shapes, inside the editor.

- **Open Architecture Diagram** reads the model's source and draws its structure. Nothing is executed.
- **Trace Shapes** runs one forward pass on a dummy input and labels every connection with its tensor shape.
- Click a block for details, double-click to jump to its code, use the `+` button to look inside it.
- The block under the editor cursor is highlighted in the diagram.
- **Scan Project Models** and the **Paper** view use a language model from your IDE (see below).

## Requirements

A Python interpreter (3.11 or newer for Trace Shapes) with `torch` and your model's own dependencies installed.
Set `codeDiagrammer.pythonPath` if it is not the `python` on your PATH.

## Input shapes

The first time you run Trace Shapes, `.vscode/code-diagrammer.json` opens with one entry per file:

```json
{
  "entries": {
    "models/net.py": {
      "className": "Net",
      "ctorKwargs": { "n_blocks": 3 },
      "inputs": { "x": [1, 3, 224, 224] }
    }
  }
}
```

Each input is one of:

- `[1, 3, 224, 224]`: a float tensor of that shape
- `{ "shape": [1, 128], "dtype": "int64" }`: a tensor with another dtype
- `{ "value": true }`: a plain value passed as is

## Language model features

These use a language model that your IDE offers to extensions (for example a Claude or Gemini model).
No API key is configured in this extension.

- **Choose Language Model** lists the models the IDE offers and saves your choice in
  `codeDiagrammer.llm.model`. You are always asked to choose; no model is picked for you. If the list is
  empty, the IDE does not offer a model to extensions and these features are unavailable.
- **Scan Project Models** lists every `nn.Module` in the folder that no other module uses as a part, and
  asks the model which ones are the project's main models, with a one-line summary each. Pick one to open
  its diagram. Without a model you still get the plain list.
- **Paper view** (the `Code | Paper` switch above the diagram, or **Toggle Paper View**) asks the model to
  group the top-level blocks into a few named stages, like a paper's architecture figure. `↻` asks again.
  The grouping only wraps existing blocks: every connection and tensor shape comes from the code, and the
  Code view is always one click away.

What is sent: class names, `forward` parameter names, docstrings, block types, tensor shapes and up to 15
source lines per block. You are asked once per workspace before anything is sent.

Answers are cached in `.code-diagrammer/cache/` in the workspace, so the model is only asked again when the
code or the model changes. You may want to add that folder to `.gitignore`.

## Safety

Trace Shapes imports and runs your model code. It only runs when you ask for it, and it is disabled in
untrusted workspaces. Opening a diagram and scanning a project never execute code.

## Manual checklist for language model features

Automated tests use a scripted model. These need a real IDE:

1. **Choose Language Model** lists models (VS Code, Antigravity, and a WSL window).
2. **Scan Project Models** on a real project lists its main models with summaries.
3. **Paper** on a traced diagram gives sensible, named stages; shapes match the Code view.
4. `↻` produces a new grouping; switching back to **Code** shows the unchanged diagram.
