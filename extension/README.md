# Code Diagrammer

See a PyTorch model as an architecture diagram with tensor shapes, inside the editor.

- **Open Architecture Diagram** reads the model's source and draws its structure. Nothing is executed.
- **Trace Shapes** runs one forward pass on a dummy input and labels every connection with its tensor shape.
- Click a block for details, double-click to jump to its code, use the `+` button to look inside it.
- The block under the editor cursor is highlighted in the diagram.

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

## Safety

Trace Shapes imports and runs your model code. It only runs when you ask for it, and it is disabled in
untrusted workspaces. Opening a diagram never executes code.
