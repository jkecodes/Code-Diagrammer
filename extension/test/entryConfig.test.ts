import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { configMalformed, loadEntry, loadStyles, saveEntry, templateFor } from "../src/entryConfig";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cd-entry-"));

test("save then load round-trips, keyed by forward-slash relative path", () => {
  const root = tmp();
  const file = path.join(root, "sub", "model.py");
  const entry = { className: "Net", ctorKwargs: { n: 2 }, inputs: { x: [1, 3, 8, 8] } };
  saveEntry(root, file, entry);
  expect(loadEntry(root, file)).toEqual(entry);
  const raw = JSON.parse(fs.readFileSync(path.join(root, ".vscode", "code-diagrammer.json"), "utf8"));
  expect(Object.keys(raw.entries)).toEqual(["sub/model.py"]);
});

test("saving a second file keeps the first", () => {
  const root = tmp();
  saveEntry(root, path.join(root, "a.py"), { className: "A", ctorKwargs: {}, inputs: {} });
  saveEntry(root, path.join(root, "b.py"), { className: "B", ctorKwargs: {}, inputs: {} });
  expect(loadEntry(root, path.join(root, "a.py"))?.className).toBe("A");
});

test("malformed config is treated as empty", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".vscode"));
  fs.writeFileSync(path.join(root, ".vscode", "code-diagrammer.json"), "{ not json");
  expect(loadEntry(root, path.join(root, "a.py"))).toBeUndefined();
});

test("missing config is treated as empty", () => {
  expect(loadEntry(tmp(), "x.py")).toBeUndefined();
});

test("template gives every required forward parameter a default shape", () => {
  const t = templateFor({
    name: "Net", line: 1, topLevel: true, initParams: [],
    forwardParams: [{ name: "x", hasDefault: false }, { name: "flag", hasDefault: true }],
  });
  expect(t).toEqual({ className: "Net", ctorKwargs: {}, inputs: { x: [1, 3, 224, 224] } });
});

test("loadStyles reads the styles object; missing file or wrong type → {}", () => {
  const root = tmp();
  expect(loadStyles(root)).toEqual({});
  fs.mkdirSync(path.join(root, ".vscode"));
  const file = path.join(root, ".vscode", "code-diagrammer.json");
  fs.writeFileSync(file, JSON.stringify({ entries: {}, styles: { A: { role: "encoder" }, B: "red", C: null } }));
  expect(loadStyles(root)).toEqual({ A: { role: "encoder" } });
  fs.writeFileSync(file, JSON.stringify({ styles: { A: { color: "red" } } }));
  expect(loadStyles(root)).toEqual({ A: { color: "red" } });
  fs.writeFileSync(file, JSON.stringify({ entries: {}, styles: [1] }));
  expect(loadStyles(root)).toEqual({});
});

test("saveEntry keeps the styles (and any other top-level key) already in the file", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".vscode"));
  const file = path.join(root, ".vscode", "code-diagrammer.json");
  fs.writeFileSync(file, JSON.stringify({ entries: {}, styles: { A: { role: "encoder" } }, other: 1 }));
  saveEntry(root, path.join(root, "a.py"), { className: "A", ctorKwargs: {}, inputs: {} });
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(parsed.styles).toEqual({ A: { role: "encoder" } });
  expect(parsed.other).toBe(1);
  expect(parsed.entries["a.py"].className).toBe("A");
});

test("a config file that is not valid JSON is never overwritten", () => {
  const root = tmp();
  expect(configMalformed(root)).toBe(false); // no file yet
  fs.mkdirSync(path.join(root, ".vscode"));
  const file = path.join(root, ".vscode", "code-diagrammer.json");
  const text = '{ "entries": {}, "styles": { "A": { "role": "encoder" }, } }'; // trailing comma
  fs.writeFileSync(file, text);
  expect(configMalformed(root)).toBe(true);
  expect(saveEntry(root, path.join(root, "a.py"), { className: "A", ctorKwargs: {}, inputs: {} })).toBe(false);
  expect(fs.readFileSync(file, "utf8")).toBe(text);
  fs.writeFileSync(file, "[1, 2]"); // valid JSON, but not a config object
  expect(configMalformed(root)).toBe(true);
  fs.writeFileSync(file, JSON.stringify({ entries: {} }));
  expect(configMalformed(root)).toBe(false);
  expect(saveEntry(root, path.join(root, "a.py"), { className: "A", ctorKwargs: {}, inputs: {} })).toBe(true);
});
