import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import type { AnalyzerError, Result } from "../src/analyzerClient";
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
    id: "root", name: "Net", kind: "module", type: "Net", source: null, params: null,
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

function setup(opts: {
  classes?: Result<ClassInfo[]>; staticResults?: Result<Graph>[]; traceResult?: Result<Graph>;
  trusted?: boolean; pick?: string;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cd-ctl-"));
  const file = path.join(root, "m.py");
  const calls: string[] = [];
  const posts: HostMessage[] = [];
  const picks: string[][] = [];
  let opened = 0;
  const statics = [...(opts.staticResults ?? [ok(graph("static"))])];
  const client = {
    listClasses: async () => { calls.push("list"); return opts.classes ?? ok([cls("Net")]); },
    analyzeStatic: async () => {
      calls.push("static");
      return statics.length > 1 ? statics.shift()! : statics[0];
    },
    trace: async () => { calls.push("trace"); return opts.traceResult ?? ok(graph("traced")); },
  };
  const host: Host = {
    isTrusted: () => opts.trusted ?? true,
    pickClass: async (names) => { picks.push(names); return opts.pick; },
    post: (m) => posts.push(m),
    openConfigFile: async () => { opened++; },
  };
  const controller = new DiagramController(client, host, root);
  const notices = () => posts.filter((p) => p.type === "notice");
  return { root, file, calls, posts, picks, controller, notices, opened: () => opened };
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
