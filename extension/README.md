# Code Diagrammer

See a PyTorch model as an architecture diagram with tensor shapes, inside the editor.

- **Open Architecture Diagram** reads the model's source and draws its structure. Nothing is executed.
- **Trace Shapes** runs one forward pass on a dummy input and labels every connection with its tensor shape.
- Click a block for details, double-click to jump to its code, use the `+` button to look inside it.
- The block under the editor cursor is highlighted in the diagram.
- **Open Project Architecture** draws every main model of the project in one diagram and zooms to the
  part the file you are editing defines.
- Blocks are drawn by role: encoders and decoders as trapezoids, activations as circles, and so on.
- **Scan Project Models**, block roles and the **Stages** view use a language model from your IDE (see below).

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

## Project architecture

**Open Project Architecture** (or the `Project` button above a diagram) scans the workspace folder, finds
its main models and draws each one as a block. Expand a block to see that model's data flow; blocks defined
in other files expand too. Nothing is imported or executed, so this view has no tensor shapes: right-click
a model block and choose **Open as single model** to trace shapes for it.

When the view opens it expands down to, highlights and zooms to the blocks that the file you are editing
defines (with the cursor inside a class: the blocks of that class). **Locate** does this again for the
file you are in now. `File` goes back to the diagram of that file's own model.

Models are not connected to each other: how a generator feeds a discriminator is written in training
code, which this view does not read. At most 12 main models are drawn. If one of them cannot be analysed
it is shown as a block that does not expand, and the others are still drawn.

## Block shapes and colours

A block's role decides how it is drawn. The data flow runs left to right.

| Role | Shape | Colour |
|---|---|---|
| `encoder` | trapezoid, narrowing | blue |
| `decoder` | trapezoid, widening | green |
| `discriminator` | trapezoid, narrowing | red |
| `attention` | hexagon | purple |
| `sequence` (RNN, state-space, transformer stack) | rectangle | teal |
| `embedding` | rounded | yellow |
| `head` | rounded | orange |
| `loss` | rounded | pink |
| `activation` | circle | gray |

- Activation functions (`nn.ReLU`, `F.gelu`, `x.tanh()`, …) are recognised by name; no language model is needed.
- The other roles are chosen per class by the language model when the project architecture is opened.
  For a class that fits none of them it may invent a role and pick a shape and colour from the lists below.
- An expanded block is always a rectangle (its contents must fit); it keeps its colour.
- You can set the look of any class yourself in `.vscode/code-diagrammer.json`. Your settings always win
  and work without a language model:

```json
{
  "styles": {
    "MultiPeriodDiscriminator": { "role": "discriminator" },
    "MyBlock": { "shape": "hexagon", "color": "teal" }
  }
}
```

Shapes: `rect`, `rounded`, `trapezoid-narrow`, `trapezoid-wide`, `hexagon`, `circle`.
Colours: `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink`, `gray`, `none`.

## Language model features

These use a language model that your IDE offers to extensions (for example a Claude or Gemini model).
No API key is configured in this extension.

- **Choose Language Model** lists the models the IDE offers and saves your choice in
  `codeDiagrammer.llm.model`. You are always asked to choose; no model is picked for you. If the list is
  empty, the IDE does not offer a model to extensions and these features are unavailable.
- **Scan Project Models** lists every `nn.Module` in the folder that no other module uses as a part, and
  asks the model which ones are the project's main models, with a one-line summary each. Pick one to open
  its diagram. Without a model you still get the plain list.
- **Test Language Model** sends one fixed question to the chosen model and tells you whether it answers,
  and in the format this extension needs. Use it first when a feature below does nothing.
- **Stages view** (the `Blocks | Stages` switch above the diagram, or **Toggle Stages View**) asks the model
  to group a model's blocks into a few named stages, like a paper's architecture figure. `↻` asks again.
  The grouping only wraps existing blocks: every connection and tensor shape comes from the code, and the
  Blocks view is always one click away. When a model is wrapped in a single block, the blocks inside it are
  grouped. In the project architecture, stages are made for one model at a time: the one containing the
  selected block, else the one containing your file, else the first.
- **Block roles** (see above) are asked once per project, when the project architecture opens.

What is sent: class names, `forward` parameter names, docstrings, block types, tensor shapes and up to 15
source lines per block. You are asked once per workspace before anything is sent. Test Language Model
sends nothing from your workspace.

Answers are cached in `.code-diagrammer/cache/` in the workspace, so the model is only asked again when the
code or the model changes; the roles of the last project view are kept in `.code-diagrammer/roles.json`.
You may want to add that folder to `.gitignore`.

## Safety

Trace Shapes imports and runs your model code. It only runs when you ask for it, and it is disabled in
untrusted workspaces. Opening a diagram, the project architecture and scanning a project never execute code.

## Manual checklist for language model features

Automated tests use a scripted model. These need a real IDE:

1. **Choose Language Model** lists models (VS Code, Antigravity, and a WSL window).
2. **Scan Project Models** on a real project lists its main models with summaries.
3. **Stages** on a traced diagram gives sensible, named stages; shapes match the Blocks view.
4. `↻` produces a new grouping; switching back to **Blocks** shows the unchanged diagram.
5. Declining the "will be sent" question: Scan still lists the models (no summaries); Stages stays on Blocks.
6. Dismissing the model picker cancels quietly; nothing is sent.
7. A saved `codeDiagrammer.llm.model` that the IDE no longer offers: you are asked to choose again.
8. An IDE without any model: "No language model available", and the diagram still works.
9. Cancel on the scan progress, and clicking **Blocks** while "Grouping blocks…" is shown, stop the request.
10. Opening another diagram while "Grouping blocks…" is shown: the label disappears.
11. **Test Language Model** reports that the chosen model works (VS Code, Antigravity, a WSL window).
12. **Open Project Architecture** on a real project: every main model is a block, expanding shows its data
    flow, and the view is zoomed to the file you were editing.
13. Click **Locate**, **File** and **Project** in the diagram (the diagram has the focus then): each still
    acts on the Python file you edited last.
14. Move the cursor to another class and press **Locate**: the view moves there; moving the cursor alone
    only changes the highlight.
15. A main model with a syntax error: it is a block that does not expand, a warning names it, the others are drawn.
16. Cancel the "analysing the project" progress: the diagram that was open stays.
17. Roles: encoders, decoders and discriminators are trapezoids, activations are gray circles; a class the
    model gave an invented role has the same look everywhere.
18. A `"styles"` entry changes that class's look after the next save, and survives Trace Shapes and
    Select Entry Model (which rewrite the same file).
19. Shapes and colours are readable in a light theme, a dark theme and a high-contrast theme.
20. **Stages** in the project architecture groups only the model you selected.
21. Save a model file while the project architecture is open: the diagram refreshes without any dialog,
    the view does not move, and Stages (if shown) stay.
22. In the project architecture, with a Python file that has no model as the last editor, click **File**:
    a notice appears and the project diagram still reacts to **Locate** and **Stages**.
23. Put a trailing comma into `.vscode/code-diagrammer.json`: a notice says it is not valid JSON, and the
    file is left exactly as you wrote it.
