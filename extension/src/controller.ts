// Open / trace / on-save logic. No `vscode` import: the editor is reached through `Host`.
import * as path from "node:path";
import type { AnalyzerClient, AnalyzerError } from "./analyzerClient";
import {
  configMalformed, configPath, type EntryConfig, loadEntry, saveEntry, templateFor,
} from "./entryConfig";
import type { ClassInfo, Graph, ScannedClass } from "./ir";
import type { ProjectModel } from "./llm/projectModels";
import { LlmError } from "./llm/provider";
import { locateTargets } from "./locate";
import { applyStyles, type RoleMap, type StyleOverride } from "./look";
import { buildProjectGraph, MAX_PROJECT_MODELS, type ProjectPart } from "./project/projectGraph";
import * as M from "./messages";
import type { HostMessage } from "./protocol";

export type AnalyzerClientLike = Pick<AnalyzerClient, "listClasses" | "analyzeStatic" | "trace" | "scan">;

/** Where the user is in the editor: a file and a 1-based line. */
export type Active = { file: string; line: number };

export interface Host {
  isTrusted(): boolean;
  pickClass(names: string[]): Promise<string | undefined>;
  post(msg: HostMessage): void;
  openConfigFile(): Promise<void>;
  /**
   * The paper view of `graph` (blocks grouped by a language model). With `cacheOnly` it must not
   * call the model or show UI, and resolves to undefined when nothing is cached. May throw LlmError.
   */
  group(
    graph: Graph, opts: { regenerate?: boolean; cacheOnly?: boolean; signal: AbortSignal; scope?: string },
  ): Promise<Graph | undefined>;
  /** The project's main models, most important first. Throws LlmError("cancelled") when cancelled. */
  pickModels(classes: ScannedClass[], signal: AbortSignal): Promise<{ models: ProjectModel[]; note?: string }>;
  /** Class roles for the project; falls back to the saved ones. Throws only LlmError("cancelled"). */
  roles(classes: ScannedClass[], signal: AbortSignal): Promise<RoleMap>;
  /** The roles the last project view obtained. Never asks the language model. */
  savedRoles(): RoleMap;
  /** The user's "styles" from the workspace's config file. */
  styles(): Record<string, StyleOverride>;
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
  private paperAbort: AbortController | undefined;
  private project = false; // the graph shows every main model of the workspace, not one file's model
  /** The project diagram made last. It is shown again as it is until a file changes. */
  private built: { graph: Graph; notice: HostMessage; saves: number } | undefined;
  private saves = 0; // saved Python files (and the styles file) so far: what makes `built` out of date

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

  get isProject(): boolean {
    return this.project;
  }

  /** True when the diagram that is shown is the single-model diagram of `file`. */
  isShowingFile(file: string): boolean {
    return !this.project && this._graph !== undefined && this.file !== undefined && samePath(this.file, file);
  }

  /** Commands that need one model say so in the project view instead of doing nothing. */
  private singleModelOnly(): boolean {
    if (!this.project) return false;
    this.host.post({ type: "notice", level: "info", text: M.PROJECT_SINGLE_ONLY });
    return true;
  }

  /** After this the controller no longer posts: a newer diagram replaced it. */
  dispose(): void {
    this.disposed = true;
    this.paperAbort?.abort();
    this.paperAbort = undefined;
  }

  /** Asks the language model to group the current graph's blocks and posts the paper view. */
  async requestPaper(regenerate = false, scopeId?: string): Promise<void> {
    const graph = this._graph;
    if (!graph || this.disposed) return;
    // a project graph is grouped one model at a time
    const scope = this.project ? scopeId ?? graph.root.children[0]?.id : undefined;
    this.paperAbort?.abort();
    const abort = new AbortController();
    this.paperAbort = abort;
    this.host.post({ type: "busy", text: M.GROUPING });
    const current = () => !this.disposed && this.paperAbort === abort && this._graph === graph;
    try {
      const paper = await this.host.group(graph, { regenerate, signal: abort.signal, scope });
      if (current() && paper) this.host.post({ type: "paper", graph: paper });
    } catch (e) {
      if (!current()) return;
      const kind = e instanceof LlmError ? e.kind : "provider";
      const message = e instanceof Error ? e.message : String(e);
      if (kind === "no-model") {
        this.host.post({ type: "notice", level: "warn", text: M.NO_LANGUAGE_MODEL, action: "chooseModel" });
      } else if (kind === "invalid-output") {
        this.host.post({ type: "notice", level: "warn", text: M.GROUPING_FAILED(message) });
      } else if (kind === "provider") {
        this.host.post({ type: "notice", level: "warn", text: M.LLM_FAILED(message) });
      } // consent-declined, cancelled: the user's own choice, nothing to report
    } finally {
      if (this.paperAbort === abort) {
        this.paperAbort = undefined;
        if (!this.disposed) this.host.post({ type: "busy", text: null });
      }
    }
  }

