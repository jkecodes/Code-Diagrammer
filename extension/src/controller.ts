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

  async open(file: string): Promise<void> {
    this.file = file;
    let entry = loadEntry(this.workspaceRoot, file);
    if (!entry) {
      const classes = await this.classes(file);
      if (!classes) return;
      const top = classes.filter((c) => c.topLevel);
      const candidates = top.length > 0 ? top : classes;
      const name = candidates.length === 1
        ? candidates[0].name
        : await this.host.pickClass(candidates.map((c) => c.name));
      if (!name) return;
      entry = { className: name, ctorKwargs: {}, inputs: {} };
      saveEntry(this.workspaceRoot, file, entry);
    }
    await this.analyze(entry, M.NO_SHAPES);
  }

  async selectEntry(): Promise<void> {
    if (!this.file) return;
    const classes = await this.classes(this.file);
    if (!classes) return;
    const name = await this.host.pickClass(classes.map((c) => c.name));
    if (!name) return;
    const previous = loadEntry(this.workspaceRoot, this.file);
    const entry: EntryConfig = previous?.className === name
      ? previous
      : { className: name, ctorKwargs: {}, inputs: {} };
    saveEntry(this.workspaceRoot, this.file, entry);
    await this.analyze(entry, M.NO_SHAPES);
  }

  async traceShapes(): Promise<void> {
    if (!this.file) return;
    if (!this.host.isTrusted()) {
      this.host.post({ type: "notice", level: "warn", text: M.UNTRUSTED });
      return;
    }
    let entry = loadEntry(this.workspaceRoot, this.file);
    if (!entry) return;
    if (Object.keys(entry.inputs).length === 0) {
      const classes = await this.classes(this.file);
      if (!classes) return;
      const cls = classes.find((c) => c.name === entry!.className);
      const template = cls ? templateFor(cls) : undefined;
      if (template && Object.keys(template.inputs).length > 0) {
        entry = { ...entry, inputs: template.inputs };
        saveEntry(this.workspaceRoot, this.file, entry);
        await this.host.openConfigFile();
        this.host.post({ type: "notice", level: "info", text: M.NEED_INPUTS, action: "editInputs" });
        return;
      }
    }
    const result = await this.client.trace({
      file: this.file, entry: entry.className, workspaceRoot: this.workspaceRoot,
      ctorKwargs: entry.ctorKwargs, inputs: entry.inputs, device: "auto",
    });
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

  /** Only reacts to the file whose diagram is open. */
  async onFileSaved(file: string): Promise<void> {
    if (!this.file || !samePath(file, this.file)) return;
    const entry = loadEntry(this.workspaceRoot, this.file);
    if (!entry) return;
    const wasTraced = this._graph?.meta.mode === "traced";
    await this.analyze(entry, wasTraced ? M.SHAPES_CLEARED : M.NO_SHAPES);
  }

  private async classes(file: string): Promise<ClassInfo[] | undefined> {
    const result = await this.client.listClasses(file);
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

  private async analyze(entry: EntryConfig, notice: string): Promise<void> {
    if (!this.file) return;
    const result = await this.client.analyzeStatic({
      file: this.file, entry: entry.className, workspaceRoot: this.workspaceRoot,
    });
    if (!result.ok) {
      this.fail(result.error);
      return;
    }
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
