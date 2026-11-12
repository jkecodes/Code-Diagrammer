import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import type { AnalyzerError, Result } from "../src/analyzerClient";
import { LlmError } from "../src/llm/provider";
import { DiagramController, type Host } from "../src/controller";
import { loadEntry, saveEntry } from "../src/entryConfig";
import type { ClassInfo, Graph } from "../src/ir";
import * as M from "../src/messages";
import type { HostMessage } from "../src/protocol";

const graph = (mode: "static" | "traced", traceError: string | null = null): Graph => ({
  version: 1,
  meta: {
    mode, analyzerVersion: "0.1.0", entry: { file: "m.py", className: "Net" },
    ctorKwargs: null, inputs: null, device: null, traceError,
  },
  root: {
    id: "root", name: "Net", kind: "module", type: "Net", source: null, params: null, trainableParams: null,
    shapeOnly: false, repeated: false, children: [], edges: [],
  },
});
const cls = (name: string, topLevel = true): ClassInfo => ({
  name, line: 1, topLevel, initParams: [], forwardParams: [{ name: "x", hasDefault: false }],
});
function ok<T>(value: T, log?: string): Result<T> {
  return { ok: true, value, log };
}
function fail(kind: AnalyzerError["kind"], message = "boom"): Result<never> {
  return { ok: false, error: { kind, message, log: "the log" } };
}

type GroupOpts = { regenerate?: boolean; cacheOnly?: boolean; signal: AbortSignal };
type GroupStub = (graph: Graph, opts: GroupOpts) => Promise<Graph | undefined>;
const noGroup: GroupStub = async () => undefined;
const NO_PROJECT = {
  pickModels: async () => ({ models: [] }), roles: async () => ({}), savedRoles: () => ({}), styles: () => ({}),
};
const paperOf = (graph: Graph): Graph => ({ ...graph, root: { ...graph.root, name: "Paper of " + graph.meta.mode } });

