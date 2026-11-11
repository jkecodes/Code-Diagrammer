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

export const NO_LANGUAGE_MODEL = "No language model available in this IDE.";
export const CONSENT = (model: string) =>
  `Class signatures and code excerpts will be sent to ${model}.`;
export const CONSENT_YES = "Send";
export const PICK_MODEL = "Choose the language model Code Diagrammer should use";

export const LLM_INVALID_OUTPUT =
  "The language model's answer could not be used. Showing all candidate models instead.";
export const LLM_FAILED = (reason: string) => "The language model request failed (" + reason + ").";
export const NO_WORKSPACE = "Open a folder first.";
export const NO_PROJECT_MODELS = "No nn.Module classes with a forward method were found in this folder.";
export const PICK_PROJECT_MODEL = "Main models of this project — pick one to open its diagram";
export const REGENERATE = "↻ Ask the language model again";
export const MODEL_SET = (name: string) => "Code Diagrammer will use " + name + ".";

export const GROUPING = "Grouping blocks with the language model…";
export const GROUPING_FAILED = (reason: string) =>
  "The language model's grouping could not be used (" + reason + "). Showing the code view.";

export const ACTION_LABELS = {
  trace: "Trace Shapes",
  copyLog: "Copy log",
  editInputs: "Edit inputs",
  selectPython: "Set Python path",
  chooseModel: "Choose model",
} as const;
