import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import type { Edge, Graph, Node } from "../src/ir";
import {
  applyGrouping, describeGraph, groupGraph, groupingPrompt, validateGroups, type Group,
} from "../src/llm/grouping";
import { LlmError } from "../src/llm/provider";
import { LlmService } from "../src/llm/service";
import { CLAUDE, FakeProvider } from "./fakeProvider";
import { e, g, n, op } from "./helpers";

// $in → a → b → c → d → e → $out
const chain = (extra: Edge[] = []): Graph => g(
  [n("a", { params: 10, trainableParams: 4 }), n("b", { params: 5, trainableParams: 5 }), n("c"), op("d", "relu"), n("e")],
  [e("$in", "a", [1, 2]), e("a", "b", [1, 3]), e("b", "c", [1, 4]), e("c", "d", [1, 5]),
    e("d", "e", [1, 5]), e("e", "$out", [1, 6]), ...extra],
);
const grp = (name: string, nodeIds: string[], description = "d"): Group => ({ name, description, nodeIds });
const raw = (...groups: unknown[]) => ({ groups });
const noSource = () => [];
const ids = (node: Node) => node.children.map((c) => c.id);
const edgeList = (node: Node) => node.edges.map((x) => [x.from, x.to, x.shape, x.uncertain]);

function service(replies: (string | Error)[]) {
  const provider = new FakeProvider([CLAUDE], replies);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cd-grp-")), "cache");
  const llm = new LlmService(provider, {
    preferredModelId: () => CLAUDE.id, pickModel: async () => undefined,
    hasConsent: () => true, askConsent: async () => true,
  }, dir);
  return { provider, llm };
}

// ---- validateGroups ---------------------------------------------------------------------

test("accepts a contiguous group and reports nothing", () => {
  expect(validateGroups(raw(grp("Stem", ["a", "b"])), chain())).toEqual({
    groups: [grp("Stem", ["a", "b"])], rejected: [],
  });
});

test("drops unknown ids, then rejects a group left with one node", () => {
  const out = validateGroups(raw(grp("Stem", ["a", "b", "ghost"]), grp("Tail", ["e", "nope"])), chain());
  expect(out.groups).toEqual([grp("Stem", ["a", "b"])]);
  expect(out.rejected).toEqual([{ name: "Tail", reason: "needs at least two blocks" }]);
});

test("a node claimed twice stays in the first group", () => {
  const out = validateGroups(raw(grp("One", ["a", "b"]), grp("Two", ["b", "c", "d"])), chain());
  expect(out.groups).toEqual([grp("One", ["a", "b"]), grp("Two", ["c", "d"])]);
});

test("rejects non-adjacent blocks", () => {
  const out = validateGroups(raw(grp("Gap", ["a", "c"]), grp("Ok", ["d", "e"])), chain());
  expect(out.groups.map((x) => x.name)).toEqual(["Ok"]);
  expect(out.rejected).toEqual([{ name: "Gap", reason: "blocks are not adjacent in the data flow" }]);
});

test("rejects a group that would create a cycle", () => {
  // a also feeds d directly: {a, d} is connected, but b and c sit between them
  const out = validateGroups(raw(grp("Loop", ["a", "d"]), grp("Ok", ["b", "c"])), chain([e("a", "d", [1, 3])]));
  expect(out.groups.map((x) => x.name)).toEqual(["Ok"]);
  expect(out.rejected).toEqual([{ name: "Loop", reason: "would create a cycle" }]);
});

test("two groups that are fine alone but cyclic together: the later one is rejected", () => {
  // P = {a, b} feeds Q = {c, d} through a → c, and Q feeds P through d → b
  const graph = g([n("a"), n("b"), n("c"), n("d")], [
    e("$in", "a"), e("$in", "d"), e("a", "b"), e("d", "c"), e("a", "c"), e("d", "b"),
    e("b", "$out"), e("c", "$out"),
  ]);
  expect(validateGroups(raw(grp("P", ["a", "b"])), graph).rejected).toEqual([]);
  expect(validateGroups(raw(grp("Q", ["c", "d"])), graph).rejected).toEqual([]);
  const both = validateGroups(raw(grp("P", ["a", "b"]), grp("Q", ["c", "d"])), graph);
  expect(both.groups.map((x) => x.name)).toEqual(["P"]);
  expect(both.rejected).toEqual([{ name: "Q", reason: "would create a cycle" }]);
});

