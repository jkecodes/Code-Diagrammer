import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import type { AnalyzerError, Result } from "../src/analyzerClient";
import { DiagramController, type Host } from "../src/controller";
import { saveEntry } from "../src/entryConfig";
import type { ClassInfo, Graph, Look, Node, ScannedClass } from "../src/ir";
import { LlmError } from "../src/llm/provider";
import type { ProjectModel } from "../src/llm/projectModels";
import type { RoleMap, StyleOverride } from "../src/look";
import * as M from "../src/messages";
import type { HostMessage } from "../src/protocol";
import { e, g, n } from "./helpers";

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
function fail(kind: AnalyzerError["kind"], message = "boom"): Result<never> {
  return { ok: false, error: { kind, message, log: "the log" } };
}

const ENCODER: Look = { role: "encoder", shape: "trapezoid-narrow", color: "blue" };

type Opts = {
  classes?: string[]; scan?: Result<ScannedClass[]>; failing?: Record<string, AnalyzerError["kind"]>;
  note?: string; roles?: RoleMap; saved?: RoleMap; styles?: Record<string, StyleOverride>;
  pick?: (classes: ScannedClass[], signal: AbortSignal) => Promise<{ models: ProjectModel[]; note?: string }>;
  onStatic?: (entry: string) => void;
};

function setup(opts: Opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cd-proj-"));
  const at = (name: string) => path.join(root, name);
  const names = opts.classes ?? ["Gen", "Disc"];
  const scanned: ScannedClass[] = names.map((name) => ({
    name, file: at(name.toLowerCase() + ".py"), line: 3, forwardParams: ["x"], docstring: "",
    submoduleTypes: ["Blk"], candidate: true,
  }));
  // every model: root (its own file) → blk (class Blk in blocks.py) → out
  const modelGraph = (name: string): Graph => {
    const graph = g(
      [n("blk", { type: "Blk", source: { file: at("blocks.py"), startLine: 1, endLine: 10 } }), n("out")],
      [e("$in", "blk"), e("blk", "out"), e("out", "$out")],
    );
    graph.root = { ...graph.root, name, type: name, source: { file: at(name.toLowerCase() + ".py"), startLine: 3, endLine: 40 } };
    graph.meta.mode = "static";
    graph.meta.entry = { file: at(name.toLowerCase() + ".py"), className: name };
    return graph;
  };
  const calls: string[] = [];
  const posts: HostMessage[] = [];
  const groupScopes: (string | undefined)[] = [];
  const client = {
    listClasses: async (): Promise<Result<ClassInfo[]>> =>
      ok([{ name: "Gen", line: 1, topLevel: true, initParams: [], forwardParams: [] }]),
    scan: async () => { calls.push("scan"); return opts.scan ?? ok(scanned); },
    analyzeStatic: async (req: { entry: string }): Promise<Result<Graph>> => {
      calls.push("static:" + req.entry);
      opts.onStatic?.(req.entry);
      const kind = opts.failing?.[req.entry];
      return kind ? fail(kind) : ok(modelGraph(req.entry));
    },
    trace: async (req: { entry: string }): Promise<Result<Graph>> => {
      calls.push("trace");
      return ok({ ...modelGraph(req.entry), meta: { ...modelGraph(req.entry).meta, mode: "traced" } });
    },
  };
  const host: Host = {
    isTrusted: () => true,
    pickClass: async () => undefined,
    post: (m) => posts.push(m),
    openConfigFile: async () => {},
    group: async (_graph, o) => { groupScopes.push(o.scope); return undefined; },
    pickModels: opts.pick ?? (async (classes) => ({
      models: classes.map((c) => ({ name: c.name, file: c.file, line: c.line, summary: "About " + c.name })),
      note: opts.note,
    })),
    roles: async () => opts.roles ?? {},
    savedRoles: () => opts.saved ?? {},
    styles: () => opts.styles ?? {},
  };
  const controller = new DiagramController(client, host, root);
  const live = new AbortController();
  const graphs = () => posts.flatMap((p) => (p.type === "graph" ? [p.graph] : []));
  const notices = () => posts.flatMap((p) => (p.type === "notice" ? [p] : []));
  const locates = () => posts.flatMap((p) => (p.type === "locate" ? [p.ids] : []));
  return { root, at, calls, posts, controller, live, graphs, notices, locates, groupScopes };
}
const find = (node: Node, id: string): Node | undefined =>
  node.id === id ? node : node.children.map((c) => find(c, id)).find(Boolean);

