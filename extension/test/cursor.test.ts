import { expect, test } from "vitest";
import { nodesAtLine, visibleTargets } from "../src/webview/cursor";
import { buildView } from "../src/webview/view";
import { e, g, n, op } from "./helpers";

const FILE = "C:\\work\\m.py";
const src = (startLine: number, endLine = startLine) => ({ file: FILE, startLine, endLine });

// root (class, lines 14-31) > stem (line 17), blocks (line 18) > two Block instances (class, lines 6-13)
function block(id: string) {
  return n(id, {
    type: "Block", source: src(6, 13),
    children: [
      n(id + ".conv", { source: src(9) }),
      n(id + ".bn", { source: src(10) }),
      op(id + "/add@13:15", "add", { source: src(13) }),
    ],
    edges: [e("$in", id + ".conv"), e(id + ".conv", id + ".bn"), e(id + ".bn", id + "/add@13:15")],
  });
}
const graph = () => {
  const out = g(
    [
      n("stem", { source: src(17) }),
      n("blocks", { type: "Sequential", source: src(18), children: [block("blocks.0"), block("blocks.1")] }),
    ],
    [e("stem", "blocks")],
  );
  out.root.source = src(14, 31);
  return out;
};

test("line inside a class returns all its instances", () => {
  expect(nodesAtLine(graph(), FILE, 12)).toEqual(["blocks.0", "blocks.1"]);
});

test("innermost node wins", () => {
  expect(nodesAtLine(graph(), FILE, 13)).toEqual(["blocks.0/add@13:15", "blocks.1/add@13:15"]);
  expect(nodesAtLine(graph(), FILE, 17)).toEqual(["stem"]);
});

test("no match and other file", () => {
  expect(nodesAtLine(graph(), FILE, 99)).toEqual([]);
  expect(nodesAtLine(graph(), "C:\\work\\other.py", 12)).toEqual([]);
});

test("path comparison ignores case and slash direction on Windows", () => {
  expect(nodesAtLine(graph(), "c:/WORK/m.py", 17)).toEqual(["stem"]);
});

test("collapsed nodes map to nearest visible ancestor, de-duplicated", () => {
  const view = buildView(graph(), { expanded: new Set(), showShapeOps: false });
  expect(visibleTargets(graph(), view, ["blocks.0", "blocks.1"])).toEqual(["blocks"]);
  expect(visibleTargets(graph(), view, ["blocks.0/add@13:15"])).toEqual(["blocks"]);
});

test("visible nodes map to themselves", () => {
  const view = buildView(graph(), { expanded: new Set(["blocks"]), showShapeOps: false });
  expect(visibleTargets(graph(), view, ["blocks.0", "blocks.1"])).toEqual(["blocks.0", "blocks.1"]);
});