test("truncates long names, trims, and de-duplicates equal names", () => {
  const long = "N".repeat(60);
  const out = validateGroups(raw(grp(`  ${long} `, ["a", "b"]), grp("Same", ["c", "d"]), grp("", ["e", "x"])), chain());
  expect(out.groups[0].name).toBe("N".repeat(40));
  const twice = validateGroups(raw(grp("Pool", ["a", "b"]), grp("Pool", ["c", "d"])), chain());
  expect(twice.groups.map((x) => x.name)).toEqual(["Pool", "Pool 2"]);
});

test("a group without a usable name is rejected", () => {
  const out = validateGroups(raw(grp("Ok", ["a", "b"]), { name: 7, nodeIds: ["c", "d"] }), chain());
  expect(out.groups.map((x) => x.name)).toEqual(["Ok"]);
  expect(out.rejected).toEqual([{ name: "(unnamed)", reason: "has no name" }]);
});

test("a missing description becomes empty; non-string ids are ignored", () => {
  const out = validateGroups(raw({ name: "Ok", nodeIds: ["a", 3, null, "b"] }), chain());
  expect(out.groups).toEqual([grp("Ok", ["a", "b"], "")]);
});

test("not an object / groups not an array → invalid-output", () => {
  for (const bad of [null, "text", [], { groups: "x" }, {}]) {
    expect(() => validateGroups(bad, chain())).toThrow(LlmError);
  }
});

test("zero accepted groups → invalid-output", () => {
  expect(() => validateGroups(raw(grp("Gap", ["a", "c"])), chain())).toThrow(LlmError);
});

test("one group covering everything → invalid-output", () => {
  expect(() => validateGroups(raw(grp("All", ["a", "b", "c", "d", "e"])), chain())).toThrow(LlmError);
});

// ---- applyGrouping ----------------------------------------------------------------------

test("concept replaces members at the first member's position", () => {
  const paper = applyGrouping(chain(), [grp("Mid", ["c", "b"])]);
  expect(ids(paper.root)).toEqual(["a", "root/concept:0", "d", "e"]);
  const concept = paper.root.children[1];
  expect([concept.kind, concept.name, concept.type, concept.description]).toEqual(["concept", "Mid", "concept", "d"]);
  expect(ids(concept)).toEqual(["b", "c"]); // original order
});

test("boundary edges keep shape, dtype and uncertainty; internal edges move inside", () => {
  const graph = chain();
  graph.root.edges[1] = { ...graph.root.edges[1], dtype: "float32", uncertain: true }; // a → b
  const paper = applyGrouping(graph, [grp("Mid", ["b", "c"])]);
  expect(paper.root.edges).toEqual([
    e("$in", "a", [1, 2]),
    { ...e("a", "root/concept:0", [1, 3], true), dtype: "float32" },
    e("root/concept:0", "d", [1, 5]),
    e("d", "e", [1, 5]),
    e("e", "$out", [1, 6]),
  ]);
  expect(paper.root.children[1].edges).toEqual([
    { ...e("$in", "b", [1, 3], true), dtype: "float32" },
    e("b", "c", [1, 4]),
    e("c", "$out", [1, 5]),
  ]);
});

test("parallel boundary edges are deduped, different shapes are kept", () => {
  // a feeds both b and c with the same tensor; c also feeds e with a different shape than d does
  const graph = chain([e("a", "c", [1, 3]), e("c", "e", [1, 9])]);
  const paper = applyGrouping(graph, [grp("Mid", ["b", "c"]), grp("Tail", ["d", "e"])]);
  expect(edgeList(paper.root)).toEqual([
    ["$in", "a", [1, 2], false],
    ["a", "root/concept:0", [1, 3], false],
    ["root/concept:0", "root/concept:1", [1, 5], false],
    ["root/concept:1", "$out", [1, 6], false],
    ["root/concept:0", "root/concept:1", [1, 9], false],
  ]);
});

