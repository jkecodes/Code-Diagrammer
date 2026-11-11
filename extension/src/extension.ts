// VS Code glue: commands, settings, and the editor side of the controller's Host.
import * as path from "node:path";
import * as vscode from "vscode";
import { AnalyzerClient } from "./analyzerClient";
import { DiagramController, type Host } from "./controller";
import { configPath } from "./entryConfig";
import { GraphPanel } from "./graphPanel";
import type { SourceRange } from "./ir";
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

  const seconds = vscode.workspace.getConfiguration("codeDiagrammer").get<number>("traceTimeoutSeconds", 60);
  const client = new AnalyzerClient({
    pythonPath: pythonPath(),
    analyzerDir: path.join(context.extensionPath, "python"),
    timeoutMs: Math.max(1, seconds) * 1000,
  });
  const host: Host = {
    isTrusted: () => vscode.workspace.isTrusted,
    pickClass: (names) => Promise.resolve(vscode.window.showQuickPick(names, { placeHolder: M.PICK_CLASS })),
    post: (message) => panel.post(message),
    openConfigFile,
  };
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
