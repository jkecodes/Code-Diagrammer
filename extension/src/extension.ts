// VS Code glue: commands, settings, and the editor side of the controller's Host.
import * as path from "node:path";
import * as vscode from "vscode";
import { AnalyzerClient } from "./analyzerClient";
import { DiagramController, type Host } from "./controller";
import { configPath, loadEntry, saveEntry } from "./entryConfig";
import { GraphPanel } from "./graphPanel";
import type { SourceRange } from "./ir";
import { projectModels, type ProjectModel } from "./llm/projectModels";
import { LlmError, type LlmModel } from "./llm/provider";
import { LlmService, type LlmHost } from "./llm/service";
import { VsCodeLmProvider } from "./llm/vscodeLmProvider";
import * as M from "./messages";
import type { NoticeAction, WebviewMessage } from "./protocol";

let controller: DiagramController | undefined;
let workspaceRoot: string | undefined;

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
    preferredModelId: () =>
      vscode.workspace.getConfiguration("codeDiagrammer").get<string>("llm.model", "").trim(),
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
        { location: vscode.ProgressLocation.Notification, title: "Code Diagrammer: scanning project models…" },
        async () => {
          const scanned = await makeClient(context).scan(root);
          if (!scanned.ok) {
            void vscode.window.showWarningMessage(M.ANALYSIS_FAILED(scanned.error.message));
            return undefined;
          }
          return projectModels(scanned.value, root, llm, { regenerate });
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
    // start the diagram from the picked class; inputs saved for that class are kept
    if (loadEntry(root, model.file)?.className !== model.name) {
      saveEntry(root, model.file, { className: model.name, ctorKwargs: {}, inputs: {} });
    }
    await open(context);
    return;
  }
}

async function open(context: vscode.ExtensionContext): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  const folder = document ? vscode.workspace.getWorkspaceFolder(document.uri) : undefined;
  if (!document || document.languageId !== "python" || document.uri.scheme !== "file" || !folder) {
    void vscode.window.showInformationMessage(M.NOT_A_PYTHON_FILE);
    return;
  }
  workspaceRoot = folder.uri.fsPath;

  const onMessage = (message: WebviewMessage) => {
    if (message.type === "openSource") void openSource(message.source);
    else if (message.type === "action") void runAction(message.action);
  };
  const panel = GraphPanel.show(context, onMessage);

  const client = makeClient(context);
  const host: Host = {
    isTrusted: () => vscode.workspace.isTrusted,
    pickClass: (names) => Promise.resolve(vscode.window.showQuickPick(names, { placeHolder: M.PICK_CLASS })),
    post: (message) => panel.post(message),
    openConfigFile,
  };
  controller?.dispose();
  controller = new DiagramController(client, host, workspaceRoot);
  await controller.open(document.fileName);
}

export function activate(context: vscode.ExtensionContext): void {
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand("codeDiagrammer.open", () => open(context)),
    vscode.commands.registerCommand("codeDiagrammer.traceShapes", traceShapes),
    vscode.commands.registerCommand("codeDiagrammer.selectEntry", async () => {
      if (!controller) {
        void vscode.window.showInformationMessage(M.NO_DIAGRAM_OPEN);
        return;
      }
      await controller.selectEntry();
    }),
    vscode.commands.registerCommand("codeDiagrammer.chooseModel", chooseModel),
    vscode.commands.registerCommand("codeDiagrammer.scanProject", () => scanProject(context)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme === "file") void controller?.onFileSaved(document.fileName);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const document = event.textEditor.document;
      if (document.languageId !== "python" || document.uri.scheme !== "file") return;
      if (!GraphPanel.active || !vscode.workspace.getWorkspaceFolder(document.uri)) return;
      const line = event.selections[0].active.line + 1;
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => {
        GraphPanel.active?.post({ type: "cursor", file: document.fileName, line });
      }, 100);
    }),
  );
}

export function deactivate(): void {
  controller = undefined;
}
