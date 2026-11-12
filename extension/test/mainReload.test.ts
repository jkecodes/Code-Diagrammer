// @vitest-environment jsdom
// The webview after a reload: its own saved preference plus what the host replays.
import { beforeAll, expect, test } from "vitest";
import { applyGrouping } from "../src/llm/grouping";
import type { HostMessage, WebviewMessage } from "../src/protocol";
import { BODY_HTML } from "../src/webview/shell";
import { e, g, n } from "./helpers";

const sent: WebviewMessage[] = [];
const saved: unknown[] = [];
const svg = () => document.getElementById("diagram")!;
const ids = () => [...svg().querySelectorAll("g.node")].map((x) => x.getAttribute("data-id"));
const post = (data: HostMessage) => window.dispatchEvent(new MessageEvent("message", { data }));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

const graph = () => g([n("a"), n("b"), n("c"), n("d")],
  [e("$in", "a"), e("a", "b"), e("b", "c"), e("c", "d"), e("d", "$out")]);
const paper = () => applyGrouping(graph(), [{ name: "Front", description: "", nodeIds: ["a", "b"] }]);

beforeAll(async () => {
  document.body.innerHTML = BODY_HTML;
  (globalThis as any).acquireVsCodeApi = () => ({
    postMessage: (m: WebviewMessage) => sent.push(m),
    getState: () => ({ wantPaper: true }), // what this webview saved before it was reloaded
    setState: (s: unknown) => saved.push(s),
  });
  await import("../src/webview/main");
});

test("a reloaded webview that was showing stages shows the replayed stages again", async () => {
  post({ type: "graph", graph: graph() });
  post({ type: "paper", graph: paper() });
  await until(() => ids().includes("root/concept:0"));
  expect(document.getElementById("viewPaper")!.getAttribute("aria-pressed")).toBe("true");
});

test("choosing Blocks is saved, so the next reload starts with blocks", async () => {
  document.getElementById("viewCode")!.click();
  await until(() => !ids().includes("root/concept:0"));
  expect(saved.at(-1)).toEqual({ wantPaper: false });
  document.getElementById("viewPaper")!.click();
  expect(saved.at(-1)).toEqual({ wantPaper: true });
});