function setup(opts: {
  classes?: Result<ClassInfo[]>; staticResults?: Result<Graph>[]; traceResult?: Result<Graph>;
  trusted?: boolean; pick?: string; group?: GroupStub;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cd-ctl-"));
  const file = path.join(root, "m.py");
  const calls: string[] = [];
  const posts: HostMessage[] = [];
  const picks: string[][] = [];
  let opened = 0;
  const groupCalls: GroupOpts[] = [];
  const statics = [...(opts.staticResults ?? [ok(graph("static"))])];
  const client = {
    listClasses: async () => { calls.push("list"); return opts.classes ?? ok([cls("Net")]); },
    analyzeStatic: async () => {
      calls.push("static");
      return statics.length > 1 ? statics.shift()! : statics[0];
    },
    trace: async () => { calls.push("trace"); return opts.traceResult ?? ok(graph("traced")); },
    scan: async () => ok([]),
  };
  const host: Host = {
    isTrusted: () => opts.trusted ?? true,
    pickClass: async (names) => { picks.push(names); return opts.pick; },
    post: (m) => posts.push(m),
    openConfigFile: async () => { opened++; },
    group: async (graph, o) => { groupCalls.push(o); return (opts.group ?? noGroup)(graph, o); },
    pickModels: async () => ({ models: [] }),
    roles: async () => ({}),
    savedRoles: () => ({}),
    styles: () => ({}),
  };
  const controller = new DiagramController(client, host, root);
  const notices = () => posts.filter((p) => p.type === "notice");
  const papers = () => posts.flatMap((p) => (p.type === "paper" ? [p.graph.root.name] : []));
  return { root, file, calls, posts, picks, controller, notices, opened: () => opened, groupCalls, papers };
}

test("open with one top-level class posts graph and NO_SHAPES", async () => {
  const s = setup();
  await s.controller.open(s.file);
  expect(s.posts).toEqual([
    { type: "graph", graph: graph("static") },
    { type: "notice", level: "info", text: M.NO_SHAPES, action: "trace" },
  ]);
  expect(loadEntry(s.root, s.file)?.className).toBe("Net");
});

test("open with two top-level classes asks pickClass", async () => {
  const s = setup({ classes: ok([cls("A"), cls("B"), cls("Inner", false)]), pick: "B" });
  await s.controller.open(s.file);
  expect(s.picks).toEqual([["A", "B"]]);
  expect(loadEntry(s.root, s.file)?.className).toBe("B");
});

test("a saved entry wins over listing classes", async () => {
  const s = setup();
  saveEntry(s.root, s.file, { className: "Saved", ctorKwargs: {}, inputs: {} });
  await s.controller.open(s.file);
  expect(s.calls).toEqual(["static"]);
});

test("file without module classes shows NO_MODELS", async () => {
  const s = setup({ classes: ok([]) });
  await s.controller.open(s.file);
  expect(s.notices()).toEqual([{ type: "notice", level: "warn", text: M.NO_MODELS }]);
});

test("trace in untrusted workspace is refused", async () => {
  const s = setup({ trusted: false });
  await s.controller.open(s.file);
  await s.controller.traceShapes();
  expect(s.calls).not.toContain("trace");
  expect(s.notices().at(-1)).toEqual({ type: "notice", level: "warn", text: M.UNTRUSTED });
});

test("trace without saved inputs writes template and opens config", async () => {
  const s = setup();
  await s.controller.open(s.file);
  await s.controller.traceShapes();
  expect(s.opened()).toBe(1);
  expect(s.calls).not.toContain("trace");
  expect(loadEntry(s.root, s.file)?.inputs).toEqual({ x: [1, 3, 224, 224] });
  expect(s.notices().at(-1)).toEqual(
    { type: "notice", level: "info", text: M.NEED_INPUTS, action: "editInputs" });
});

test("successful trace posts the graph and clears the notice", async () => {
  const s = setup();
  saveEntry(s.root, s.file, { className: "Net", ctorKwargs: {}, inputs: { x: [1, 4] } });
  await s.controller.open(s.file);
  await s.controller.traceShapes();
  expect(s.posts.slice(-2)).toEqual([{ type: "graph", graph: graph("traced") }, { type: "clearNotice" }]);
  expect(s.controller.graph?.meta.mode).toBe("traced");
});

test("trace failure keeps structure and offers the log", async () => {
  const s = setup({ traceResult: ok(graph("static", "input: Missing input"), "traceback text") });
  saveEntry(s.root, s.file, { className: "Net", ctorKwargs: {}, inputs: { x: [1, 4] } });
  await s.controller.open(s.file);
  await s.controller.traceShapes();
  expect(s.posts.at(-2)).toEqual({ type: "graph", graph: graph("static", "input: Missing input") });
  expect(s.notices().at(-1)).toEqual({
    type: "notice", level: "warn", text: M.TRACE_FAILED("input: Missing input"), action: "copyLog",
  });
  expect(s.controller.lastLog).toBe("traceback text");
});

test("keeps last good graph on analyzer error", async () => {
  const s = setup({ staticResults: [ok(graph("static")), fail("syntax", "line 3: invalid syntax")] });
  await s.controller.open(s.file);
  await s.controller.onFileSaved(s.file);
  expect(s.controller.graph).toEqual(graph("static"));
  expect(s.notices().at(-1)).toEqual({
    type: "notice", level: "warn", text: M.ANALYSIS_FAILED("line 3: invalid syntax"), action: "copyLog",
  });
  expect(s.controller.lastLog).toBe("the log");
});

test("save after trace clears shapes", async () => {
  const s = setup();
  saveEntry(s.root, s.file, { className: "Net", ctorKwargs: {}, inputs: { x: [1, 4] } });
  await s.controller.open(s.file);
  await s.controller.traceShapes();
  await s.controller.onFileSaved(s.file);
  expect(s.notices().at(-1)).toEqual(
    { type: "notice", level: "info", text: M.SHAPES_CLEARED, action: "trace" });
  expect(s.controller.graph?.meta.mode).toBe("static");
});

test("python not found", async () => {
  const s = setup({ classes: fail("python-not-found") });
  await s.controller.open(s.file);
  expect(s.notices()).toEqual([
    { type: "notice", level: "error", text: M.PYTHON_NOT_FOUND, action: "selectPython" }]);
});

test("save of a different file is ignored", async () => {
  const s = setup();
  await s.controller.open(s.file);
  const before = s.calls.length;
  await s.controller.onFileSaved(path.join(s.root, "other.py"));
  expect(s.calls.length).toBe(before);
});

test("a slow older request cannot overwrite a newer graph", async () => {
  const s = setup();
  const named = (name: string) => { const g = graph("static"); g.root.name = name; return g; };
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let n = 0;
  const controller = new DiagramController({
    listClasses: async () => ok([cls("Net")]),
    analyzeStatic: async () => {
      const k = n++;
      if (k === 1) { await gate; return ok(named("Old")); }
      return ok(named(k === 0 ? "Base" : "New"));
    },
    trace: async () => ok(graph("traced")), scan: async () => ok([]),
  }, { isTrusted: () => true, pickClass: async () => undefined, post: (m) => s.posts.push(m),
       openConfigFile: async () => undefined, group: noGroup, ...NO_PROJECT }, s.root);
  saveEntry(s.root, s.file, { className: "Net", ctorKwargs: {}, inputs: {} });
  await controller.open(s.file);
  const slow = controller.onFileSaved(s.file);
  await controller.onFileSaved(s.file);
  release();
  await slow;
  expect(controller.graph?.root.name).toBe("New");
  const names = s.posts.flatMap((p) => (p.type === "graph" ? [p.graph.root.name] : []));
  expect(names).toEqual(["Base", "New"]);
});

test("a disposed controller posts nothing more", async () => {
  const s = setup();
  saveEntry(s.root, s.file, { className: "Net", ctorKwargs: {}, inputs: {} });
  const pending = s.controller.open(s.file);
  s.controller.dispose();
  await pending;
  expect(s.posts).toEqual([]);
});

test("a failed open does not take over the file the saved diagram belongs to", async () => {
  const s = setup();
  await s.controller.open(s.file);
  const other = path.join(s.root, "other.py");
  const failing = new DiagramController({
    listClasses: async () => fail("syntax"),
    analyzeStatic: async () => fail("syntax"),
    trace: async () => fail("syntax"), scan: async () => fail("syntax"),
  }, { isTrusted: () => true, pickClass: async () => undefined, post: () => undefined,
       openConfigFile: async () => undefined, group: noGroup, ...NO_PROJECT }, s.root);
  await failing.open(other);
  expect(failing.openFile).toBeUndefined();
});

test("saving a file whose class is a node of the graph refreshes the diagram", async () => {
  const s = setup();
  const g = graph("static");
  const imported = path.join(s.root, "blocks.py");
  g.root.children = [{ ...g.root, id: "enc", name: "enc", source: { file: imported, startLine: 1, endLine: 5 } }];
  const t = setup({ staticResults: [ok(g)] });
  g.root.children[0].source = { file: path.join(t.root, "blocks.py"), startLine: 1, endLine: 5 };
  await t.controller.open(t.file);
  const before = t.calls.length;
  await t.controller.onFileSaved(path.join(t.root, "blocks.py"));
  expect(t.calls.length).toBe(before + 1);
});

// ---- paper view ------------------------------------------------------------------------

const cachedOnly: GroupStub = async (graph, o) => (o.cacheOnly ? paperOf(graph) : undefined);
const liveOnly: GroupStub = async (graph, o) => (o.cacheOnly ? undefined : paperOf(graph));

test("after a graph is posted, a cached grouping is posted as the paper view", async () => {
  const s = setup({ group: cachedOnly });
  await s.controller.open(s.file);
  expect(s.posts.map((p) => p.type)).toEqual(["graph", "notice", "paper"]);
  expect(s.groupCalls.map((o) => o.cacheOnly)).toEqual([true]);
  expect(s.controller.graph?.root.name).toBe("Net"); // the code view is never replaced
});

test("no cached grouping: no paper message, and only the cache was consulted", async () => {
  const s = setup();
  await s.controller.open(s.file);
  expect(s.papers()).toEqual([]);
  expect(s.groupCalls.every((o) => o.cacheOnly === true)).toBe(true);
});

test("a failing cache lookup is ignored", async () => {
  const s = setup({ group: async () => { throw new Error("disk"); } });
  await s.controller.open(s.file);
  expect(s.posts.map((p) => p.type)).toEqual(["graph", "notice"]);
});

test("requestPaper posts busy, the paper graph, then busy:null", async () => {
  const s = setup({ group: liveOnly });
  await s.controller.open(s.file);
  s.posts.length = 0;
  await s.controller.requestPaper();
  expect(s.posts).toEqual([
    { type: "busy", text: M.GROUPING },
    { type: "paper", graph: paperOf(graph("static")) },
    { type: "busy", text: null },
  ]);
  expect(s.groupCalls.at(-1)?.regenerate).toBe(false);
});

test("requestPaper(true) asks to regenerate", async () => {
  const s = setup({ group: liveOnly });
  await s.controller.open(s.file);
  await s.controller.requestPaper(true);
  expect(s.groupCalls.at(-1)?.regenerate).toBe(true);
});

test("requestPaper before any graph does nothing", async () => {
  const s = setup();
  await s.controller.requestPaper();
  expect([s.posts, s.groupCalls]).toEqual([[], []]);
});

const failing = (error: Error): GroupStub => async (_g, o) => {
  if (o.cacheOnly) return undefined;
  throw error;
};

test("requestPaper without a language model offers Choose Language Model", async () => {
  const s = setup({ group: failing(new LlmError("no-model", "none")) });
  await s.controller.open(s.file);
  s.posts.length = 0;
  await s.controller.requestPaper();
  expect(s.posts).toEqual([
    { type: "busy", text: M.GROUPING },
    { type: "notice", level: "warn", text: M.NO_LANGUAGE_MODEL, action: "chooseModel" },
    { type: "busy", text: null },
  ]);
});

test("invalid model output keeps the code view and reports it", async () => {
  const s = setup({ group: failing(new LlmError("invalid-output", "Too small to group")) });
  await s.controller.open(s.file);
  await s.controller.requestPaper();
  expect(s.notices().at(-1)).toEqual(
    { type: "notice", level: "warn", text: M.GROUPING_FAILED("Too small to group") });
  expect(s.papers()).toEqual([]);
  expect(s.controller.graph?.meta.mode).toBe("static");
});

test("a provider error is reported with its message", async () => {
  const s = setup({ group: failing(new LlmError("provider", "quota exceeded")) });
  await s.controller.open(s.file);
  await s.controller.requestPaper();
  expect(s.notices().at(-1)).toEqual({ type: "notice", level: "warn", text: M.LLM_FAILED("quota exceeded") });
});

test("an unexpected error is reported, not thrown", async () => {
  const s = setup({ group: failing(new Error("boom")) });
  await s.controller.open(s.file);
  await s.controller.requestPaper();
  expect(s.notices().at(-1)).toEqual({ type: "notice", level: "warn", text: M.LLM_FAILED("boom") });
});

test("declined consent and cancelling are silent", async () => {
  for (const kind of ["consent-declined", "cancelled"] as const) {
    const s = setup({ group: failing(new LlmError(kind, "x")) });
    await s.controller.open(s.file);
    s.posts.length = 0;
    await s.controller.requestPaper();
    expect(s.posts).toEqual([{ type: "busy", text: M.GROUPING }, { type: "busy", text: null }]);
  }
});

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const signals: AbortSignal[] = [];
  const group: GroupStub = async (graph, o) => {
    if (o.cacheOnly) return undefined;
    signals.push(o.signal);
    if (signals.length === 1) await gate;
    return paperOf(graph);
  };
  return { group, signals, release: () => release() };
}

