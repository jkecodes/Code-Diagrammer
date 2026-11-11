// Hosts the diagram in a Webview panel inside the editor. No browser, no server.
import * as vscode from "vscode";
import type { HostMessage, WebviewMessage } from "./protocol";

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export class GraphPanel {
  private static current: GraphPanel | undefined;

  private lastGraph: HostMessage | undefined;
  private lastNotice: HostMessage | undefined;
  private onMessage: (m: WebviewMessage) => void;

  static show(context: vscode.ExtensionContext, onMessage: (m: WebviewMessage) => void): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.onMessage = onMessage;
      GraphPanel.current.lastGraph = undefined;
      GraphPanel.current.lastNotice = undefined;
      GraphPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return GraphPanel.current;
    }
    const dist = vscode.Uri.joinPath(context.extensionUri, "dist");
    const panel = vscode.window.createWebviewPanel(
      "codeDiagrammer", "Architecture", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] },
    );
    GraphPanel.current = new GraphPanel(panel, dist, onMessage);
    context.subscriptions.push(panel);
    return GraphPanel.current;
  }

  static get active(): GraphPanel | undefined {
    return GraphPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel, dist: vscode.Uri,
    onMessage: (m: WebviewMessage) => void,
  ) {
    this.onMessage = onMessage;
    panel.webview.html = this.html(panel.webview, dist);
    panel.webview.onDidReceiveMessage((m: WebviewMessage) => {
      if (m.type === "ready") {
        // the webview (re)loaded: give it back what it should be showing
        if (this.lastGraph) void panel.webview.postMessage(this.lastGraph);
        if (this.lastNotice) void panel.webview.postMessage(this.lastNotice);
      }
      this.onMessage(m);
    });
    panel.onDidDispose(() => {
      if (GraphPanel.current === this) GraphPanel.current = undefined;
    });
  }

  post(message: HostMessage): void {
    if (message.type === "graph") {
      this.lastGraph = message;
      this.panel.title = "Architecture: " + message.graph.meta.entry.className;
    } else if (message.type === "notice" || message.type === "clearNotice") {
      this.lastNotice = message;
    }
    void this.panel.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css"));
    const n = nonce();
    const csp = `default-src 'none'; script-src 'nonce-${n}' ${webview.cspSource}; style-src ${webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Architecture</title>
</head>
<body>
<div id="toolbar">
  <span id="title"></span>
  <label><input type="checkbox" id="showShapeOps"> Show reshape ops</label>
  <button id="fit" class="secondary">Fit</button>
  <button id="trace">Trace Shapes</button>
</div>
<div id="notice" class="notice" hidden></div>
<div id="main">
  <svg id="diagram" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Model architecture diagram"></svg>
  <aside id="details"></aside>
</div>
<div id="menu" hidden></div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
  }
}
