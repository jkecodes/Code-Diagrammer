// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";
import type { Look } from "../src/ir";
import type { Box, Laid } from "../src/webview/layout";
import { renderDetails, renderDiagram, shapeElement } from "../src/webview/render";
import type { VNode } from "../src/webview/view";
import { n } from "./helpers";

const SVG = "http://www.w3.org/2000/svg";
const BOX = { x: 10, y: 20, width: 100, height: 40 };
const look = (shape: Look["shape"], color: Look["color"] = "blue", role?: string): Look => ({ role, shape, color });

function v(id: string, nodeLook?: Look, extra: Partial<VNode> = {}): VNode {
  return {
    id, label: id, sublabel: "", kind: "module", expandable: false, expanded: false,
    node: nodeLook ? { ...n(id), look: nodeLook } : n(id), children: [], edges: [], ...extra,
  };
}
function laid(children: Box[]): Laid {
  const root = v("root", undefined, { expandable: true, expanded: true });
  return { width: 600, height: 200, root: { id: "root", x: 0, y: 0, width: 600, height: 200, v: root, children }, paths: [] };
}
const box = (view: VNode, x: number, children: Box[] = []): Box =>
  ({ id: view.id, x, y: 20, width: 100, height: 40, v: view, children });

let svg: SVGSVGElement;
const handlers = { onSelect: vi.fn(), onOpen: vi.fn(), onToggle: vi.fn() };
const nodeEl = (id: string) => svg.querySelector(`g.node[data-id="${id}"]`)!;
beforeEach(() => {
  document.body.innerHTML = "";
  svg = document.createElementNS(SVG, "svg") as SVGSVGElement;
  document.body.appendChild(svg);
});

test("each shape draws the right element inside the box", () => {
  const narrow = shapeElement(look("trapezoid-narrow"), "module", false, BOX);
  expect([narrow.tagName, narrow.getAttribute("points")]).toEqual(["polygon", "10,20 110,28 110,52 10,60"]);
  const wide = shapeElement(look("trapezoid-wide"), "module", false, BOX);
  expect(wide.getAttribute("points")).toBe("10,28 110,20 110,60 10,52");
  const hexagon = shapeElement(look("hexagon"), "module", false, BOX);
  expect(hexagon.getAttribute("points")).toBe("24,20 96,20 110,40 96,60 24,60 10,40");
  const circle = shapeElement(look("circle"), "op", false, BOX);
  expect(["cx", "cy", "rx", "ry"].map((a) => circle.getAttribute(a))).toEqual(["60", "40", "50", "20"]);
  expect(circle.tagName).toBe("ellipse");
  const rounded = shapeElement(look("rounded"), "module", false, BOX);
  expect([rounded.tagName, rounded.getAttribute("rx")]).toEqual(["rect", "20"]);
  const rect = shapeElement(look("rect"), "module", false, BOX);
  expect([rect.tagName, rect.getAttribute("rx")]).toEqual(["rect", "6"]);
  for (const el of [narrow, wide, hexagon, circle, rounded, rect]) expect(el.classList.contains("shape")).toBe(true);
});

test("a narrow hexagon keeps its inset inside the box", () => {
  const hexagon = shapeElement(look("hexagon"), "module", false, { x: 0, y: 0, width: 40, height: 20 });
  expect(hexagon.getAttribute("points")).toBe("8,0 32,0 40,10 32,20 8,20 0,10");
});

test("without a look the shape is today's rectangle", () => {
  const plain = shapeElement(undefined, "module", false, BOX);
  expect([plain.tagName, plain.getAttribute("rx"), plain.getAttribute("width")]).toEqual(["rect", "6", "100"]);
  expect(shapeElement(undefined, "op", false, BOX).getAttribute("rx")).toBe("14");
});

test("an expanded block is a rectangle whatever its look, and keeps the colour class", () => {
  const inner = box(v("inner"), 30);
  const outer = v("outer", look("trapezoid-narrow", "red"), { expandable: true, expanded: true });
  renderDiagram(svg, laid([box(outer, 10, [inner])]), null, handlers);
  expect(nodeEl("outer").querySelector(":scope > .shape")!.tagName).toBe("rect");
  expect(nodeEl("outer").classList.contains("look-red")).toBe(true);
});

test("renderDiagram draws the look's shape and puts look-<color> on the node; none adds no class", () => {
  renderDiagram(svg, laid([
    box(v("enc", look("trapezoid-narrow", "blue")), 10),
    box(v("plain", look("hexagon", "none")), 150),
    box(v("no"), 290),
  ]), "enc", handlers);
  expect(nodeEl("enc").querySelector(":scope > .shape")!.tagName).toBe("polygon");
  expect(nodeEl("enc").classList.contains("look-blue")).toBe(true);
  expect(nodeEl("enc").classList.contains("selected")).toBe(true);
  expect(nodeEl("plain").querySelector(":scope > .shape")!.tagName).toBe("polygon");
  expect([...nodeEl("plain").classList].some((c) => c.startsWith("look-"))).toBe(false);
  expect([...nodeEl("no").classList].some((c) => c.startsWith("look-"))).toBe(false);
});

test("details show the role", () => {
  const details = document.createElement("aside");
  renderDetails(details, v("enc", look("trapezoid-narrow", "blue", "encoder")), [], []);
  const rows = [...details.querySelectorAll(".row")].map((r) => r.textContent);
  expect(rows).toContain("Roleencoder");
  renderDetails(details, v("plain", look("hexagon", "none")), [], []);
  expect([...details.querySelectorAll(".row .key")].map((r) => r.textContent)).not.toContain("Role");
});