test("openProject posts one graph with both models, the info notice and a locate", async () => {
  const s = setup();
  await s.controller.openProject({ file: s.at("blocks.py"), line: 2 }, s.live.signal);
  expect(s.posts.map((p) => p.type)).toEqual(["graph", "notice", "locate"]);
  const graph = s.graphs()[0];
  expect(graph.root.name).toBe(path.basename(s.root));
  expect(graph.root.children.map((c) => c.id)).toEqual(["m0/root", "m1/root"]);
  expect(graph.meta.project?.models.map((m) => [m.name, m.summary])).toEqual([["Gen", "About Gen"], ["Disc", "About Disc"]]);
  expect(s.notices()[0]).toEqual({ type: "notice", level: "info", text: M.PROJECT_INFO });
  expect(s.locates()[0]).toEqual(["m0/blk", "m1/blk"]);
  expect(s.controller.isProject).toBe(true);
  expect(s.controller.graph).toBe(graph);
});

test("the active file is in no model: locate has no ids and the notice says so", async () => {
  const s = setup();
  await s.controller.openProject({ file: s.at("train.py"), line: 1 }, s.live.signal);
  expect(s.locates()).toEqual([[]]);
  expect(s.notices().map((x) => x.text)).toEqual([M.NOT_IN_PROJECT]);
});

test("no active file: graph, info notice, locate with no ids, no NOT_IN_PROJECT", async () => {
  const s = setup();
  await s.controller.openProject(undefined, s.live.signal);
  expect(s.posts.map((p) => p.type)).toEqual(["graph", "notice", "locate"]);
  expect(s.notices()[0].text).toBe(M.PROJECT_INFO);
  expect(s.locates()).toEqual([[]]);
});

test("one model fails: the graph still has both blocks, the failed one is a leaf, a warning names it", async () => {
  const s = setup({ failing: { Disc: "syntax" } });
  await s.controller.openProject({ file: s.at("train.py"), line: 1 }, s.live.signal);
  const graph = s.graphs()[0];
  expect(graph.root.children.map((c) => [c.name, c.children.length])).toEqual([["Gen", 2], ["Disc", 0]]);
  expect(s.notices()).toEqual([{ type: "notice", level: "warn", text: M.MODELS_FAILED("Disc (syntax)") }]);
});

test("every model fails: no graph is posted, the analysis-failed notice is", async () => {
  const s = setup({ failing: { Gen: "syntax", Disc: "timeout" } });
  await s.controller.openProject(undefined, s.live.signal);
  expect(s.graphs()).toEqual([]);
  expect(s.notices()).toEqual([
    { type: "notice", level: "warn", text: M.ANALYSIS_FAILED("boom"), action: "copyLog" },
  ]);
  expect(s.controller.isProject).toBe(false);
});

test("scan fails: no graph, analysis-failed notice; python-not-found keeps its action", async () => {
  const a = setup({ scan: fail("internal") });
  await a.controller.openProject(undefined, a.live.signal);
  expect(a.posts).toEqual([{ type: "notice", level: "warn", text: M.ANALYSIS_FAILED("boom"), action: "copyLog" }]);
  const b = setup({ scan: fail("python-not-found") });
  await b.controller.openProject(undefined, b.live.signal);
  expect(b.posts).toEqual([{ type: "notice", level: "error", text: M.PYTHON_NOT_FOUND, action: "selectPython" }]);
});

