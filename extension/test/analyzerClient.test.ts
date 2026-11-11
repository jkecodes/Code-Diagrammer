import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { AnalyzerClient } from "../src/analyzerClient";

const ANALYZER = path.resolve(__dirname, "../../analyzer");
const PY = path.resolve(__dirname, "../../.venv/Scripts/python.exe");
const fixtures = path.resolve(__dirname, "../../analyzer/tests/fixtures");
const cnn = path.join(fixtures, "simple_cnn.py");
const make = (o: Partial<ConstructorParameters<typeof AnalyzerClient>[0]> = {}) =>
  new AnalyzerClient({ pythonPath: PY, analyzerDir: ANALYZER, timeoutMs: 30000, ...o });

test("lists classes", async () => {
  const r = await make().listClasses(cnn);
  expect(r.ok && r.value.map((c) => c.name)).toEqual(["Block", "SimpleCNN"]);
});

test("static graph", async () => {
  const r = await make().analyzeStatic({ file: cnn, entry: "SimpleCNN", workspaceRoot: fixtures });
  expect(r.ok && r.value.meta.mode).toBe("static");
});

test("traced graph has shapes", async () => {
  const r = await make().trace({
    file: cnn, entry: "SimpleCNN", workspaceRoot: fixtures, ctorKwargs: {},
    inputs: { x: [2, 3, 16, 16] }, device: "auto",
  });
  expect(r.ok && r.value.root.edges[0].shape).toEqual([2, 3, 16, 16]);
});

test("trace failure passes the log through", async () => {
  const r = await make().trace({
    file: cnn, entry: "SimpleCNN", workspaceRoot: fixtures, ctorKwargs: { nope: 1 },
    inputs: { x: [2, 3, 16, 16] }, device: "auto",
  });
  expect(r.ok && r.value.meta.traceError).toMatch(/^construct: /);
  expect(r.ok && r.log).toContain("nope");
});

test("analyzes a file in a path with spaces", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cd test "));
  fs.copyFileSync(cnn, path.join(dir, "simple_cnn.py"));
  const r = await make().analyzeStatic({
    file: path.join(dir, "simple_cnn.py"), entry: "SimpleCNN", workspaceRoot: dir,
  });
  expect(r.ok).toBe(true);
});

test("python not found", async () => {
  const r = await make({ pythonPath: "no-such-python-xyz" }).listClasses(cnn);
  expect(!r.ok && r.error.kind).toBe("python-not-found");
});

test("timeout kills the process", async () => {
  const r = await make({
    timeoutMs: 300, analyzerDir: path.resolve(__dirname, "fixtures"), moduleName: "sleeper",
  }).listClasses(cnn);
  expect(!r.ok && r.error.kind).toBe("timeout");
});

test("syntax error is passed through", async () => {
  const r = await make().analyzeStatic({
    file: path.join(fixtures, "broken.py"), entry: "X", workspaceRoot: fixtures,
  });
  expect(!r.ok && r.error.kind).toBe("syntax");
});

test("runs with the analyzer folder as working directory", async () => {
  const dir = path.resolve(__dirname, "fixtures");
  const r = await make({ analyzerDir: dir, moduleName: "cwdprobe" }).listClasses(cnn);
  const cwd = r.ok ? (r.value as unknown as string[])[0] : "";
  expect(path.resolve(cwd).toLowerCase()).toBe(dir.toLowerCase());
});

test("the python path is resolved for every request", async () => {
  let current = "no-such-python-xyz";
  const client = make({ pythonPath: () => current });
  const first = await client.listClasses(cnn);
  expect(!first.ok && first.error.kind).toBe("python-not-found");
  current = PY;
  expect((await client.listClasses(cnn)).ok).toBe(true);
});

test("scans a workspace", async () => {
  const r = await make().scan(path.join(fixtures, "scanproj"));
  expect(r.ok && r.value.filter((c) => c.candidate).map((c) => c.name).sort())
    .toEqual(["Net", "UsesLatin", "WithBom"]);
});