  /** Aborts a grouping in flight: the user cancelled it, or its graph is about to be replaced. */
  cancelPaper(): void {
    if (!this.paperAbort) return;
    this.paperAbort.abort();
    this.paperAbort = undefined;
    this.host.post({ type: "busy", text: null });
  }

  /** Posts the paper view when a grouping of exactly this graph is already cached. */
  private async offerCachedPaper(graph: Graph): Promise<void> {
    if (this.project) return; // which model to group is the user's choice there
    let paper: Graph | undefined;
    try {
      paper = await this.host.group(graph, { cacheOnly: true, signal: new AbortController().signal });
    } catch {
      return; // the cache is a convenience
    }
    if (paper && !this.disposed && this._graph === graph) this.host.post({ type: "paper", graph: paper });
  }

  private begin(): number {
    return ++this.seq;
  }

  /** True when a newer request started (or the controller was disposed) since `token`. */
  private stale(token: number): boolean {
    return this.disposed || token !== this.seq;
  }

  /** The config file cannot be read: say so instead of working from (and then saving) an empty one. */
  private configBroken(): boolean {
    if (!configMalformed(this.workspaceRoot)) return false;
    this.host.post({ type: "notice", level: "warn", text: M.CONFIG_MALFORMED, action: "editInputs" });
    return true;
  }

  async open(file: string): Promise<void> {
    if (this.configBroken()) return;
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
    if (this.singleModelOnly()) return;
    const file = this.file;
    if (!file || this.configBroken()) return;
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
    if (this.singleModelOnly()) return;
    const file = this.file;
    if (!file) return;
    if (!this.host.isTrusted()) {
      this.host.post({ type: "notice", level: "warn", text: M.UNTRUSTED });
      return;
    }
    if (this.configBroken()) return;
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
    const { graph, problems } = this.styled(result.value);
    this.cancelPaper();
    this._graph = graph;
    this.host.post({ type: "graph", graph });
    const reason = result.value.meta.traceError;
    if (reason) {
      this._lastLog = result.log ?? reason;
      this.host.post({ type: "notice", level: "warn", text: M.TRACE_FAILED(reason), action: "copyLog" });
    } else if (problems.length > 0) {
      this.host.post({ type: "notice", level: "warn", text: M.STYLE_PROBLEMS(problems.join("; ")) });
    } else {
      this.host.post({ type: "clearNotice" });
    }
    await this.offerCachedPaper(graph);
  }

  /**
   * A single model's diagram follows its files. The project diagram does not: it is analysed again
   * only when the user asks for it (Project) after something changed.
   */
  async onFileSaved(file: string): Promise<void> {
    if (/\.py$/i.test(file) || samePath(file, configPath(this.workspaceRoot))) {
      const wasUpToDate = this.built !== undefined && this.built.saves === this.saves;
      this.saves++;
      if (this.project && wasUpToDate) {
        this.host.post({ type: "notice", level: "info", text: M.PROJECT_STALE });
      }
    }
    if (this.project) return;
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
    const { graph, problems } = this.styled(result.value);
    this.cancelPaper();
    this.file = file; // only a file that analyzed successfully becomes the open diagram
    this.project = false;
    this._graph = graph;
    this.host.post({ type: "graph", graph });
    if (problems.length > 0) {
      const text = M.STYLE_PROBLEMS(problems.join("; ")) + " " + notice;
      this.host.post({ type: "notice", level: "warn", text, action: "trace" });
    } else {
      this.host.post({ type: "notice", level: "info", text: notice, action: "trace" });
    }
    await this.offerCachedPaper(graph);
  }

  /** A single model's graph with the looks the workspace already knows; never asks the model. */
  private styled(graph: Graph): { graph: Graph; problems: string[] } {
    return applyStyles(graph, this.host.savedRoles(), this.host.styles());
  }

  /** Static analysis of each model, in order. `undefined` when the request died on the way. */
  private async analyzeModels(
    models: ProjectModel[], dead: () => boolean, signal?: AbortSignal,
  ): Promise<{ parts: ProjectPart[]; failed: string[]; firstError?: AnalyzerError } | undefined> {
    const parts: ProjectPart[] = [];
    const failed: string[] = [];
    let firstError: AnalyzerError | undefined;
    for (const model of models) {
      const result = await this.client.analyzeStatic({
        file: model.file, entry: model.name, workspaceRoot: this.workspaceRoot,
      }, signal);
      if (dead()) return undefined;
      parts.push({ ...model, graph: result.ok ? result.value : null });
      if (!result.ok) {
        failed.push(`${model.name} (${result.error.kind})`);
        firstError ??= result.error;
      }
    }
    return { parts, failed, firstError };
  }