test("no candidates: warn NO_PROJECT_MODELS, no graph", async () => {
  const s = setup({ classes: [] });
  await s.controller.openProject(undefined, s.live.signal);
  expect(s.posts).toEqual([{ type: "notice", level: "warn", text: M.NO_PROJECT_MODELS }]);
});

test("more than 12 models: only the first 12 are analysed", async () => {
  const s = setup({ classes: Array.from({ length: 15 }, (_, i) => `M${i}`) });
  await s.controller.openProject(undefined, s.live.signal);
  expect(s.calls.filter((c) => c.startsWith("static:"))).toHaveLength(12);
  expect(s.graphs()[0].root.children).toHaveLength(12);
});

test("the model list's note is shown when no model failed", async () => {
  const s = setup({ note: "No language model." });
  await s.controller.openProject({ file: s.at("blocks.py"), line: 2 }, s.live.signal);
  expect(s.notices()).toEqual([{ type: "notice", level: "warn", text: "No language model." }]);
});

test("aborting between two analyses posts nothing and analyses nothing further", async () => {
  const abort = new AbortController();
  const s = setup({ onStatic: () => abort.abort() });
  await s.controller.openProject(undefined, abort.signal);
  expect(s.posts).toEqual([]);
  expect(s.calls).toEqual(["scan", "static:Gen"]);
  expect(s.controller.graph).toBeUndefined();
});

test("a cancelled model request posts nothing", async () => {
  const s = setup({ pick: async () => { throw new LlmError("cancelled", "Cancelled"); } });
  await s.controller.openProject(undefined, s.live.signal);
  expect(s.posts).toEqual([]);
});

test("a newer request makes an older project request stale", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const s = setup({
    pick: async (classes) => {
      await gate;
      return { models: classes.map((c) => ({ name: c.name, file: c.file, line: c.line, summary: "" })) };
    },
  });
  const older = s.controller.openProject(undefined, s.live.signal);
  saveEntry(s.root, s.at("gen.py"), { className: "Gen", ctorKwargs: {}, inputs: {} });
  await s.controller.open(s.at("gen.py"));
  release();
  await older;
  expect(s.graphs()).toHaveLength(1);
  expect(s.graphs()[0].meta.project).toBeUndefined();
  expect(s.controller.isProject).toBe(false);
});

test("roles and style overrides are applied to the project graph", async () => {
  const s = setup({ roles: { Gen: ENCODER, Blk: ENCODER }, styles: { Disc: { role: "discriminator" } } });
  await s.controller.openProject(undefined, s.live.signal);
  const root = s.graphs()[0].root;
  expect(find(root, "m0/root")?.look).toEqual(ENCODER);
  expect(find(root, "m1/root")?.look).toEqual({ role: "discriminator", shape: "trapezoid-narrow", color: "red" });
  expect(find(root, "m1/blk")?.look).toEqual(ENCODER);
});

test("style problems are reported when nothing more important is", async () => {
  const s = setup({ styles: { Gen: { shape: "star" } } });
  await s.controller.openProject({ file: s.at("blocks.py"), line: 2 }, s.live.signal);
  expect(s.notices()).toEqual([
    { type: "notice", level: "warn", text: M.STYLE_PROBLEMS('Gen: unknown shape "star"') },
  ]);
});

test("file view: saved roles and overrides are applied to the graph of open() and traceShapes()", async () => {
  const s = setup({ saved: { Blk: ENCODER }, styles: { Linear: { color: "red" } } });
  saveEntry(s.root, s.at("gen.py"), { className: "Gen", ctorKwargs: {}, inputs: { x: [1, 2] } });
  await s.controller.open(s.at("gen.py"));
  expect(find(s.graphs()[0].root, "blk")?.look).toEqual(ENCODER);
  expect(find(s.graphs()[0].root, "out")?.look).toEqual({ shape: "rect", color: "red" });
  await s.controller.traceShapes();
  expect(s.graphs()[1].meta.mode).toBe("traced");
  expect(find(s.graphs()[1].root, "blk")?.look).toEqual(ENCODER);
});

