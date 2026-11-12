// Tests for the small fixes made after the project-architecture review.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { AnalyzerClient } from "../src/analyzerClient";
import { LlmError, type LlmModel, type LlmProvider } from "../src/llm/provider";
import { saveRoles } from "../src/llm/rolesStore";
import { testLanguageModel } from "../src/llm/selfTest";
import * as M from "../src/messages";
import { buildProjectGraph } from "../src/project/projectGraph";
import { Replay } from "../src/replay";
import { buildView } from "../src/webview/view";
import { CLAUDE, FakeProvider } from "./fakeProvider";
import { e, g, n } from "./helpers";

const ANALYZER = path.resolve(__dirname, "../../analyzer");
const PY = path.resolve(__dirname, "../../.venv/Scripts/python.exe");
const fixtures = path.resolve(__dirname, "../../analyzer/tests/fixtures");
const cnn = path.join(fixtures, "simple_cnn.py");

// ---- analyzer client --------------------------------------------------------------------

test("two classes of one file are analysed one after the other", async () => {
  const client = new AnalyzerClient({ pythonPath: PY, analyzerDir: ANALYZER, timeoutMs: 30000 });
  const first = await client.analyzeStatic({ file: cnn, entry: "SimpleCNN", workspaceRoot: fixtures });
  const second = await client.analyzeStatic({ file: cnn, entry: "Block", workspaceRoot: fixtures });
  expect(first.ok && first.value.root.type).toBe("SimpleCNN");
  expect(second.ok && second.value.root.type).toBe("Block");
});

test("aborting stops a running analysis at once", async () => {
  const sleeper = new AnalyzerClient({
    pythonPath: PY, analyzerDir: path.resolve(__dirname, "fixtures"), moduleName: "sleeper", timeoutMs: 30000,
  });
  const abort = new AbortController();
  const started = Date.now();
  setTimeout(() => abort.abort(), 200);
  const scan = await sleeper.scan(fixtures, abort.signal);
  expect(!scan.ok && scan.error.kind).toBe("cancelled");
  expect(Date.now() - started).toBeLessThan(5000);
  const already = await sleeper.analyzeStatic({ file: cnn, entry: "SimpleCNN", workspaceRoot: fixtures }, abort.signal);
  expect(!already.ok && already.error.kind).toBe("cancelled");
});

// ---- model blocks show their file ---------------------------------------------------------

test("a project's model blocks show the file they come from; inner blocks are unchanged", () => {
  const model = () => g([n("enc", { type: "Enc" })], [e("$in", "enc"), e("enc", "$out")]);
  const project = buildProjectGraph("p", [
    { name: "Net", file: "/ws/a/net.py", line: 1, summary: "", graph: model() },
    { name: "Net", file: "C:\\ws\\b\\net2.py", line: 1, summary: "", graph: model() },
  ]);
  const view = buildView(project, { expanded: new Set(["m0/root"]), showShapeOps: false });
  expect(view.children.map((c) => [c.label, c.sublabel])).toEqual([["Net", "net.py"], ["Net", "net2.py"]]);
  const inner = view.children[0].children.find((c) => c.id === "m0/enc")!;
  expect([inner.label, inner.sublabel]).toEqual(["enc", "Enc"]);
});

// ---- roles file ---------------------------------------------------------------------------

test("saving roles where nothing can be written reports false instead of throwing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cd-ro-"));
  fs.writeFileSync(path.join(root, ".code-diagrammer"), "a file where the folder should be");
  expect(saveRoles(root, { A: { shape: "rect", color: "none" } })).toBe(false);
  expect(saveRoles(fs.mkdtempSync(path.join(os.tmpdir(), "cd-rw-")), {})).toBe(true);
});

// ---- what a reloaded webview gets back ----------------------------------------------------

test("a reloaded webview gets the graph, its stages, the location and the notice back, in that order", () => {
  const replay = new Replay();
  const graph = g([n("a")], []);
  expect(replay.messages()).toEqual([]);
  replay.remember({ type: "graph", graph });
  replay.remember({ type: "notice", level: "info", text: "hello" });
  replay.remember({ type: "locate", ids: ["a"] });
  replay.remember({ type: "paper", graph });
  replay.remember({ type: "busy", text: "working" });
  replay.remember({ type: "cursor", file: "f.py", line: 1 });
  expect(replay.messages().map((m) => m.type)).toEqual(["graph", "paper", "locate", "notice"]);
});

test("a new graph forgets the stages and the location of the old one; clearNotice replaces the notice", () => {
  const replay = new Replay();
  const graph = g([n("a")], []);
  replay.remember({ type: "graph", graph });
  replay.remember({ type: "paper", graph });
  replay.remember({ type: "locate", ids: ["a"] });
  replay.remember({ type: "notice", level: "info", text: "hello" });
  replay.remember({ type: "graph", graph });
  replay.remember({ type: "clearNotice" });
  expect(replay.messages().map((m) => m.type)).toEqual(["graph", "clearNotice"]);
  replay.reset();
  expect(replay.messages()).toEqual([]);
});

// ---- Test Language Model: cancel, timeout, a failing model list ---------------------------

class HangingProvider implements LlmProvider {
  aborted = false;
  async listModels(): Promise<LlmModel[]> {
    return [CLAUDE];
  }
  complete(_prompt: string, opts: { modelId: string; signal?: AbortSignal }): Promise<string> {
    return new Promise((_resolve, reject) => {
      opts.signal?.addEventListener("abort", () => {
        this.aborted = true;
        reject(new LlmError("cancelled", "Cancelled"));
      });
    });
  }
}

test("the model test can be cancelled", async () => {
  const provider = new HangingProvider();
  const abort = new AbortController();
  const pending = testLanguageModel(provider, CLAUDE.id, { signal: abort.signal });
  await new Promise((r) => setTimeout(r, 20)); // the request is in flight now
  abort.abort();
  expect(await pending).toEqual({ ok: false, cancelled: true, report: M.TEST_CANCELLED });
  expect(provider.aborted).toBe(true);
});

test("a test cancelled before the request went out sends nothing", async () => {
  const provider = new FakeProvider([CLAUDE], ['{"ok": true}']);
  const abort = new AbortController();
  abort.abort();
  expect(await testLanguageModel(provider, CLAUDE.id, { signal: abort.signal }))
    .toEqual({ ok: false, cancelled: true, report: M.TEST_CANCELLED });
  expect(provider.prompts).toEqual([]);
});

test("a model that never answers is given up on after the timeout", async () => {
  const provider = new HangingProvider();
  const out = await testLanguageModel(provider, CLAUDE.id, { timeoutMs: 50 });
  expect(out.ok).toBe(false);
  expect(out.report).toBe(M.TEST_TIMEOUT("Claude X", 0.05));
  expect(provider.aborted).toBe(true);
});

test("an IDE whose model list throws is reported, not crashed on", async () => {
  const provider = new FakeProvider([CLAUDE], ["x"]);
  provider.listModels = async () => { throw new Error("lm api exploded"); };
  const out = await testLanguageModel(provider, CLAUDE.id);
  expect(out.ok).toBe(false);
  expect(out.report).toContain("lm api exploded");
});
