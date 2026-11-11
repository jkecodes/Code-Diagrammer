// Open / trace / on-save logic. No `vscode` import: the editor is reached through `Host`.
import * as path from "node:path";
import type { AnalyzerClient, AnalyzerError } from "./analyzerClient";
import { type EntryConfig, loadEntry, saveEntry, templateFor } from "./entryConfig";
import type { ClassInfo, Graph } from "./ir";
import * as M from "./messages";
import type { HostMessage } from "./protocol";

export type AnalyzerClientLike = Pick<AnalyzerClient, "listClasses" | "analyzeStatic" | "trace">;

export interface Host {
  isTrusted(): boolean;
  pickClass(names: string[]): Promise<string | undefined>;
  post(msg: HostMessage): void;
  openConfigFile(): Promise<void>;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export class DiagramController {
  private _graph: Graph | undefined;
  private _lastLog = "";
  private file: string | undefined;
  private seq = 0;
  private disposed = false;

  constructor(
    private readonly client: AnalyzerClientLike,
    private readonly host: Host,
    private readonly workspaceRoot: string,
  ) {}

  /** The last good graph. */
  get graph(): Graph | undefined {
    return this._graph;
  }

  /** Log of the last failure, for "copy log". */
  get lastLog(): string {
    return this._lastLog;
  }

  get openFile(): string | undefined {
    return this.file;
  }

  /** After this the controller no longer posts: a newer diagram replaced it. */
  dispose(): void {
    this.disposed = true;
  }

  private begin(): number {
    return ++this.seq;
  }

  /** True when a newer request started (or the controller was disposed) since `token`. */
  private stale(token: number): boolean {
    return this.disposed || token !== this.seq;
  }

  async open(file: string): Promise<void> {
    const token = this.begin();
    let entry = loadEntry(this.workspaceRoot, file);
    if (!entry) {
      const classes = await this.classes(file, token);
      if (!classes) return;
      const top = classes.filter((c) => c.topLevel);
      const candidates = top.length > 0 ? top : classes;
      const name = candidates.length === 1
        ? candidates[0].name
        : await this.host.pickClass(candidates.map((c) => c.name));
      if (!name || this.stale(token)) return;
      entry = { className: name, ctorKwargs: {}, inputs: {} };
      saveEntry(this.workspaceRoot, file, entry);
    }
    await this.analyze(file, entry, M.NO_SHAPES, token);
  }

  async selectEntry(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const token = this.begin();
    const classes = await this.classes(file, token);
    if (!classes) return;
    const name = await this.host.pickClass(classes.map((c) => c.name));
    if (!name || this.stale(token)) return;
    const previous = loadEntry(this.workspaceRoot, file);
    const entry: EntryConfig = previous?.className === name
      ? previous
      : { className: name, ctorKwargs: {}, inputs: {} };
    saveEntry(this.workspaceRoot, file, entry);
    await this.analyze(file, entry, M.NO_SHAPES, token);
  }

  async traceShapes(): Promise<void> {
    const file = this.file;
    if (!file) return;
    if (!this.host.isTrusted()) {
      this.host.post({ type: "notice", level: "warn", text: M.UNTRUSTED });
      return;
    }
    let entry = loadEntry(this.workspaceRoot, file);
    if (!entry) return;
    const token = this.begin();
    if (Object.keys(entry.inputs).length === 0) {
      const classes = await this.classes(file, token);
      if (!classes) return;
      const cls = classes.find((c) => c.name === entry!.className);
      const template = cls ? templateFor(cls) : undefined;
      if (template && Object.keys(template.inputs).length > 0) {
        entry = { ...entry, inputs: template.inputs };
        saveEntry(this.workspaceRoot, file, entry);
        await this.host.openConfigFile();
        this.host.post({ type: "notice", level: "info", text: M.NEED_INPUTS, action: "editInputs" });
        return;
      }
    }
    const result = await this.client.trace({
      file, entry: entry.className, workspaceRoot: this.workspaceRoot,
      ctorKwargs: entry.ctorKwargs, inputs: entry.inputs, device: "auto",
    });
    if (this.stale(token)) return;
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this._graph = result.value;
    this.host.post({ type: "graph", graph: result.value });
    const reason = result.value.meta.traceError;
    if (reason) {
      this._lastLog = result.log ?? reason;
      this.host.post({ type: "notice", level: "warn", text: M.TRACE_FAILED(reason), action: "copyLog" });
    } else {
      this.host.post({ type: "clearNotice" });
    }
  }

  /** Reacts to the open file and to any file that defines a block shown in the diagram. */
  async onFileSaved(file: string): Promise<void> {
    if (!this.file) return;
    if (!samePath(file, this.file) && !this.showsFile(file)) return;
    const entry = loadEntry(this.workspaceRoot, this.file);
    if (!entry) return;
    const wasTraced = this._graph?.meta.mode === "traced";
    await this.analyze(this.file, entry, wasTraced ? M.SHAPES_CLEARED : M.NO_SHAPES, this.begin());
  }

  private showsFile(file: string): boolean {
    const visit = (node: Graph["root"]): boolean =>
      (node.source ? samePath(node.source.file, file) : false) || node.children.some(visit);
    return this._graph ? visit(this._graph.root) : false;
  }

  private async classes(file: string, token: number): Promise<ClassInfo[] | undefined> {
    const result = await this.client.listClasses(file);
    if (this.stale(token)) return undefined;
    if (!result.ok) {
      this.fail(result.error);
      return undefined;
    }
    if (result.value.length === 0) {
      this.host.post({ type: "notice", level: "warn", text: M.NO_MODELS });
      return undefined;
    }
    return result.value;
  }

  private async analyze(file: string, entry: EntryConfig, notice: string, token: number): Promise<void> {
    const result = await this.client.analyzeStatic({
      file, entry: entry.className, workspaceRoot: this.workspaceRoot,
    });
    if (this.stale(token)) return;
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
    this.file = file; // only a file that analyzed successfully becomes the open diagram
    this._graph = result.value;
    this.host.post({ type: "graph", graph: result.value });
    this.host.post({ type: "notice", level: "info", text: notice, action: "trace" });
  }

  /** Keeps the last good graph; only reports. */
  private fail(error: AnalyzerError): void {
    this._lastLog = error.log || error.message;
    if (error.kind === "python-not-found") {
      this.host.post({ type: "notice", level: "error", text: M.PYTHON_NOT_FOUND, action: "selectPython" });
    } else {
      this.host.post({
        type: "notice", level: "warn", text: M.ANALYSIS_FAILED(error.message), action: "copyLog",
      });
    }
  }
}