test("a save during grouping discards the stale grouping", async () => {
  const gate = gated();
  const s = setup({ group: gate.group });
  await s.controller.open(s.file);
  const pending = s.controller.requestPaper();
  await s.controller.onFileSaved(s.file);
  expect(gate.signals[0].aborted).toBe(true);
  gate.release();
  await pending;
  expect(s.papers()).toEqual([]);
  expect(s.posts.filter((p) => p.type === "busy")).toEqual([
    { type: "busy", text: M.GROUPING }, { type: "busy", text: null },
  ]);
});

test("a second requestPaper aborts the first", async () => {
  const gate = gated();
  const s = setup({ group: gate.group });
  await s.controller.open(s.file);
  const first = s.controller.requestPaper();
  await s.controller.requestPaper(true);
  expect(gate.signals[0].aborted).toBe(true);
  gate.release();
  await first;
  expect(s.papers()).toHaveLength(1);
  expect(s.posts.at(-1)).toEqual({ type: "busy", text: null });
});

test("tracing shapes re-checks the cache for the traced graph", async () => {
  const s = setup({ group: cachedOnly });
  saveEntry(s.root, s.file, { className: "Net", ctorKwargs: {}, inputs: { x: [1, 4] } });
  await s.controller.open(s.file);
  await s.controller.traceShapes();
  expect(s.papers()).toEqual(["Paper of static", "Paper of traced"]);
});

test("a disposed controller ignores a finished grouping", async () => {
  const gate = gated();
  const s = setup({ group: gate.group });
  await s.controller.open(s.file);
  const pending = s.controller.requestPaper();
  s.controller.dispose();
  gate.release();
  await pending;
  expect(s.papers()).toEqual([]);
});

test("cancelPaper aborts the request, clears busy and posts no paper", async () => {
  const gate = gated();
  const s = setup({ group: gate.group });
  await s.controller.open(s.file);
  s.posts.length = 0;
  const pending = s.controller.requestPaper();
  s.controller.cancelPaper();
  expect(gate.signals[0].aborted).toBe(true);
  gate.release();
  await pending;
  expect(s.posts).toEqual([{ type: "busy", text: M.GROUPING }, { type: "busy", text: null }]);
});

test("cancelPaper with nothing in flight posts nothing", async () => {
  const s = setup();
  await s.controller.open(s.file);
  s.posts.length = 0;
  s.controller.cancelPaper();
  expect(s.posts).toEqual([]);
});
