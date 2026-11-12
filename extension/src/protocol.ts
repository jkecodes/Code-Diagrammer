// Messages between the extension host and the diagram webview.
import type { Graph, SourceRange } from "./ir";

export type NoticeAction = "trace" | "copyLog" | "editInputs" | "selectPython" | "chooseModel";

export type Notice = { level: "info" | "warn" | "error"; text: string; action?: NoticeAction };

export type HostMessage =
  | { type: "graph"; graph: Graph }
  | ({ type: "notice" } & Notice)
  | { type: "clearNotice" }
  | { type: "cursor"; file: string; line: number } // line is 1-based
  | { type: "paper"; graph: Graph } // the paper view of the graph posted last
  | { type: "busy"; text: string | null } // progress text next to the view toggle
  | { type: "toggleView" }
  | { type: "locate"; ids: string[] }; // expand down to, highlight and zoom to these blocks

export type WebviewMessage =
  | { type: "ready" }
  | { type: "openSource"; source: SourceRange }
  | { type: "action"; action: NoticeAction }
  | { type: "requestPaper"; regenerate: boolean; scopeId?: string } // scopeId: a project graph's model
  | { type: "cancelPaper" }
  | { type: "switchView"; view: "file" | "project" }
  | { type: "locate" }
  | { type: "openModel"; file: string; className: string };
