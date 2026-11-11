import { expect, test } from "vitest";
import { layoutView, toElk } from "../src/webview/layout";
import { buildView } from "../src/webview/view";
import { e, g, n } from "./helpers";

const chain = () => g([n("a"), n("b"), n("c")], [e("a", "b", [2, 8]), e("b", "c", [2, 8])]);
const view = (graph = chain(), expanded: string[] = []) =>
  buildView(graph, { expanded: new Set(expanded), showShapeOps: false });

test("toElk mirrors nodes and edges and lays out left to right", () => {
  const elk = toElk(view());
  expect(elk.children?.map((c) => c.id)).toEqual(["a", "b", "c"]);
  expect(elk.edges?.length).toBe(2);
  expect(elk.layoutOptions?.["elk.direction"]).toBe("RIGHT");
  expect(elk.layoutOptions?.["elk.algorithm"]).toBe("layered");
  expect(elk.edges?.[0].labels?.[0].text).toBe("[2, 8]");
});

test("a chain is laid out with increasing x", async () => {
  const laid = await layoutView(view());
  const [a, b, c] = laid.root.children;
  expect(a.width).toBeGreaterThan(0);
  expect(a.x).toBeLessThan(b.x);
  expect(b.x).toBeLessThan(c.x);
  expect(laid.paths.length).toBe(2);
  expect(laid.paths[0].label).toBe("[2, 8]");
  expect(laid.paths[0].points.length).toBeGreaterThanOrEqual(2);
  expect(laid.width).toBeGreaterThan(c.x);
});

test("children of an expanded node lie inside it, in absolute coordinates", async () => {
  const graph = g(
    [n("first"), n("box", { type: "Sequential", children: [n("box.0"), n("box.1")],
                            edges: [e("$in", "box.0"), e("box.0", "box.1"), e("box.1", "$out")] })],
    [e("first", "box")],
  );
  const laid = await layoutView(view(graph, ["box"]));
  const box = laid.root.children.find((b) => b.id === "box")!;
  const inner = box.children.find((b) => b.id === "box.0")!;
  expect(inner.x).toBeGreaterThanOrEqual(box.x);
  expect(inner.y).toBeGreaterThanOrEqual(box.y);
  expect(inner.x + inner.width).toBeLessThanOrEqual(box.x + box.width);
  expect(inner.y + inner.height).toBeLessThanOrEqual(box.y + box.height);
  expect(laid.paths.length).toBe(4);
});