test("concept inner $in/$out edges mirror the crossing edges", () => {
  const graph = chain([e("a", "c", [1, 3])]);
  const mid = applyGrouping(graph, [grp("Mid", ["b", "c"])]).root.children[1];
  expect(edgeList(mid)).toEqual([
    ["$in", "b", [1, 3], false], ["$in", "c", [1, 3], false], ["b", "c", [1, 4], false], ["c", "$out", [1, 5], false],
  ]);
});

test("params are summed; all-null stays null; the source is the first member's", () => {
  const graph = chain();
  graph.root.children[0].source = { file: "m.py", startLine: 3, endLine: 9 };
  const paper = applyGrouping(graph, [grp("Stem", ["a", "b"]), grp("Tail", ["c", "d"])]);
  const [stem, tail] = paper.root.children;
  expect([stem.params, stem.trainableParams, stem.source]).toEqual([15, 9, { file: "m.py", startLine: 3, endLine: 9 }]);
  expect([tail.params, tail.trainableParams, tail.source]).toEqual([null, null, null]);
});

test("the input graph is not mutated and meta is kept", () => {
  const graph = chain();
  const before = JSON.stringify(graph);
  const paper = applyGrouping(graph, [grp("Stem", ["a", "b"])]);
  expect(JSON.stringify(graph)).toBe(before);
  expect(paper.meta).toEqual(graph.meta);
});

test("every block and every edge shape of the paper view exists in the code view", () => {
  const graph = chain([e("a", "c", [1, 3])]);
  const paper = applyGrouping(graph, [grp("Mid", ["b", "c"]), grp("Tail", ["d", "e"])]);
  const codeIds = new Set(graph.root.children.map((c) => c.id));
  const codeShapes = new Set(graph.root.edges.map((x) => JSON.stringify(x.shape)));
  const members = paper.root.children.flatMap((c) => (c.kind === "concept" ? c.children : [c]));
  expect(members.map((m) => m.id).sort()).toEqual([...codeIds].sort());
  for (const node of [paper.root, ...paper.root.children.filter((c) => c.kind === "concept")]) {
    for (const edge of node.edges) expect(codeShapes.has(JSON.stringify(edge.shape))).toBe(true);
  }
});

// ---- describeGraph / prompt -------------------------------------------------------------

test("describeGraph includes ids, shapes, neighbors and at most 15 source lines per node", () => {
  const graph = chain();
  graph.root.children[1].source = { file: "m.py", startLine: 10, endLine: 60 };
  const asked: [string, number, number][] = [];
  const text = describeGraph(graph, (file, start, end) => {
    asked.push([file, start, end]);
    return Array.from({ length: end - start + 1 }, (_, i) => `line ${start + i}`);
  });
  expect(asked).toEqual([["m.py", 10, 24]]);
  expect(text).toContain("line 24");
  expect(text).not.toContain("line 25");
  expect(text).toMatch(/id: b\b/);
  expect(text).toContain("in: [1, 3]");
  expect(text).toContain("out: [1, 4]");
  expect(text).toContain("from: a");
  expect(text).toContain("to: c");
  expect(text).toContain("Net");
});

test("the retry prompt names what was wrong", () => {
  const p = groupingPrompt("DESC", [{ name: "Gap", reason: "blocks are not adjacent in the data flow" }]);
  expect(p).toContain("DESC");
  expect(p).toContain("Gap: blocks are not adjacent in the data flow");
  expect(groupingPrompt("DESC")).not.toContain("Gap");
});

// ---- groupGraph -------------------------------------------------------------------------

const GOOD = JSON.stringify(raw(grp("Stem", ["a", "b"]), grp("Tail", ["d", "e"])));

test("groupGraph returns the paper view of a valid answer", async () => {
  const s = service(["Here you go:\n```json\n" + GOOD + "\n```"]);
  const out = await groupGraph(chain(), s.llm, noSource);
  expect(out?.groups.map((x) => x.name)).toEqual(["Stem", "Tail"]);
  expect(ids(out!.paper.root)).toEqual(["root/concept:0", "c", "root/concept:1"]);
});

test("groupGraph retries once with the rejection reasons, then succeeds", async () => {
  const s = service(["not json at all", GOOD]);
  const out = await groupGraph(chain(), s.llm, noSource);
  expect(out?.groups).toHaveLength(2);
  expect(s.provider.prompts).toHaveLength(2);
  expect(s.provider.prompts[1]).toContain("could not be used");
});

