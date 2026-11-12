import { expect, test } from "vitest";
import { LlmError } from "../src/llm/provider";
import { testLanguageModel } from "../src/llm/selfTest";
import { CLAUDE, FakeProvider, GEMINI } from "./fakeProvider";

test("a model that answers the JSON question passes, and the report names it", async () => {
  const provider = new FakeProvider([CLAUDE, GEMINI], ['Sure:\n```json\n{"ok": true, "answer": 4}\n```']);
  const out = await testLanguageModel(provider, GEMINI.id);
  expect(out.ok).toBe(true);
  expect(out.report).toContain("Gemini Y");
  expect(out.report).toContain("2 models offered");
  expect(provider.modelIds).toEqual([GEMINI.id]);
  expect(provider.prompts[0]).toContain("JSON"); // only a fixed question is sent, nothing from the workspace
});

test("no model offered by the IDE", async () => {
  const out = await testLanguageModel(new FakeProvider([], ["x"]), "");
  expect(out).toEqual({ ok: false, report: expect.stringContaining("offers no language model") });
});

test("no model chosen yet, or the chosen one is gone: says so and lists what is offered", async () => {
  const provider = new FakeProvider([CLAUDE], ["x"]);
  for (const id of ["", "gone-model"]) {
    const out = await testLanguageModel(provider, id);
    expect(out.ok).toBe(false);
    expect(out.report).toContain("Choose Language Model");
    expect(out.report).toContain("Claude X");
  }
  expect(provider.prompts).toEqual([]);
});

test("the model answers, but not with usable JSON", async () => {
  const out = await testLanguageModel(new FakeProvider([CLAUDE], ["I am not able to help with that."]), CLAUDE.id);
  expect(out.ok).toBe(false);
  expect(out.report).toContain("did not follow the requested JSON format");
  expect(out.report).toContain("I am not able to help");
});

test("the request fails: the provider's message is shown", async () => {
  const provider = new FakeProvider([CLAUDE], [new LlmError("provider", "quota exceeded")]);
  const out = await testLanguageModel(provider, CLAUDE.id);
  expect(out.ok).toBe(false);
  expect(out.report).toContain("quota exceeded");
});

test("no model at all: the report says how to get one with a Gemini key", async () => {
  const out = await testLanguageModel(new FakeProvider([], ["x"]), "");
  expect(out.report).toContain("Set Gemini API Key");
});
