// Every user-facing string of the extension lives here.

export const UNTRUSTED =
  "Trace Shapes runs your model code, so it is disabled until you trust this workspace.";
export const NO_SHAPES = "Showing structure only. Run Trace Shapes to add tensor shapes.";
export const NEED_INPUTS =
  "Set the input shapes for this model in .vscode/code-diagrammer.json, then run Trace Shapes again.";
export const SHAPES_CLEARED = "Shapes cleared after edit. Run Trace Shapes to refresh.";
export const TRACE_FAILED = (reason: string) =>
  "Could not trace shapes (" + reason + "). Showing structure only.";
export const ANALYSIS_FAILED = (reason: string) =>
  "Could not analyze this file (" + reason + "). Showing the last good diagram.";
export const PYTHON_NOT_FOUND =
  "Python was not found. Set codeDiagrammer.pythonPath to your interpreter.";
export const NO_MODELS = "No nn.Module classes found in this file.";

export const NOT_A_PYTHON_FILE = "Open a Python file inside a workspace folder first.";
export const NO_DIAGRAM_OPEN = "Open an architecture diagram first.";
export const LOG_COPIED = "Log copied to the clipboard.";
export const PICK_CLASS = "Which model class should the diagram start from?";

export const ACTION_LABELS = {
  trace: "Trace Shapes",
  copyLog: "Copy log",
  editInputs: "Edit inputs",
  selectPython: "Set Python path",
} as const;