test("a mostly rejected answer is retried with the reasons", async () => {
  const s = service([JSON.stringify(raw(grp("Gap", ["a", "c"]), grp("Tail", ["d", "e"]))), GOOD]);
  const out = await groupGraph(chain(), s.llm, noSource);
  expect(s.provider.prompts[1]).toContain("Gap: blocks are not adjacent in the data flow");
  expect(out?.groups.map((x) => x.name)).toEqual(["Stem", "Tail"]);
});

test("if the retry is no better, the first answer's valid groups are used", async () => {
  const partial = JSON.stringify(raw(grp("Gap", ["a", "c"]), grp("Tail", ["d", "e"])));
  const s = service([partial, "garbage"]);
  const out = await groupGraph(chain(), s.llm, noSource);
  expect(out?.groups.map((x) => x.name)).toEqual(["Tail"]);
});

test("groupGraph gives up after the retry → LlmError invalid-output", async () => {
  const s = service(["garbage", "more garbage"]);
  const err = await groupGraph(chain(), s.llm, noSource).catch((x) => x);
  expect(err instanceof LlmError && err.kind).toBe("invalid-output");
  expect(s.provider.prompts).toHaveLength(2);
});

test("a second call is served from the cache", async () => {
  const s = service([GOOD]);
  await groupGraph(chain(), s.llm, noSource);
  await groupGraph(chain(), s.llm, noSource);
  expect(s.provider.prompts).toHaveLength(1);
});

test("cacheOnly: miss → undefined without calling the provider; hit → paper graph", async () => {
  const s = service([GOOD]);
  expect(await groupGraph(chain(), s.llm, noSource, { cacheOnly: true })).toBeUndefined();
  expect(s.provider.prompts).toHaveLength(0);
  await groupGraph(chain(), s.llm, noSource);
  const hit = await groupGraph(chain(), s.llm, noSource, { cacheOnly: true });
  expect(hit?.groups).toHaveLength(2);
  expect(s.provider.prompts).toHaveLength(1);
});

test("cacheOnly with an unusable cached answer → undefined, never throws", async () => {
  const s = service(["garbage", GOOD]);
  await groupGraph(chain(), s.llm, noSource); // caches "garbage" for the first prompt, GOOD for the retry
  expect(await groupGraph(chain(), s.llm, noSource, { cacheOnly: true })).toBeDefined();
});

test("groupGraph refuses graphs with fewer than four top-level nodes", async () => {
  const s = service([GOOD]);
  const small = g([n("a"), n("b"), n("c")], [e("$in", "a"), e("a", "b"), e("b", "c"), e("c", "$out")]);
  const err = await groupGraph(small, s.llm, noSource).catch((x) => x);
  expect(err instanceof LlmError && err.kind).toBe("invalid-output");
  expect(s.provider.prompts).toHaveLength(0);
  expect(await groupGraph(small, s.llm, noSource, { cacheOnly: true })).toBeUndefined();
});

// ---- a model wrapped in a single block (e.g. VSSBlock → _forward) ----------------------

const wrapped = (): Graph => {
  const inner = chain().root;
  const wrapper = n("root/_forward", {
    name: "_forward", kind: "group", children: inner.children, edges: inner.edges,
  });
  return g(
    [wrapper, op("root/checkpoint", "checkpoint")],
    [e("$in", "root/_forward", [1, 2]), e("root/_forward", "$out", [1, 6]), e("$in", "root/checkpoint")],
  );
};

test("a lone wrapper block is opened: its children are grouped in place", async () => {
  const s = service([GOOD]);
  const out = await groupGraph(wrapped(), s.llm, noSource);
  expect(out?.groups.map((x) => x.name)).toEqual(["Stem", "Tail"]);
  expect(ids(out!.paper.root)).toEqual(["root/_forward", "root/checkpoint"]);
  const inside = out!.paper.root.children[0];
  expect(ids(inside)).toEqual(["root/_forward/concept:0", "c", "root/_forward/concept:1"]);
  expect(edgeList(out!.paper.root)).toEqual(edgeList(wrapped().root)); // outside edges untouched
  expect(s.provider.prompts[0]).toContain("Inside: _forward");
});