  /** Makes a freshly analysed project graph the current one, with everything worth knowing in one notice. */
  private showProject(
    parts: ProjectPart[], failed: string[], note: string | undefined, roles: RoleMap,
    active: Active | undefined, saves: number,
  ): void {
    const { graph, problems } = applyStyles(
      buildProjectGraph(path.basename(this.workspaceRoot), parts), roles, this.host.styles(),
    );
    const targets = active ? locateTargets(graph, active.file, active.line) : [];
    const outside = active !== undefined && targets.length === 0;
    const warnings: string[] = [];
    if (failed.length > 0) warnings.push(M.MODELS_FAILED(failed.join(", ")));
    if (note) warnings.push(note);
    if (configMalformed(this.workspaceRoot)) warnings.push(M.CONFIG_MALFORMED);
    if (problems.length > 0) warnings.push(M.STYLE_PROBLEMS(problems.join("; ")));
    const notice = (alsoOutside: boolean): HostMessage => (warnings.length > 0
      ? { type: "notice", level: "warn", text: [...warnings, ...(alsoOutside ? [M.NOT_IN_PROJECT] : [])].join(" ") }
      : { type: "notice", level: "info", text: alsoOutside ? M.NOT_IN_PROJECT : M.PROJECT_INFO });

    this.cancelPaper();
    this.file = undefined;
    this.project = true;
    this._graph = graph;
    this.built = { graph, notice: notice(false), saves };
    this.host.post({ type: "graph", graph });
    this.host.post(notice(outside));
    this.host.post({ type: "locate", ids: targets });
  }

  /**
   * One diagram of every main model of the workspace, located on what the user is editing.
   * It is analysed again only when a file was saved since the last time; otherwise the diagram
   * made then is shown. Nothing is imported or executed. A cancelled or outdated request posts nothing.
   */
  async openProject(active: Active | undefined, signal: AbortSignal): Promise<void> {
    const token = this.begin();
    if (this.built && this.built.saves === this.saves) {
      // nothing was saved since it was made: show it as it is
      if (!this.project || this._graph !== this.built.graph) {
        this.cancelPaper();
        this.file = undefined;
        this.project = true;
        this._graph = this.built.graph;
        this.host.post({ type: "graph", graph: this.built.graph });
        this.host.post(this.built.notice);
      }
      this.locate(active);
      return;
    }
    const saves = this.saves; // a save during the analysis leaves the result out of date
    const dead = () => signal.aborted || this.stale(token);
    const cancelled = (e: unknown) => e instanceof LlmError && e.kind === "cancelled";

    const scanned = await this.client.scan(this.workspaceRoot, signal);
    if (dead()) return;
    if (!scanned.ok) {
      this.fail(scanned.error, M.PROJECT_FAILED);
      return;
    }
    let picked: { models: ProjectModel[]; note?: string };
    try {
      picked = await this.host.pickModels(scanned.value, signal);
    } catch (e) {
      if (cancelled(e)) return;
      throw e;
    }
    if (dead()) return;
    const models = picked.models.slice(0, MAX_PROJECT_MODELS);
    if (models.length === 0) {
      this.host.post({ type: "notice", level: "warn", text: M.NO_MODELS_IN_FOLDER });
      return;
    }

    const analysed = await this.analyzeModels(models, dead, signal);
    if (!analysed) return;
    if (analysed.firstError && analysed.failed.length === models.length) {
      this.fail(analysed.firstError, M.PROJECT_FAILED);
      return;
    }

    let roles: RoleMap;
    try {
      roles = await this.host.roles(scanned.value, signal);
    } catch (e) {
      if (cancelled(e)) return;
      throw e;
    }
    if (dead()) return;

    this.showProject(analysed.parts, analysed.failed, picked.note, roles, active, saves);
  }

  /** Points the diagram at the blocks the user's file defines. */
  locate(active: Active | undefined): void {
    const graph = this._graph;
    if (!graph || this.disposed) return;
    const ids = active ? locateTargets(graph, active.file, active.line) : [];
    this.host.post({ type: "locate", ids });
    if (this.project && active && ids.length === 0) {
      this.host.post({ type: "notice", level: "info", text: M.NOT_IN_PROJECT });
    }
  }

  /** Keeps the last good graph; only reports. */
  private fail(error: AnalyzerError, wording: (reason: string) => string = M.ANALYSIS_FAILED): void {
    this._lastLog = error.log || error.message;
    if (error.kind === "python-not-found") {
      this.host.post({ type: "notice", level: "error", text: M.PYTHON_NOT_FOUND, action: "selectPython" });
    } else {
      this.host.post({
        type: "notice", level: "warn", text: wording(error.message), action: "copyLog",
      });
    }
  }
}