test("project mode: requestPaper passes the scope, defaulting to the first model", async () => {
  const s = setup();
  await s.controller.openProject(undefined, s.live.signal);
  await s.controller.requestPaper(false, "m1/root");
  await s.controller.requestPaper();
  expect(s.groupScopes).toEqual(["m1/root", "m0/root"]);
});

test("file mode: requestPaper ignores a scope, and a cached paper is offered only there", async () => {
  const s = setup();
  await s.controller.openProject(undefined, s.live.signal);
  expect(s.groupScopes).toEqual([]); // no cache lookup for a project graph
  saveEntry(s.root, s.at("gen.py"), { className: "Gen", ctorKwargs: {}, inputs: {} });
  await s.controller.open(s.at("gen.py"));
  await s.controller.requestPaper(false, "m1/root");
  expect(s.groupScopes).toEqual([undefined, undefined]);
});

test("project mode: saving a file a model shows rebuilds the project; another file does not", async () => {
  const s = setup();
  await s.controller.openProject({ file: s.at("blocks.py"), line: 2 }, s.live.signal);
  s.calls.length = 0;
  s.posts.length = 0;
  await s.controller.onFileSaved(s.at("train.py"));
  expect(s.calls).toEqual([]);
  await s.controller.onFileSaved(s.at("blocks.py"));
  expect(s.calls).toEqual(["scan", "static:Gen", "static:Disc"]);
  expect(s.graphs()).toHaveLength(1);
  expect(s.locates()).toEqual([["m0/blk", "m1/blk"]]); // still located on the last active file
});

test("project mode: traceShapes and selectEntry do nothing", async () => {
  const s = setup();
  await s.controller.openProject(undefined, s.live.signal);
  s.posts.length = 0;
  s.calls.length = 0;
  await s.controller.traceShapes();
  await s.controller.selectEntry();
  expect(s.posts).toEqual([]);
  expect(s.calls).toEqual([]);
});

test("locate() in project mode: targets, or the not-in-project notice", async () => {
  const s = setup();
  await s.controller.openProject(undefined, s.live.signal);
  s.posts.length = 0;
  s.controller.locate({ file: s.at("blocks.py"), line: 2 });
  expect(s.posts).toEqual([{ type: "locate", ids: ["m0/blk", "m1/blk"] }]);
  s.posts.length = 0;
  s.controller.locate({ file: s.at("train.py"), line: 1 });
  expect(s.posts).toEqual([
    { type: "locate", ids: [] },
    { type: "notice", level: "info", text: M.NOT_IN_PROJECT },
  ]);
});

test("locate() in file mode posts the targets and no notice; without a graph nothing", async () => {
  const s = setup();
  s.controller.locate({ file: s.at("blocks.py"), line: 2 });
  expect(s.posts).toEqual([]);
  saveEntry(s.root, s.at("gen.py"), { className: "Gen", ctorKwargs: {}, inputs: {} });
  await s.controller.open(s.at("gen.py"));
  s.posts.length = 0;
  s.controller.locate({ file: s.at("blocks.py"), line: 2 });
  s.controller.locate({ file: s.at("train.py"), line: 1 });
  expect(s.posts).toEqual([{ type: "locate", ids: ["blk"] }, { type: "locate", ids: [] }]);
});

test("opening a file after a project leaves project mode", async () => {
  const s = setup();
  await s.controller.openProject(undefined, s.live.signal);
  saveEntry(s.root, s.at("gen.py"), { className: "Gen", ctorKwargs: {}, inputs: {} });
  await s.controller.open(s.at("gen.py"));
  expect(s.controller.isProject).toBe(false);
  s.calls.length = 0;
  await s.controller.onFileSaved(s.at("gen.py"));
  expect(s.calls).toEqual(["static:Gen"]);
});
