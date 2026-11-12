import { expect, test } from "vitest";
import type { Graph, Node } from "../src/ir";
import { ancestorsOf, locateTargets, MAX_LOCATE_EXPAND } from "../src/locate";
import { buildProjectGraph } from "../src/project/projectGraph";
import { g, n, op } from "./helpers";

const src = (file: string, startLine: number, endLine: number) => ({ source: { file, startLine, endLine } });
const BLK = src("/ws/enc.py", 50, 60);

// root (m.py) → enc (Enc, enc.py 10-40) → blk1, blk2 (Blk, enc.py 50-60), relu op, a group; dec (dec.py)
const model = (): Graph => {
  const graph = g([
    n("enc", {
      type: "Enc", ...src("/ws/enc.py", 10, 40),
      children: [
        n("blk1", { type: "Blk", ...BLK }),
        n("blk2", { type: "Blk", ...BLK }),
        op("relu", "relu", src("/ws/enc.py", 30, 30)),
        n("loop", { kind: "group", type: "for", ...src("/ws/enc.py", 31, 35) }),
      ],
    }),
    n("dec", { type: "Dec", ...src("/ws/dec.py", 1, 9) }),
  ], []);
  graph.root.source = { file: "/ws/m.py", startLine: 1, endLine: 99 };
  return graph;
};

test("cursor inside a class: every block of that class", () => {
  expect(locateTargets(model(), "/ws/enc.py", 55)).toEqual(["blk1", "blk2"]);
});

test("cursor inside the outer class picks it, not the nested ones", () => {
  expect(locateTargets(model(), "/ws/enc.py", 12)).toEqual(["enc"]);
});

test("cursor outside any class: the outermost blocks the file defines", () => {
  expect(locateTargets(model(), "/ws/enc.py", 45)).toEqual(["enc"]);
});

test("a file no block comes from → []", () => {
  expect(locateTargets(model(), "/ws/other.py", 1)).toEqual([]);
});

test("the graph root is never a target", () => {
  expect(locateTargets(model(), "/ws/m.py", 5)).toEqual([]);
});

test("ops and groups are not targets", () => {
  expect(locateTargets(model(), "/ws/enc.py", 30)).toEqual(["enc"]);
  expect(locateTargets(model(), "/ws/enc.py", 33)).toEqual(["enc"]);
});

test("paths match across slashes and drive-letter case", () => {
  const graph = g([n("enc", src("C:\\ws\\enc.py", 1, 9))], []);
  expect(locateTargets(graph, "c:/ws/enc.py", 3)).toEqual(["enc"]);
});

test("the same class in two models of a project graph: both, in diagram order", () => {
  const part = (name: string) => ({ name, file: `/ws/${name}.py`, line: 1, summary: "", graph: model() });
  const project = buildProjectGraph("p", [part("A"), part("B")]);
  expect(locateTargets(project, "/ws/enc.py", 55)).toEqual(["m0/blk1", "m0/blk2", "m1/blk1", "m1/blk2"]);
  // a model block itself is a target when its class is in the file
  expect(locateTargets(project, "/ws/m.py", 5)).toEqual(["m0/root", "m1/root"]);
});

test("ancestorsOf: parents of the targets without the root, deduplicated", () => {
  expect(ancestorsOf(model(), ["blk1", "blk2", "dec"])).toEqual(["enc"]);
  expect(ancestorsOf(model(), ["enc", "nope"])).toEqual([]);
});

test("ancestorsOf only expands for the first 20 targets", () => {
  const parents: Node[] = Array.from({ length: 25 }, (_, i) => n(`p${i}`, { children: [n(`p${i}.c`)] }));
  const graph = g(parents, []);
  const out = ancestorsOf(graph, parents.map((p) => p.children[0].id));
  expect(MAX_LOCATE_EXPAND).toBe(20);
  expect(out).toEqual(parents.slice(0, 20).map((p) => p.id));
});
