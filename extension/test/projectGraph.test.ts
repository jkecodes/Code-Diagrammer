import { expect, test } from "vitest";
import type { Graph, Node } from "../src/ir";
import { buildProjectGraph, modelIdOf, type ProjectPart } from "../src/project/projectGraph";
import { e, g, n } from "./helpers";

const part = (name: string, graph: Graph | null, summary = ""): ProjectPart =>
  ({ name, file: `/ws/${name}.py`, line: 7, summary, graph });
const two = () => g([n("a"), n("b")], [e("$in", "a"), e("a", "b", [1, 2]), e("b", "$out")]);
const nested = () => g(
  [n("a", { children: [n("a.x"), n("a.y")], edges: [e("$in", "a.x"), e("a.x", "a.y"), e("a.y", "$out")] }), n("b")],
  [e("$in", "a"), e("a", "b"), e("b", "$out")],
);
const allIds = (node: Node, into: string[] = []): string[] => {
  into.push(node.id);
  node.children.forEach((c) => allIds(c, into));
  return into;
};

test("each model becomes a top-level block with prefixed ids and no edges between models", () => {
  const out = buildProjectGraph("proj", [part("Gen", two(), "Makes audio."), part("Disc", two())]);
  expect(out.root).toMatchObject({ id: "root", name: "proj", kind: "group", type: "project", edges: [] });
  expect(out.root.children.map((c) => [c.id, c.name, c.description])).toEqual(
    [["m0/root", "Gen", "Makes audio."], ["m1/root", "Disc", undefined]]);
  expect(out.root.children[0].children.map((c) => c.id)).toEqual(["m0/a", "m0/b"]);
});

test("edge endpoints are prefixed, $in and $out are not; shapes are kept", () => {
  const edges = buildProjectGraph("p", [part("Gen", two())]).root.children[0].edges;
  expect(edges.map((x) => [x.from, x.to, x.shape])).toEqual(
    [["$in", "m0/a", null], ["m0/a", "m0/b", [1, 2]], ["m0/b", "$out", null]]);
});

test("ids are unique across models with equal structure, at every depth", () => {
  const out = buildProjectGraph("p", [part("A", nested()), part("B", nested())]);
  const ids = allIds(out.root);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain("m1/a.y");
  expect(out.root.children[1].children[0].edges.map((x) => [x.from, x.to])).toEqual(
    [["$in", "m1/a.x"], ["m1/a.x", "m1/a.y"], ["m1/a.y", "$out"]]);
});

test("a failed model is a leaf block pointing at its class", () => {
  const leaf = buildProjectGraph("p", [part("Bad", null)]).root.children[0];
  expect(leaf).toMatchObject({
    id: "m0/root", name: "Bad", type: "Bad", kind: "module", children: [], edges: [],
    source: { file: "/ws/Bad.py", startLine: 7, endLine: 7 },
  });
});

test("meta: static mode, project model list, entry of the first model", () => {
  const meta = buildProjectGraph("p", [part("Gen", two(), "s")]).meta;
  expect(meta.mode).toBe("static");
  expect(meta.entry).toEqual({ file: "/ws/Gen.py", className: "Gen" });
  expect(meta.project).toEqual({ models: [{ id: "m0/root", name: "Gen", file: "/ws/Gen.py", summary: "s" }] });
});

test("inputs are not mutated", () => {
  const graph = nested();
  const before = JSON.stringify(graph);
  buildProjectGraph("p", [part("A", graph)]);
  expect(JSON.stringify(graph)).toBe(before);
});

test("no parts is a caller error", () => {
  expect(() => buildProjectGraph("p", [])).toThrow();
});

test("modelIdOf: a nested id, a model id itself, the project root, an unknown id", () => {
  const out = buildProjectGraph("p", [part("A", nested()), part("B", nested())]);
  expect(modelIdOf(out, "m1/a.y")).toBe("m1/root");
  expect(modelIdOf(out, "m1/root")).toBe("m1/root");
  expect(modelIdOf(out, "root")).toBeUndefined();
  expect(modelIdOf(out, "nope")).toBeUndefined();
});
