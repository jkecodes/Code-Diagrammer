// @vitest-environment jsdom
// The webview with project graphs: locate, the File | Project switch, Stages per model.
import { beforeAll, expect, test } from "vitest";
import type { Graph } from "../src/ir";
import { buildProjectGraph } from "../src/project/projectGraph";
import type { HostMessage, WebviewMessage } from "../src/protocol";
import { BODY_HTML } from "../src/webview/shell";
import { e, g, n } from "./helpers";

const sent: WebviewMessage[] = [];
const svg = () => document.getElementById("diagram")!;
const ids = () => [...svg().querySelectorAll("g.node")].map((x) => x.getAttribute("data-id"));
const node = (id: string) => svg().querySelector(`g.node[data-id="${id}"]`)!;
const post = (data: HostMessage) => window.dispatchEvent(new MessageEvent("message", { data }));
const el = (id: string) => document.getElementById(id)!;
const fire = (target: Element, type: string) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}
const settle = () => new Promise((r) => setTimeout(r, 120));

const FILE = "/ws/blocks.py";
// root → outer → mid → deep (class in blocks.py, lines 20-30); side
const nested = (name = "Net"): Graph => {
  const graph = g(
    [
      n("outer", {
        children: [n("mid", {
          children: [n("deep", { source: { file: FILE, startLine: 20, endLine: 30 } })],
          edges: [e("$in", "deep"), e("deep", "$out")],
        })],
        edges: [e("$in", "mid"), e("mid", "$out")],
      }),
      n("side"),
    ],
    [e("$in", "outer"), e("outer", "side"), e("side", "$out")],
  );
  graph.root.name = name;
  graph.meta.entry = { file: `/ws/${name}.py`, className: name };
  return graph;
};
const project = () => buildProjectGraph("proj", [
  { name: "Gen", file: "/ws/gen.py", line: 3, summary: "Makes audio.", graph: nested("Gen") },
  { name: "Disc", file: "/ws/disc.py", line: 9, summary: "", graph: nested("Disc") },
]);

beforeAll(async () => {
  document.body.innerHTML = BODY_HTML;
  (globalThis as any).acquireVsCodeApi = () => ({ postMessage: (m: WebviewMessage) => sent.push(m) });
  await import("../src/webview/main");
});

test("the shell labels the switches File / Project and Blocks / Stages", () => {
  expect(["viewFile", "viewProject", "viewCode", "viewPaper", "locate"].map((id) => el(id).textContent))
    .toEqual(["File", "Project", "Blocks", "Stages", "Locate"]);
});

test("a file graph shows Trace, hides Locate and presses File", async () => {
  post({ type: "graph", graph: nested() });
  await until(() => ids().includes("outer"));
  expect([el("trace").hidden, el("locate").hidden]).toEqual([false, true]);
  expect([el("viewFile").getAttribute("aria-pressed"), el("viewProject").getAttribute("aria-pressed")])
    .toEqual(["true", "false"]);
});

test("locate expands the ancestors, highlights the targets and zooms to the first", async () => {
  expect(ids()).not.toContain("deep");
  post({ type: "locate", ids: ["deep"] });
  await until(() => ids().includes("deep"));
  await until(() => node("deep").classList.contains("cursor"));
  expect(ids()).toEqual(expect.arrayContaining(["outer", "mid", "deep", "side"]));
  expect(svg().getAttribute("viewBox")).not.toMatch(/^-24 -24 /);
});

test("locate with no ids keeps the expansion, clears the highlight and fits", async () => {
  post({ type: "locate", ids: [] });
  await until(() => /^-24 -24 /.test(svg().getAttribute("viewBox") ?? ""));
  expect(ids()).toContain("deep");
  expect(svg().querySelectorAll("g.node.cursor")).toHaveLength(0);
});

test("a project graph hides Trace, shows Locate, presses Project and names the project", async () => {
  post({ type: "graph", graph: project() });
  await until(() => ids().includes("m0/root"));
  expect(ids()).toEqual(["m0/root", "m1/root"]);
  expect([el("trace").hidden, el("locate").hidden]).toEqual([true, false]);
  expect([el("viewFile").getAttribute("aria-pressed"), el("viewProject").getAttribute("aria-pressed")])
    .toEqual(["false", "true"]);
  expect(el("title").textContent).toContain("proj");
  expect(el("title").textContent).toContain("2 models");
});

test("a cursor message alone highlights the visible ancestor and expands nothing", async () => {
  post({ type: "cursor", file: FILE, line: 25 });
  await settle();
  expect(ids()).toEqual(["m0/root", "m1/root"]);
  expect(node("m0/root").classList.contains("cursor")).toBe(true);
});

test("locate in a project expands inside the models; the same class in both is highlighted", async () => {
  post({ type: "locate", ids: ["m0/deep", "m1/deep"] });
  await until(() => ids().includes("m0/deep") && ids().includes("m1/deep"));
  await until(() => node("m1/deep").classList.contains("cursor"));
  expect(node("m0/deep").classList.contains("cursor")).toBe(true);
});

test("File / Project / Locate buttons send switchView and locate", () => {
  sent.length = 0;
  el("viewFile").click();
  el("viewProject").click();
  el("locate").click();
  expect(sent).toEqual([
    { type: "switchView", view: "file" }, { type: "switchView", view: "project" }, { type: "locate" },
  ]);
});

test("Stages in a project graph asks for the located model, then for the selected block's model", () => {
  sent.length = 0;
  el("viewPaper").click();
  expect(sent).toEqual([{ type: "requestPaper", regenerate: false, scopeId: "m0/root" }]);
  fire(node("m1/deep"), "click");
  el("viewPaper").click();
  expect(sent.at(-1)).toEqual({ type: "requestPaper", regenerate: false, scopeId: "m1/root" });
  el("viewCode").click();
});

test("without a selection or a location, Stages asks for the first model", async () => {
  post({ type: "graph", graph: project() });
  post({ type: "locate", ids: [] });
  await settle();
  fire(svg(), "click"); // clears the selection
  sent.length = 0;
  el("regroup").click();
  expect(sent).toEqual([{ type: "requestPaper", regenerate: true, scopeId: "m0/root" }]);
  el("viewCode").click();
});

test("a model block's context menu offers Open as single model and sends openModel", async () => {
  await until(() => ids().includes("m1/root"));
  sent.length = 0;
  fire(node("m1/root").querySelector(".shape")!, "contextmenu");
  const item = [...el("menu").querySelectorAll("button")].find((b) => b.textContent === "Open as single model")!;
  expect(item).toBeDefined();
  item.click();
  expect(sent).toEqual([{ type: "openModel", file: "/ws/disc.py", className: "Disc" }]);
});

test("blocks inside a model, and file graphs, have no Open as single model", async () => {
  post({ type: "locate", ids: ["m0/deep"] });
  await until(() => ids().includes("m0/deep"));
  fire(node("m0/deep").querySelector(".shape")!, "contextmenu");
  expect([...el("menu").querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Open as single model");
});

test("going back to a file graph refits and restores the file toolbar", async () => {
  post({ type: "graph", graph: nested("Other") });
  await until(() => ids().includes("outer") && !ids().includes("m0/root"));
  await until(() => /^-24 -24 /.test(svg().getAttribute("viewBox") ?? ""));
  expect([el("trace").hidden, el("locate").hidden]).toEqual([false, true]);
  sent.length = 0;
  el("viewPaper").click();
  expect(sent).toEqual([{ type: "requestPaper", regenerate: false }]);
});