test("a wrapper with fewer than four children is still too small", async () => {
  const w = wrapped();
  w.root.children[0].children = w.root.children[0].children.slice(0, 3);
  const err = await groupGraph(w, service([GOOD]).llm, noSource).catch((x) => x);
  expect(err instanceof LlmError && err.kind).toBe("invalid-output");
});

// ---- roles on groups, and grouping inside a chosen block --------------------------------

test("a group may carry a role: the concept node gets its look", () => {
  const checked = validateGroups(raw(
    { name: "Stem", description: "d", nodeIds: ["a", "b"], role: "encoder", shape: "circle" },
    { name: "Tail", description: "d", nodeIds: ["d", "e"], role: "vocoder", shape: "hexagon", color: "teal" },
  ), chain());
  const paper = applyGrouping(chain(), checked.groups);
  expect(paper.root.children[0].look).toEqual({ role: "encoder", shape: "trapezoid-narrow", color: "blue" });
  expect(paper.root.children[2].look).toEqual({ role: "vocoder", shape: "hexagon", color: "teal" });
  expect(groupingPrompt("x")).toContain('"role"');
});

test("a group without a role has no look", () => {
  const checked = validateGroups(raw(grp("Stem", ["a", "b"])), chain());
  expect(applyGrouping(chain(), checked.groups).root.children[0].look).toBeUndefined();
});

const twoModels = (): Graph => {
  const model = (prefix: string) => {
    const inner = chain().root;
    const id = (x: string) => (x.startsWith("$") ? x : prefix + x);
    return n(prefix + "root", {
      children: inner.children.map((c) => ({ ...c, id: prefix + c.id })),
      edges: inner.edges.map((x) => ({ ...x, from: id(x.from), to: id(x.to) })),
    });
  };
  return g([model("m0/"), model("m1/")], []);
};
const SCOPED = JSON.stringify(raw(grp("Stem", ["m1/a", "m1/b"]), grp("Tail", ["m1/d", "m1/e"])));

test("scope: only the named block's children are grouped, ids are relative to it", async () => {
  const s = service([SCOPED]);
  const out = await groupGraph(twoModels(), s.llm, noSource, { scope: "m1/root" });
  expect(ids(out!.paper.root)).toEqual(["m0/root", "m1/root"]);
  expect(ids(out!.paper.root.children[0])).toEqual(ids(twoModels().root.children[0]));
  expect(ids(out!.paper.root.children[1])).toEqual(["m1/root/concept:0", "m1/c", "m1/root/concept:1"]);
  expect(s.provider.prompts[0]).toContain("id: m1/a");
  expect(s.provider.prompts[0]).not.toContain("id: m0/a");
});

test("scope: an unknown id is refused without a request", async () => {
  const s = service([SCOPED]);
  const err = await groupGraph(twoModels(), s.llm, noSource, { scope: "m9/root" }).catch((x) => x);
  expect(err instanceof LlmError && err.kind).toBe("invalid-output");
  expect(s.provider.prompts).toHaveLength(0);
});

// ---- acceptance on the recorded FAST-SDE graph ------------------------------------------

test("FAST-SDE: the recorded grouping is valid, gives 5–8 blocks, keeps the traced boundary shapes", () => {
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
  const graph = read("fastsde-traced.json") as Graph;
  const checked = validateGroups(read("fastsde-groups.json"), graph);
  expect(checked.rejected).toEqual([]);
  const paper = applyGrouping(graph, checked.groups);
  expect(paper.root.children.map((c) => c.name)).toEqual([
    "extract_features", "Subband Split", "Shared Subband Encoder", "Frequency Pooling",
    "Subband Fusion", "gru", "Temporal Pooling", "head",
  ]);
  const shapes = paper.root.edges.map((x) => JSON.stringify(x.shape));
  for (const expected of [[1, 3200], [1, 3, 26, 256], [8, 3, 26, 32], [1, 8, 24, 26, 32], [1, 8, 24, 26],
    [1, 26, 64], [1, 26, 96], [1, 96], [1, 1]]) {
    expect(shapes).toContain(JSON.stringify(expected));
  }
  expect(paper.root.edges).toHaveLength(9); // a straight line of 8 blocks
});
