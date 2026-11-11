# Code Diagrammer

A VS Code extension (also for Antigravity IDE) that turns PyTorch model code into an interactive
architecture diagram with tensor shapes.

- `analyzer/`: Python package `code_diagrammer`. Stage 1 parses source with `ast`; Stage 2 runs one
  forward pass and records shapes. It speaks JSON over stdin/stdout (`python -m code_diagrammer`).
- `extension/`: the VS Code extension. It runs the analyzer as a subprocess and draws the result in a
  Webview panel. See `extension/README.md` for usage.
- `docs/superpowers/`: design spec and implementation plan.

## Development

```
python -m venv --system-site-packages .venv
.venv/Scripts/python -m pip install -e "analyzer[dev]"
.venv/Scripts/python -m pytest analyzer

cd extension
npm install
npm test
npm run build
npm run package      # produces code-diagrammer-0.1.0.vsix
```

The acceptance tests in `analyzer/tests/test_fastsde.py` and `test_mdctgan.py` need the two repos cloned
into `analyzer/tests/external/` (see the docstrings); they are skipped otherwise.
