// @vitest-environment jsdom
// Integration test of the webview entry point: messages in, SVG and messages out.
import { beforeAll, expect, test } from "vitest";
import type { HostMessage, WebviewMessage } from "../src/protocol";
import { BODY_HTML } from "../src/webview/shell";
import { e, g, n, op } from "./helpers";

const sent: WebviewMessage[] = [];
const svg = () => document.getElementById("diagram")!;
const ids = () => [...svg().querySelectorAll("g.node")].map((x) => x.getAttribute("data-id"));
const post = (data: HostMessage) => window.dispatchEvent(new MessageEvent("message", { data }));
const fire = (el: Element, type: string) =>
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

const FILE = "C:\\w\\m.py";
const graph = () => {
  const out = g(
    [
      n("stem", { type: "Conv2d", params: 32, source: { file: FILE, startLine: 5, endLine: 5 } }),
      op("root/view@9:8", "view", { shapeOnly: true }),
      n("blocks", {
        type: "Sequential", source: { file: FILE, startLine: 6, endLine: 6 },
        children: [n("blocks.0", { source: { file: FILE, startLine: 20, endLine: 30 } })],
        edges: [e("$in", "blocks.0", [2, 8]), e("blocks.0", "$out", [2, 8])],
      }),
    ],
    [e("$in", "stem", [2, 3, 4, 4]), e("stem", "root/view@9:8", [2, 8, 1, 1]),
     e("root/view@9:8", "blocks", [2, 8]), e("blocks", "$out", [2, 8])],
  );
  out.root.params = 1322;
  return out;
};

beforeAll(async () => {
  document.body.innerHTML = BODY_HTML; // the same markup the extension puts into the panel
  (globalThis as any).acquireVsCodeApi = () => ({ postMessage: (m: WebviewMessage) => sent.push(m) });
  await import("../src/webview/main");
});

test("announces itself, then draws a graph with reshape ops folded", async () => {
  expect(sent).toEqual([{ type: "ready" }]);
  post({ type: "graph", graph: graph() });
  await until(() => ids().length > 0);
  expect(ids()).toEqual(["stem", "blocks"]);
  expect([...svg().querySelectorAll("text.edge-label")].map((t) => t.textContent))
    .toEqual(["[2, 3, 4, 4]", "[2, 8, 1, 1] → [2, 8]", "[2, 8]"]);
  expect(document.getElementById("title")!.textContent).toContain("Net");
  expect(document.getElementById("title")!.textContent).toContain("1.3K params");
  expect(svg().getAttribute("viewBox")).toMatch(/^-24 -24 /);
});

test("the toolbar checkbox shows reshape ops as nodes", async () => {
  const box = document.getElementById("showShapeOps") as HTMLInputElement;
  box.checked = true;
  box.dispatchEvent(new Event("change"));
  await until(() => ids().includes("root/view@9:8"));
  box.checked = false;
  box.dispatchEvent(new Event("change"));
  await until(() => !ids().includes("root/view@9:8"));
});

test("toggling expands in place and keeps it across a new graph", async () => {
  fire(svg().querySelector('g.toggle[data-id="blocks"]')!, "click");
  await until(() => ids().includes("blocks.0"));
  post({ type: "graph", graph: graph() });
  await new Promise((r) => setTimeout(r, 100));
  await until(() => ids().includes("blocks.0"));
});

test("single click shows details, double click asks the host to open the source", async () => {
  fire(svg().querySelector('g.node[data-id="stem"]')!, "click");
  const details = document.getElementById("details")!.textContent!;
  expect(details).toContain("Conv2d");
  expect(details).toContain("[2, 3, 4, 4]");
  expect(details).toContain("m.py:5");
  expect(svg().querySelector('g.node[data-id="stem"]')!.classList.contains("selected")).toBe(true);
  fire(svg().querySelector('g.node[data-id="stem"]')!, "dblclick");
  expect(sent.at(-1)).toEqual({ type: "openSource", source: { file: FILE, startLine: 5, endLine: 5 } });
});

test("notice button and Trace button send actions; clearNotice hides the bar", () => {
  post({ type: "notice", level: "info", text: "Showing structure only.", action: "trace" });
  const bar = document.getElementById("notice")!;
  expect(bar.hidden).toBe(false);
  bar.querySelector("button")!.click();
  expect(sent.at(-1)).toEqual({ type: "action", action: "trace" });
  post({ type: "clearNotice" });
  expect(bar.hidden).toBe(true);
  sent.length = 0;
  document.getElementById("trace")!.click();
  expect(sent).toEqual([{ type: "action", action: "trace" }]);
});

test("cursor message highlights the matching node, or its visible ancestor", async () => {
  post({ type: "cursor", file: FILE, line: 5 });
  expect(svg().querySelector('g.node[data-id="stem"]')!.classList.contains("cursor")).toBe(true);
  post({ type: "cursor", file: FILE, line: 25 });
  expect(svg().querySelector('g.node[data-id="blocks.0"]')!.classList.contains("cursor")).toBe(true);
  expect(svg().querySelector('g.node[data-id="stem"]')!.classList.contains("cursor")).toBe(false);
  fire(svg().querySelector('g.toggle[data-id="blocks"]')!, "click"); // collapse
  await until(() => !ids().includes("blocks.0"));
  expect(svg().querySelector('g.node[data-id="blocks"]')!.classList.contains("cursor")).toBe(true);
});

