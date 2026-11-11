import { expect, test } from "vitest";
import { buildView, formatParams, formatShape, type ViewState } from "../src/webview/view";
import { e, g, n, op } from "./helpers";

const state = (expanded: string[] = [], showShapeOps = false): ViewState =>
  ({ expanded: new Set(expanded), showShapeOps });
const ids = (v: { children: { id: string }[] }) => v.children.map((c) => c.id);
const edgeList = (v: { edges: { from: string; to: string; label: string }[] }) =>
  v.edges.map((x) => [x.from, x.to, x.label]);

const cnn = () => g(
  [
    n("stem", { type: "Sequential", children: [n("stem.0"), n("stem.1")],
                edges: [e("$in", "stem.0"), e("stem.0", "stem.1"), e("stem.1", "$out")] }),
    n("blocks", { type: "Sequential" }),
  ],
  [e("$in", "stem", [2, 3, 16, 16]), e("stem", "blocks", [2, 8, 16, 16]), e("blocks", "$out", [2, 8, 16, 16])],
);

test("formatShape / formatParams", () => {
  expect(formatShape([1, 3, 26, 256])).toBe("[1, 3, 26, 256]");
  expect(formatShape(null)).toBe("");
  expect(formatParams(1322)).toBe("1.3K params");
  expect(formatParams(75800)).toBe("75.8K params");
  expect(formatParams(2500000)).toBe("2.5M params");
  expect(formatParams(90)).toBe("90 params");
  expect(formatParams(null)).toBe("");
});

test("root is expanded, children collapsed by default", () => {
  const v = buildView(cnn(), state());
  expect(v.expanded).toBe(true);
  expect(ids(v)).toEqual(["root/$in", "stem", "blocks", "root/$out"]);
  const stem = v.children[1];
  expect(stem.expandable).toBe(true);
  expect(stem.expanded).toBe(false);
  expect(stem.children).toEqual([]);
  expect(v.children[2].expandable).toBe(false);
  expect(edgeList(v)).toEqual([
    ["root/$in", "stem", "[2, 3, 16, 16]"], ["stem", "blocks", "[2, 8, 16, 16]"],
    ["blocks", "root/$out", "[2, 8, 16, 16]"]]);
});

test("expanding a node reveals its children and terminals", () => {
  const stem = buildView(cnn(), state(["stem"])).children[1];
  expect(stem.expanded).toBe(true);
  expect(ids(stem)).toEqual(["stem/$in", "stem.0", "stem.1", "stem/$out"]);
  expect(stem.children[0].kind).toBe("terminal");
});

const reshape = () => g(
  [n("a"), op("root/view@1:0", "view", { shapeOnly: true }), n("b")],
  [e("a", "root/view@1:0", [1, 8, 3, 26, 32]), e("root/view@1:0", "b", [8, 3, 26, 32])],
);

test("shape-only chain folds into one labeled edge", () => {
  const v = buildView(reshape(), state());
  expect(ids(v)).toEqual(["a", "b"]);
  expect(edgeList(v)).toEqual([["a", "b", "[1, 8, 3, 26, 32] → [8, 3, 26, 32]"]]);
});

test("two shape-only nodes in a row fold together", () => {
  const graph = g(
    [n("fuse"), op("p", "permute", { shapeOnly: true }), op("c", "contiguous", { shapeOnly: true }), n("gru")],
    [e("fuse", "p", [1, 64, 26]), e("p", "c", [1, 26, 64]), e("c", "gru", [1, 26, 64])],
  );
  const v = buildView(graph, state());
  expect(ids(v)).toEqual(["fuse", "gru"]);
  expect(edgeList(v)).toEqual([["fuse", "gru", "[1, 64, 26] → [1, 26, 64]"]]);
});

test("equal shapes fold to a single label", () => {
  const graph = g(
    [n("a"), op("v", "view", { shapeOnly: true }), n("b")],
    [e("a", "v", [2, 8]), e("v", "b", [2, 8])],
  );
  expect(edgeList(buildView(graph, state()))).toEqual([["a", "b", "[2, 8]"]]);
});

test("a folded edge is uncertain if any replaced edge was", () => {
  const graph = g(
    [n("a"), op("v", "view", { shapeOnly: true }), n("b")],
    [e("a", "v", null, true), e("v", "b")],
  );
  const v = buildView(graph, state());
  expect(v.edges).toEqual([{ from: "a", to: "b", label: "", uncertain: true }]);
});

test("showShapeOps true keeps the node", () => {
  const v = buildView(reshape(), state([], true));
  expect(ids(v)).toEqual(["a", "root/view@1:0", "b"]);
  expect(v.edges.length).toBe(2);
});

test("shape-only node with two consumers is kept", () => {
  const graph = g(
    [n("a"), op("v", "view", { shapeOnly: true }), n("b"), n("c")],
    [e("a", "v", [2, 8]), e("v", "b", [2, 8]), e("v", "c", [2, 8])],
  );
  expect(ids(buildView(graph, state()))).toEqual(["a", "v", "b", "c"]);
});

test("module label and sublabel", () => {
  const graph = g([n("enc", { type: "SharedSubbandEncoder" }), op("root/add@3:1", "add")], []);
  const [enc, add] = buildView(graph, state()).children;
  expect([enc.label, enc.sublabel]).toEqual(["enc", "SharedSubbandEncoder"]);
  expect([add.label, add.sublabel]).toEqual(["add", ""]);
});

test("repeated placeholder is labeled with its type", () => {
  const graph = g([n("blocks", { type: "Sequential", children: [n("blocks.*", { name: "*", type: "Block", repeated: true })] })], []);
  const star = buildView(graph, state(["blocks"])).children[0].children[0];
  expect([star.label, star.sublabel]).toEqual(["Block x N", ""]);
});

test("terminals without edges are omitted", () => {
  const graph = g([n("a"), n("b")], [e("a", "b")]);
  expect(ids(buildView(graph, state()))).toEqual(["a", "b"]);
});

test("formatParams shows trainable parameters when some are frozen", () => {
  expect(formatParams(338977, 75809)).toBe("339K params (75.8K trainable)");
  expect(formatParams(30, 0)).toBe("30 params (0 trainable)");
  expect(formatParams(1322, 1322)).toBe("1.3K params");
  expect(formatParams(1322, null)).toBe("1.3K params");
  expect(formatParams(null, null)).toBe("");
});

test("a concept node shows its name and member count", () => {
  const concept = n("root/concept:0", {
    name: "Frequency Pooling", kind: "concept", type: "concept", params: 1500, trainableParams: 1500,
    children: [op("m", "mean"), op("a", "amax"), n("fc")],
    edges: [e("$in", "m"), e("m", "a"), e("a", "fc"), e("fc", "$out")],
  });
  const v = buildView(g([concept, n("head")], [e("$in", "root/concept:0"), e("root/concept:0", "head"), e("head", "$out")]), state());
  const drawn = v.children.find((c) => c.id === "root/concept:0")!;
  expect([drawn.label, drawn.sublabel, drawn.kind, drawn.expandable, drawn.expanded])
    .toEqual(["Frequency Pooling", "3 blocks · 1.5K params", "concept", true, false]);
  const bare = buildView(g([{ ...concept, params: null, trainableParams: null }, n("head")], []), state());
  expect(bare.children[0].sublabel).toBe("3 blocks");
});
