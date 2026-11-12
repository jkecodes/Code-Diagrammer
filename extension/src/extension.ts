// VS Code glue: commands, settings, and the editor side of the controller's Host.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AnalyzerClient } from "./analyzerClient";
import { type Active, DiagramController, type Host } from "./controller";
import { configPath, loadEntry, loadStyles, saveEntry } from "./entryConfig";
import { GraphPanel } from "./graphPanel";
import type { SourceRange } from "./ir";
import { groupGraph } from "./llm/grouping";
import { projectModels, type ProjectModel } from "./llm/projectModels";
import { LlmError, type LlmModel } from "./llm/provider";
import { classRoles } from "./llm/roles";
import { loadRoles, saveRoles } from "./llm/rolesStore";
import { testLanguageModel } from "./llm/selfTest";
import { LlmService, type LlmHost } from "./llm/service";
import { VsCodeLmProvider } from "./llm/vscodeLmProvider";
import * as M from "./messages";
import type { NoticeAction, WebviewMessage } from "./protocol";

let controller: DiagramController | undefined;
let workspaceRoot: string | undefined;

/** A Python file in a workspace folder, and where the cursor is in it. */
type Target = Active & { root: string };
/** A click inside the diagram leaves no active editor, so the last Python editor is remembered. */
let lastPython: Target | undefined;

function targetOf(editor: vscode.TextEditor | undefined): Target | undefined {
  const document = editor?.document;
  if (!editor || !document || document.languageId !== "python" || document.uri.scheme !== "file") return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) return undefined;
  return { file: document.fileName, line: editor.selection.active.line + 1, root: folder.uri.fsPath };
}

/** The Python file the user is working on. */
function currentPython(): Target | undefined {
  return targetOf(vscode.window.activeTextEditor) ?? lastPython;
}

function pythonPath(): string {
  const own = vscode.workspace.getConfiguration("codeDiagrammer").get<string>("pythonPath", "").trim();
  if (own) return own;
  const fromPython = vscode.workspace.getConfiguration("python").get<string>("defaultInterpreterPath", "");
  // the Python extension's default value is the bare word "python"; variables are not resolved here
  if (fromPython && !fromPython.includes("${")) return fromPython;
  return "python";
}

async function openSource(source: SourceRange): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source.file));
  const start = Math.max(0, source.startLine - 1);
  const end = Math.min(document.lineCount - 1, Math.max(start, source.endLine - 1));
  const range = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.One, selection: range, preserveFocus: false,
  });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function openConfigFile(): Promise<void> {
  if (!workspaceRoot) return;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath(workspaceRoot)));
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
}

async function runAction(action: NoticeAction): Promise<void> {
  if (!controller) return;
  if (action === "trace") {
    await traceShapes();
  } else if (action === "copyLog") {
    await vscode.env.clipboard.writeText(controller.lastLog);
    void vscode.window.showInformationMessage(M.LOG_COPIED);
  } else if (action === "editInputs") {
    await openConfigFile();
  } else if (action === "selectPython") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "codeDiagrammer.pythonPath");
  } else if (action === "chooseModel") {
    await chooseModel();
  }
}

async function traceShapes(): Promise<void> {
  if (!controller) {
    void vscode.window.showInformationMessage(M.NO_DIAGRAM_OPEN);
    return;
  }
  const current = controller;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Code Diagrammer: tracing shapes…" },
    () => current.traceShapes(),
  );
}

const provider = new VsCodeLmProvider();
const CONSENT_KEY = "codeDiagrammer.llmConsent";
const preferredModelId = () =>
  vscode.workspace.getConfiguration("codeDiagrammer").get<string>("llm.model", "").trim();

function makeClient(context: vscode.ExtensionContext): AnalyzerClient {
  const seconds = vscode.workspace.getConfiguration("codeDiagrammer").get<number>("traceTimeoutSeconds", 60);
  return new AnalyzerClient({
    pythonPath,
    analyzerDir: path.join(context.extensionPath, "python"),
    timeoutMs: Math.max(1, seconds) * 1000,
  });
}

/** Shows the IDE's models and saves the user's choice for this workspace. */
async function pickModel(models: LlmModel[]): Promise<LlmModel | undefined> {
  const picked = await vscode.window.showQuickPick(
    models.map((m) => ({ label: m.name, description: m.vendor, detail: m.id, model: m })),
    { placeHolder: M.PICK_MODEL },
  );
  if (!picked) return undefined;
  await vscode.workspace.getConfiguration("codeDiagrammer")
    .update("llm.model", picked.model.id, vscode.ConfigurationTarget.Workspace);
  return picked.model;
}

