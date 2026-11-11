import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import type { ScannedClass } from "../src/ir";
import { parseProjectModels, projectModels, projectPrompt } from "../src/llm/projectModels";
import { LlmError, type LlmModel } from "../src/llm/provider";
import { LlmService } from "../src/llm/service";
import * as M from "../src/messages";
import { CLAUDE, FakeProvider } from "./fakeProvider";

const ROOT = path.resolve("/ws");
const cls = (name: string, rel: string, extra: Partial<ScannedClass> = {}): ScannedClass => ({
  name, file: path.join(ROOT, rel), line: 3, forwardParams: ["x"], docstring: `Doc of ${name}.`,
  submoduleTypes: ["Linear"], candidate: true, ...extra,
});
const NET = cls("Net", "models/net.py");
const GAN = cls("Gan", "gan.py");
const BLOCK = cls("Block", "models/blocks.py", { candidate: false });

function service(replies: (string | Error)[], o: { models?: LlmModel[]; grant?: boolean; consent?: boolean } = {}) {
  const provider = new FakeProvider(o.models ?? [CLAUDE], replies);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cd-pm-")), "cache");
  const llm = new LlmService(provider, {
    preferredModelId: () => CLAUDE.id, pickModel: async () => undefined,
    hasConsent: () => o.consent ?? true, askConsent: async () => o.grant ?? true,
  }, dir);
  return { provider, llm };
}
const reply = (models: unknown) => JSON.stringify({ models });

test("prompt lists only candidates, with relative paths", () => {
  const p = projectPrompt([NET, GAN, BLOCK], ROOT);
  expect(p).toContain("models/net.py::Net(x)");
  expect(p).toContain("Doc of Net.");
  expect(p).toContain("gan.py::Gan(x)");
  expect(p).not.toContain("Block(");
  expect(p).not.toContain(ROOT);
});

test("parse keeps the model's order and drops unknown name/file pairs", () => {
  const text = reply([
    { name: "Gan", file: "gan.py", summary: "A GAN." },
    { name: "Ghost", file: "gan.py", summary: "Invented." },
    { name: "Net", file: "other.py", summary: "Wrong file." },
    { name: "Net", file: "models/net.py", summary: "A net." },
  ]);
  expect(parseProjectModels(text, [NET, GAN], ROOT)).toEqual([
    { name: "Gan", file: GAN.file, line: 3, summary: "A GAN." },
    { name: "Net", file: NET.file, line: 3, summary: "A net." },
  ]);
});

test("parse matches files case-insensitively and with either separator", () => {
  const text = reply([{ name: "Net", file: "Models\\NET.py", summary: "s" }]);
  expect(parseProjectModels(text, [NET], ROOT).map((m) => m.file)).toEqual([NET.file]);
});

test("summary is trimmed to one line and 200 chars; a repeated entry is kept once", () => {
  const text = reply([
    { name: "Net", file: "models/net.py", summary: "  line one\nline two " + "x".repeat(300) },
    { name: "Net", file: "models/net.py", summary: "again" },
  ]);
  const out = parseProjectModels(text, [NET], ROOT);
  expect(out).toHaveLength(1);
  expect(out[0].summary.startsWith("line one line two")).toBe(true);
  expect(out[0].summary.length).toBe(200);
});

test("parse: not JSON or no models array → LlmError invalid-output", () => {
  expect(() => parseProjectModels("nope", [NET], ROOT)).toThrow(LlmError);
  expect(() => parseProjectModels('{"models": 3}', [NET], ROOT)).toThrow(LlmError);
});

test("no candidates → empty list, the model is not asked", async () => {
  const s = service([reply([])]);
  expect(await projectModels([BLOCK], ROOT, s.llm)).toEqual({ models: [] });
  expect(s.provider.prompts).toEqual([]);
});

test("the model's picks come back with summaries", async () => {
  const s = service([reply([{ name: "Net", file: "models/net.py", summary: "A net." }])]);
  expect(await projectModels([NET, GAN, BLOCK], ROOT, s.llm)).toEqual({
    models: [{ name: "Net", file: NET.file, line: 3, summary: "A net." }],
  });
});

test("LlmError no-model → all candidates, empty summaries, note = NO_LANGUAGE_MODEL", async () => {
  const s = service(["x"], { models: [] });
  const out = await projectModels([NET, GAN, BLOCK], ROOT, s.llm);
  expect(out.models.map((m) => [m.name, m.summary])).toEqual([["Net", ""], ["Gan", ""]]);
  expect(out.note).toBe(M.NO_LANGUAGE_MODEL);
});

test("invalid output → all candidates without summaries, note mentions it", async () => {
  const s = service(["I cannot do that"]);
  const out = await projectModels([NET, GAN], ROOT, s.llm);
  expect(out.models.map((m) => m.name)).toEqual(["Net", "Gan"]);
  expect(out.note).toBe(M.LLM_INVALID_OUTPUT);
});

test("zero valid entries in a valid JSON → falls back to all candidates", async () => {
  const s = service([reply([{ name: "Ghost", file: "x.py", summary: "?" }])]);
  const out = await projectModels([NET, GAN], ROOT, s.llm);
  expect(out.models.map((m) => m.name)).toEqual(["Net", "Gan"]);
  expect(out.note).toBe(M.LLM_INVALID_OUTPUT);
});

test("a provider error → all candidates, note carries the provider's message", async () => {
  const s = service([new Error("quota exceeded")]);
  const out = await projectModels([NET], ROOT, s.llm);
  expect([out.models.length, out.note]).toEqual([1, M.LLM_FAILED("quota exceeded")]);
});

test("consent-declined is rethrown", async () => {
  const s = service(["x"], { consent: false, grant: false });
  const e = await projectModels([NET], ROOT, s.llm).catch((x) => x);
  expect(e instanceof LlmError && e.kind).toBe("consent-declined");
});

test("at most 60 candidates are sent; the rest are appended unsummarised", async () => {
  const many = Array.from({ length: 65 }, (_, i) => cls(`M${i}`, `m${i}.py`));
  const s = service([reply([{ name: "M1", file: "m1.py", summary: "one" }])]);
  const out = await projectModels(many, ROOT, s.llm);
  expect(s.provider.prompts[0]).toContain("m59.py::M59(");
  expect(s.provider.prompts[0]).not.toContain("m60.py::M60(");
  expect(out.models.map((m) => m.name)).toEqual(["M1", "M60", "M61", "M62", "M63", "M64"]);
});