test("right-click offers Open source and a disabled Ask Claude item", () => {
  svg().querySelector('g.node[data-id="stem"]')!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const menu = document.getElementById("menu")!;
  const items = [...menu.querySelectorAll("button")];
  expect(menu.hidden).toBe(false);
  expect(items.map((b) => b.textContent)).toEqual(["Open source", "Ask Claude about this block"]);
  expect(items[1].disabled).toBe(true);
  items[0].click();
  expect(sent.at(-1)).toEqual({ type: "openSource", source: { file: FILE, startLine: 5, endLine: 5 } });
  expect(menu.hidden).toBe(true);
});

test("the title shows total and trainable parameters", async () => {
  const next = graph();
  next.root.params = 338977;
  next.root.trainableParams = 75809;
  post({ type: "graph", graph: next });
  await until(() => document.getElementById("title")!.textContent!.includes("339K params (75.8K trainable)"));
});

// ---- paper view ----

const paper = () => {
  const code = graph();
  const [stem, view, blocks] = code.root.children;
  const concept = n("root/concept:0", {
    name: "Feature Stem", kind: "concept", type: "concept", description: "Extracts features.",
    source: stem.source, children: [stem, view],
    edges: [e("$in", "stem", [2, 3, 4, 4]), e("stem", "root/view@9:8", [2, 8, 1, 1]), e("root/view@9:8", "$out", [2, 8])],
  });
  const out = g([concept, blocks], [
    e("$in", "root/concept:0", [2, 3, 4, 4]), e("root/concept:0", "blocks", [2, 8]), e("blocks", "$out", [2, 8]),
  ]);
  out.root.params = 1322;
  return out;
};
const pressed = (id: string) => document.getElementById(id)!.getAttribute("aria-pressed");

test("toggle to Paper without a grouping asks the host", async () => {
  post({ type: "graph", graph: graph() });
  await until(() => ids().includes("stem"));
  sent.length = 0;
  document.getElementById("viewPaper")!.click();
  expect(sent).toEqual([{ type: "requestPaper", regenerate: false }]);
  expect(ids()).toContain("stem"); // still the code view while waiting
});

test("the busy message is shown next to the toggle", () => {
  post({ type: "busy", text: "Grouping…" });
  expect(document.getElementById("busy")!.textContent).toBe("Grouping…");
  post({ type: "busy", text: null });
  expect(document.getElementById("busy")!.textContent).toBe("");
});

test("the paper graph arrives after the request: concept nodes are drawn", async () => {
  post({ type: "paper", graph: paper() });
  await until(() => ids().includes("root/concept:0"));
  expect(ids()).toEqual(["root/concept:0", "blocks"]);
  expect([pressed("viewPaper"), pressed("viewCode")]).toEqual(["true", "false"]);
  expect(svg().querySelector('g.node[data-id="root/concept:0"]')!.classList.contains("node-concept")).toBe(true);
});

test("a concept shows its description; double click opens the first member's source", () => {
  fire(svg().querySelector('g.node[data-id="root/concept:0"]')!, "click");
  expect(document.getElementById("details")!.textContent).toContain("Extracts features.");
  fire(svg().querySelector('g.node[data-id="root/concept:0"]')!, "dblclick");
  expect(sent.at(-1)).toEqual({ type: "openSource", source: { file: FILE, startLine: 5, endLine: 5 } });
});

test("the cursor lights a collapsed concept when a member matches", () => {
  post({ type: "cursor", file: FILE, line: 5 });
  expect(svg().querySelector('g.node[data-id="root/concept:0"]')!.classList.contains("cursor")).toBe(true);
});

test("Code and Paper switch without asking the host again", async () => {
  sent.length = 0;
  document.getElementById("viewCode")!.click();
  await until(() => ids().includes("stem") && !ids().includes("root/concept:0"));
  document.getElementById("viewPaper")!.click();
  await until(() => ids().includes("root/concept:0"));
  expect(sent).toEqual([]);
});

test("regenerate asks with regenerate:true", () => {
  sent.length = 0;
  document.getElementById("regroup")!.click();
  expect(sent).toEqual([{ type: "requestPaper", regenerate: true }]);
});

test("a new graph falls back to the code view; a cached paper brings the paper view back", async () => {
  post({ type: "graph", graph: graph() });
  await until(() => ids().includes("stem") && !ids().includes("root/concept:0"));
  expect(pressed("viewCode")).toBe("true");
  post({ type: "paper", graph: paper() });
  await until(() => ids().includes("root/concept:0"));
});

test("after choosing Code, a paper message does not switch the view", async () => {
  document.getElementById("viewCode")!.click();
  await until(() => ids().includes("stem"));
  post({ type: "graph", graph: graph() });
  post({ type: "paper", graph: paper() });
  await new Promise((r) => setTimeout(r, 100));
  expect(ids()).toContain("stem");
  expect(ids()).not.toContain("root/concept:0");
});

test("the toggleView message flips the view", async () => {
  post({ type: "toggleView" });
  await until(() => ids().includes("root/concept:0"));
  post({ type: "toggleView" });
  await until(() => ids().includes("stem") && !ids().includes("root/concept:0"));
});

test("a new graph clears a busy label left by an earlier request", async () => {
  post({ type: "busy", text: "Grouping…" });
  post({ type: "graph", graph: graph() });
  expect(document.getElementById("busy")!.textContent).toBe("");
  await until(() => ids().includes("stem"));
});

test("choosing Code while a grouping is in flight cancels it", async () => {
  sent.length = 0;
  document.getElementById("viewPaper")!.click();
  expect(sent).toEqual([{ type: "requestPaper", regenerate: false }]);
  post({ type: "busy", text: "Grouping…" });
  document.getElementById("viewCode")!.click();
  expect(sent.at(-1)).toEqual({ type: "cancelPaper" });
  post({ type: "busy", text: null });
  sent.length = 0;
  document.getElementById("viewCode")!.click();
  expect(sent).toEqual([]); // nothing in flight any more
});