function llmService(context: vscode.ExtensionContext, root: string): LlmService {
  const host: LlmHost = {
    preferredModelId,
    pickModel,
    hasConsent: () => context.workspaceState.get<boolean>(CONSENT_KEY, false),
    askConsent: async (modelName) => {
      const answer = await vscode.window.showInformationMessage(
        M.CONSENT(modelName), { modal: true }, M.CONSENT_YES);
      if (answer !== M.CONSENT_YES) return false;
      await context.workspaceState.update(CONSENT_KEY, true);
      return true;
    },
  };
  return new LlmService(provider, host, path.join(root, ".code-diagrammer", "cache"));
}

async function chooseModel(): Promise<void> {
  const models = await provider.listModels();
  if (models.length === 0) {
    void vscode.window.showWarningMessage(M.NO_LANGUAGE_MODEL);
    return;
  }
  const picked = await pickModel(models);
  if (picked) void vscode.window.showInformationMessage(M.MODEL_SET(picked.name));
}

/** Sends one fixed question to the chosen model and tells the user whether it works here. */
async function testModel(): Promise<void> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: M.TEST_RUNNING },
    () => testLanguageModel(provider, preferredModelId()),
  );
  if (result.ok) {
    void vscode.window.showInformationMessage(result.report);
    return;
  }
  const choose = M.ACTION_LABELS.chooseModel;
  if (await vscode.window.showWarningMessage(result.report, choose) === choose) await chooseModel();
}

async function scanProject(context: vscode.ExtensionContext): Promise<void> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") {
    void vscode.window.showInformationMessage(M.NO_WORKSPACE);
    return;
  }
  const root = folder.uri.fsPath;
  const llm = llmService(context, root);
  for (let regenerate = false; ;) {
    let found: { models: ProjectModel[]; note?: string } | undefined;
    try {
      found = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification, cancellable: true,
          title: "Code Diagrammer: scanning project models…",
        },
        async (_progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          const scanned = await makeClient(context).scan(root);
          if (!scanned.ok) {
            void vscode.window.showWarningMessage(M.ANALYSIS_FAILED(scanned.error.message));
            return undefined;
          }
          return projectModels(scanned.value, root, llm, { regenerate, signal: abort.signal });
        },
      );
    } catch (e) {
      if (e instanceof LlmError) return; // the user declined or cancelled
      throw e;
    }
    if (!found) return;
    if (found.models.length === 0) {
      void vscode.window.showInformationMessage(M.NO_PROJECT_MODELS);
      return;
    }
    if (found.note) void vscode.window.showWarningMessage(found.note);
    const items = [
      ...found.models.map((m) => ({
        label: m.name, description: path.relative(root, m.file), detail: m.summary || undefined, model: m,
      })),
      { label: M.REGENERATE, description: "", detail: undefined, model: undefined },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: M.PICK_PROJECT_MODEL, matchOnDetail: true });
    if (!picked) return;
    if (!picked.model) {
      regenerate = true;
      continue;
    }
    const model = picked.model;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(model.file));
    const line = Math.max(0, model.line - 1);
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(line, 0, line, 0),
    });
    await openModel(context, root, model.file, model.name);
    return;
  }
}

/** Lines `start`..`end` (1-based, inclusive) of a source file; empty when it cannot be read. */
function readLines(file: string, start: number, end: number): string[] {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(Math.max(0, start - 1), end);
  } catch {
    return [];
  }
}

/** A fresh controller, shown in the diagram panel, for the workspace folder `root`. */
function attach(context: vscode.ExtensionContext, root: string): DiagramController {
  workspaceRoot = root;
  const onMessage = (message: WebviewMessage) => {
    if (message.type === "openSource") void openSource(message.source);
    else if (message.type === "action") void runAction(message.action);
    else if (message.type === "requestPaper") void controller?.requestPaper(message.regenerate, message.scopeId);
    else if (message.type === "cancelPaper") controller?.cancelPaper();
    else if (message.type === "switchView") void (message.view === "project" ? openProject(context) : open(context));
    else if (message.type === "locate") controller?.locate(currentPython());
    else if (message.type === "openModel") void openModel(context, root, message.file, message.className);
  };
  const panel = GraphPanel.show(context, onMessage);

  const llm = llmService(context, root);
  // when the model list had to do without the language model, the roles are not asked for either:
  // the user would get the same picker or consent question a second time
  let modelAnswered = true;
  const host: Host = {
    isTrusted: () => vscode.workspace.isTrusted,
    pickClass: (names) => Promise.resolve(vscode.window.showQuickPick(names, { placeHolder: M.PICK_CLASS })),
    post: (message) => panel.post(message),
    openConfigFile,
    group: async (graph, opts) => (await groupGraph(graph, llm, readLines, opts))?.paper,
    pickModels: async (classes, signal) => {
      const found = await projectModels(classes, root, llm, { signal });
      modelAnswered = found.note === undefined;
      return found;
    },
    roles: async (classes, signal) => {
      if (!modelAnswered) return loadRoles(root);
      try {
        const roles = await classRoles(classes, llm, { signal });
        saveRoles(root, roles);
        return roles;
      } catch (e) {
        if (e instanceof LlmError && e.kind !== "cancelled") return loadRoles(root);
        throw e;
      }
    },
    savedRoles: () => loadRoles(root),
    styles: () => loadStyles(root),
  };
  controller?.dispose();
  controller = new DiagramController(makeClient(context), host, root);
  return controller;
}

