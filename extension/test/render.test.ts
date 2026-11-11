// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";
import type { Box, Laid, Path } from "../src/webview/layout";
import { renderDetails, renderDiagram, renderNotice } from "../src/webview/render";
import type { VNode } from "../src/webview/view";
import { n } from "./helpers";

const SVG = "http://www.w3.org/2000/svg";

function v(id: string, extra: Partial<VNode> = {}): VNode {
  return {
    id, label: id, sublabel: "", kind: "module", expandable: false, expanded: false,
    node: n(id), children: [], edges: [], ...extra,
  };
}
function box(view: VNode, x: number, children: Box[] = []): Box {
  return { id: view.id, x, y: 10, width: 100, height: 44, v: view, children };
}
function laid(children: Box[], paths: Path[] = []): Laid {
  const root = v("root", { expandable: true, expanded: true });
  return { width: 600, height: 200, root: { id: "root", x: 0, y: 0, width: 600, height: 200, v: root, children }, paths };
}
const path = (label: string, uncertain = false): Path => ({
  points: [{ x: 0, y: 0 }, { x: 50, y: 0 }], label, labelAt: { x: 25, y: 0 }, uncertain,
});

let svg: SVGSVGElement;
const handlers = { onSelect: vi.fn(), onOpen: vi.fn(), onToggle: vi.fn() };
const nodeEl = (id: string) => svg.querySelector(`g.node[data-id="${id}"]`)!;
const fire = (el: Element, type: string) =>
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));

beforeEach(() => {
  document.body.innerHTML = "";
  svg = document.createElementNS(SVG, "svg") as SVGSVGElement;
  document.body.appendChild(svg);
  Object.values(handlers).forEach((h) => h.mockClear());
});

const three = () => laid([
  box(v("stem", { sublabel: "Sequential" }), 10),
  box(v("blocks", { expandable: true }), 150),
  box(v("fc"), 290),
]);

test("renders one group per node with labels", () => {
  renderDiagram(svg, three(), null, handlers);
  const groups = [...svg.querySelectorAll("g.node")].filter((g) => g.getAttribute("data-id") !== "root");
  expect(groups.length).toBe(3);
  expect(groups.map((g) => g.querySelector(":scope > text.label")!.textContent)).toEqual(["stem", "blocks", "fc"]);
  expect(nodeEl("stem").querySelector(":scope > text.sublabel")!.textContent).toBe("Sequential");
  expect(nodeEl("fc").querySelector(":scope > text.sublabel")).toBeNull();
  expect(nodeEl("fc").classList.contains("node-module")).toBe(true);
});

test("edge label and uncertain class", () => {
  renderDiagram(svg, laid([], [path("[2, 8, 16, 16]"), path("", true)]), null, handlers);
  expect([...svg.querySelectorAll("text.edge-label")].map((t) => t.textContent)).toEqual(["[2, 8, 16, 16]"]);
  expect(svg.querySelectorAll("path.edge").length).toBe(2);
  expect(svg.querySelectorAll("path.edge.uncertain").length).toBe(1);
});

test("click selects, double click opens", () => {
  renderDiagram(svg, three(), null, handlers);
  fire(nodeEl("fc"), "click");
  expect(handlers.onSelect).toHaveBeenCalledTimes(1);
  expect(handlers.onSelect).toHaveBeenCalledWith("fc");
  fire(nodeEl("fc"), "dblclick");
  expect(handlers.onOpen).toHaveBeenCalledTimes(1);
  expect(handlers.onOpen).toHaveBeenCalledWith("fc");
});

test("toggle click only toggles", () => {
  renderDiagram(svg, three(), null, handlers);
  const toggle = svg.querySelector('g.toggle[data-id="blocks"]')!;
  expect(toggle.querySelector("text")!.textContent).toBe("+");
  fire(toggle, "click");
  fire(toggle, "dblclick");
  expect(handlers.onToggle).toHaveBeenCalledTimes(1);
  expect(handlers.onToggle).toHaveBeenCalledWith("blocks");
  expect(handlers.onSelect).not.toHaveBeenCalled();
  expect(handlers.onOpen).not.toHaveBeenCalled();
  expect(svg.querySelector('g.toggle[data-id="fc"]')).toBeNull();
});

test("expanded node shows a minus toggle and contains its children", () => {
  const inner = box(v("blocks.0"), 160);
  const outer = box(v("blocks", { expandable: true, expanded: true }), 150, [inner]);
  renderDiagram(svg, laid([outer]), null, handlers);
  expect(svg.querySelector('g.toggle[data-id="blocks"] text')!.textContent).toBe("−");
  fire(nodeEl("blocks.0"), "click");
  expect(handlers.onSelect).toHaveBeenCalledTimes(1); // the parent block is not selected too
  expect(handlers.onSelect).toHaveBeenCalledWith("blocks.0");
});

test("terminals are not interactive", () => {
  const terminal = v("root/$in", { kind: "terminal", label: "", node: null });
  renderDiagram(svg, laid([box(terminal, 5)]), null, handlers);
  const el = svg.querySelector('[data-id="root/$in"]')!;
  fire(el, "click");
  fire(el, "dblclick");
  expect(handlers.onSelect).not.toHaveBeenCalled();
  expect(handlers.onOpen).not.toHaveBeenCalled();
});

test("selected node has the selected class", () => {
  renderDiagram(svg, three(), "fc", handlers);
  expect(nodeEl("fc").classList.contains("selected")).toBe(true);
  expect(nodeEl("stem").classList.contains("selected")).toBe(false);
});

test("rendering again replaces the previous drawing", () => {
  renderDiagram(svg, three(), null, handlers);
  renderDiagram(svg, three(), null, handlers);
  expect(svg.querySelectorAll('g.node[data-id="fc"]').length).toBe(1);
});

test("details show params, shapes and location", () => {
  const el = document.createElement("div");
  const view = v("fc", {
    sublabel: "Linear",
    node: n("fc", { params: 1322, source: { file: "C:\\w\\simple_cnn.py", startLine: 19, endLine: 19 } }),
  });
  renderDetails(el, view, ["[2, 8, 16, 16]"], ["[2, 10]"]);
  expect(el.textContent).toContain("1.3K params");
  expect(el.textContent).toContain("[2, 8, 16, 16]");
  expect(el.textContent).toContain("[2, 10]");
  expect(el.textContent).toContain("simple_cnn.py:19");
  expect(el.textContent).toContain("Linear");
  renderDetails(el, null, [], []);
  expect(el.textContent).not.toContain("1.3K params");
});

test("notice renders text and action button", () => {
  const el = document.createElement("div");
  const onAction = vi.fn();
  renderNotice(el, { level: "info", text: "Showing structure only.", action: "trace" }, onAction);
  expect(el.textContent).toContain("Showing structure only.");
  expect(el.classList.contains("notice-info")).toBe(true);
  el.querySelector("button")!.click();
  expect(onAction).toHaveBeenCalledWith("trace");
  renderNotice(el, { level: "warn", text: "No action here" }, onAction);
  expect(el.querySelector("button")).toBeNull();
  renderNotice(el, null, onAction);
  expect(el.textContent).toBe("");
  expect(el.hidden).toBe(true);
});

test("applyCursorHighlight sets and clears the cursor class", async () => {
  const { applyCursorHighlight } = await import("../src/webview/render");
  renderDiagram(svg, three(), null, handlers);
  applyCursorHighlight(svg, ["fc"]);
  applyCursorHighlight(svg, ["stem"]);
  expect(nodeEl("stem").classList.contains("cursor")).toBe(true);
  expect(nodeEl("fc").classList.contains("cursor")).toBe(false);
});
