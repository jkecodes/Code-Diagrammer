import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import type { ScannedClass } from "../src/ir";
import { LlmError, type LlmModel } from "../src/llm/provider";
import { classRoles, parseRoles, rolesPrompt } from "../src/llm/roles";
import { LlmService } from "../src/llm/service";
import { CLAUDE, FakeProvider } from "./fakeProvider";

const cls = (name: string, extra: Partial<ScannedClass> = {}): ScannedClass => ({
  name, file: path.join("/secret/ws", name + ".py"), line: 3, forwardParams: ["x"], docstring: `Doc of ${name}.`,
  submoduleTypes: ["Linear"], candidate: false, ...extra,
});
const ENC = cls("Enc");
const VOC = cls("Voc");

function service(replies: (string | Error)[], models: LlmModel[] = [CLAUDE]) {
  const provider = new FakeProvider(models, replies);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cd-roles-")), "cache");
  const llm = new LlmService(provider, {
    preferredModelId: () => CLAUDE.id, pickModel: async () => undefined,
    hasConsent: () => true, askConsent: async () => true,
  }, dir);
  return { provider, llm };
}
const reply = (roles: unknown) => JSON.stringify({ roles });

test("prompt lists classes without paths and names the allowed roles, shapes and colours", () => {
  const p = rolesPrompt([ENC, VOC]);
  expect(p).toContain("- Enc(x) — Doc of Enc. — uses: Linear");
  expect(p).not.toContain("secret");
  for (const word of ["encoder", "discriminator", "attention", "trapezoid-narrow", "hexagon", "teal", "pink"]) {
    expect(p).toContain(word);
  }
  expect(p).not.toContain("activation"); // decided by rule, not by the model
});

test("parse: table role, invented role with look, unknown class dropped, first entry per class wins", () => {
  const text = reply([
    { name: "Enc", role: "encoder", shape: "circle" },
    { name: "Voc", role: "vocoder", shape: "hexagon", color: "teal" },
    { name: "Ghost", role: "encoder" },
    { name: "Enc", role: "decoder" },
    "junk", { name: 3, role: "head" }, { name: "Voc" },
  ]);
  expect(parseRoles(text, [ENC, VOC])).toEqual({
    Enc: { role: "encoder", shape: "trapezoid-narrow", color: "blue" },
    Voc: { role: "vocoder", shape: "hexagon", color: "teal" },
  });
});

test("parse: two classes with the same invented role share the first look", () => {
  const text = reply([
    { name: "Enc", role: "vocoder", shape: "hexagon", color: "teal" },
    { name: "Voc", role: "Vocoder", shape: "circle", color: "red" },
  ]);
  expect(parseRoles(text, [ENC, VOC]).Voc).toEqual({ role: "vocoder", shape: "hexagon", color: "teal" });
});

test("parse: a class named like an object property is handled as a name", () => {
  const odd = cls("constructor");
  expect(parseRoles(reply([{ name: "constructor", role: "head" }, { name: "toString", role: "head" }]), [odd]))
    .toEqual({ constructor: { role: "head", shape: "rounded", color: "orange" } });
});

test("parse: not JSON / no roles array → LlmError invalid-output", () => {
  for (const text of ["nope", '{"roles": 3}', "[]"]) {
    const err = (() => { try { parseRoles(text, [ENC]); } catch (e) { return e; } })();
    expect(err instanceof LlmError && err.kind).toBe("invalid-output");
  }
});

test("classRoles: no classes → {} and no request", async () => {
  const s = service([reply([])]);
  expect(await classRoles([], s.llm)).toEqual({});
  expect(s.provider.prompts).toEqual([]);
});

test("classRoles: candidates come first and at most 150 classes are sent", async () => {
  const many = Array.from({ length: 160 }, (_, i) => cls(`C${i}`));
  many[159] = cls("Main", { candidate: true });
  const s = service([reply([{ name: "Main", role: "head" }])]);
  const out = await classRoles(many, s.llm);
  const prompt = s.provider.prompts[0];
  expect(prompt.indexOf("- Main(")).toBeLessThan(prompt.indexOf("- C0("));
  expect(prompt).toContain("- C148(");
  expect(prompt).not.toContain("- C149(");
  expect(Object.keys(out)).toEqual(["Main"]);
});

test("classRoles: a second call is served from the cache; regenerate asks again", async () => {
  const s = service([reply([{ name: "Enc", role: "encoder" }])]);
  await classRoles([ENC], s.llm);
  await classRoles([ENC], s.llm);
  expect(s.provider.prompts).toHaveLength(1);
  await classRoles([ENC], s.llm, { regenerate: true });
  expect(s.provider.prompts).toHaveLength(2);
});

test("classRoles: no model → LlmError no-model is thrown", async () => {
  const s = service(["x"], []);
  const err = await classRoles([ENC], s.llm).catch((x) => x);
  expect(err instanceof LlmError && err.kind).toBe("no-model");
});

test("classRoles: an unusable answer → LlmError invalid-output", async () => {
  const err = await classRoles([ENC], service(["I cannot"]).llm).catch((x) => x);
  expect(err instanceof LlmError && err.kind).toBe("invalid-output");
});