/** The diagram of one file's model: the given file, else the Python file the user is working on. */
async function open(context: vscode.ExtensionContext, file?: string): Promise<void> {
  const explicit = file
    ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath ?? workspaceRoot
    : undefined;
  const target = file && explicit ? { file, root: explicit } : currentPython();
  if (!target) {
    void vscode.window.showInformationMessage(M.NOT_A_PYTHON_FILE);
    return;
  }
  await controllerFor(context, target.root).open(target.file);
}

/**
 * The controller of the diagram that is open, when it belongs to `root`; otherwise a fresh one.
 * Keeping it means a request that fails or is cancelled leaves the diagram that is shown alive
 * (its Locate, Stages and refresh-on-save keep working).
 */
function controllerFor(context: vscode.ExtensionContext, root: string): DiagramController {
  if (controller && workspaceRoot === root && GraphPanel.active) {
    GraphPanel.active.reveal();
    return controller;
  }
  return attach(context, root);
}

/** The diagram of `className` on its own (where its shapes can be traced). */
async function openModel(
  context: vscode.ExtensionContext, root: string, file: string, className: string,
): Promise<void> {
  // start the diagram from that class; inputs saved for the same class are kept
  if (loadEntry(root, file)?.className !== className) {
    saveEntry(root, file, { className, ctorKwargs: {}, inputs: {} });
  }
  await open(context, file);
}

/** One diagram of every main model of the workspace folder, located on the user's file. */
async function openProject(context: vscode.ExtensionContext): Promise<void> {
  const target = currentPython();
  const first = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === "file");
  const root = target?.root ?? first?.uri.fsPath;
  if (!root) {
    void vscode.window.showInformationMessage(M.NO_WORKSPACE);
    return;
  }
  // the diagram that is open stays until the project is ready: cancelling leaves the panel as it was
  const current = controllerFor(context, root);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, cancellable: true, title: M.PROJECT_SCANNING },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      await current.openProject(target && { file: target.file, line: target.line }, abort.signal);
    },
  );
}

export function activate(context: vscode.ExtensionContext): void {
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  lastPython = targetOf(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.commands.registerCommand("codeDiagrammer.open", () => open(context)),
    vscode.commands.registerCommand("codeDiagrammer.openProject", () => openProject(context)),
    vscode.commands.registerCommand("codeDiagrammer.traceShapes", traceShapes),
    vscode.commands.registerCommand("codeDiagrammer.selectEntry", async () => {
      if (!controller) {
        void vscode.window.showInformationMessage(M.NO_DIAGRAM_OPEN);
        return;
      }
      await controller.selectEntry();
    }),
    vscode.commands.registerCommand("codeDiagrammer.chooseModel", chooseModel),
    vscode.commands.registerCommand("codeDiagrammer.testModel", testModel),
    vscode.commands.registerCommand("codeDiagrammer.togglePaperView", () => {
      if (GraphPanel.active) GraphPanel.active.post({ type: "toggleView" });
      else void vscode.window.showInformationMessage(M.NO_DIAGRAM_OPEN);
    }),
    vscode.commands.registerCommand("codeDiagrammer.scanProject", () => scanProject(context)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme === "file") void controller?.onFileSaved(document.fileName);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      lastPython = targetOf(editor) ?? lastPython;
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const target = targetOf(event.textEditor);
      if (!target) return;
      lastPython = target;
      if (!GraphPanel.active) return;
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => {
        GraphPanel.active?.post({ type: "cursor", file: target.file, line: target.line });
      }, 100);
    }),
  );
}

export function deactivate(): void {
  controller = undefined;
}
