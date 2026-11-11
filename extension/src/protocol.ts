// Messages between the extension host and the diagram webview.
import type { Graph, SourceRange } from "./ir";

export type NoticeAction = "trace" | "copyLog" | "editInputs" | "selectPython";

export type Notice = { level: "info" | "warn" | "error"; text: string; action?: NoticeAction };

export type HostMessage =
  | { type: "graph"; graph: Graph }
  | ({ type: "notice" } & Notice)
  | { type: "clearNotice" }
  | { type: "cursor"; file: string; line: number }; // line is 1-based

export type WebviewMessage =
  | { type: "ready" }
  | { type: "openSource"; source: SourceRange }
  | { type: "action"; action: NoticeAction };
