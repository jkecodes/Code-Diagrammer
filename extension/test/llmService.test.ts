import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { LlmError, type LlmModel } from "../src/llm/provider";
import { extractJson, LlmService, type LlmHost } from "../src/llm/service";
import { CLAUDE, FakeProvider, GEMINI } from "./fakeProvider";

function setup(o: {
  models?: LlmModel[]; replies?: (string | Error)[]; preferred?: string; consent?: boolean;
  grant?: boolean; pick?: LlmModel | undefined;
} = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cd-llm-")), "cache");
  const provider = new FakeProvider(o.models ?? [CLAUDE, GEMINI], o.replies ?? ["hello"]);
  const state = { consent: o.consent ?? true, asked: 0, picks: 0, preferred: o.preferred ?? CLAUDE.id };
  const host: LlmHost = {
    preferredModelId: () => state.preferred,
    hasConsent: () => state.consent,
    askConsent: async () => { state.asked++; if (o.grant ?? true) state.consent = true; return o.grant ?? true; },
    pickModel: async () => {
      state.picks++;
      const picked = "pick" in o ? o.pick : GEMINI;
      if (picked) state.preferred = picked.id;
      return picked;
    },
  };
  return { provider, state, service: new LlmService(provider, host, dir), dir };
}
const kindOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof LlmError ? e.kind : String(e); }
  return "resolved";
};

test("asks the preferred model and returns its text", async () => {
  const s = setup({ preferred: GEMINI.id });
  const a = await s.service.ask("p", { kind: "k" });
  expect([a.text, a.model.id, a.cached, s.provider.modelIds]).toEqual(["hello", GEMINI.id, false, [GEMINI.id]]);
  expect(s.state.picks).toBe(0);
});

test("no preferred model → the user picks one; the picked model is used", async () => {
  const s = setup({ preferred: "" });
  const a = await s.service.ask("p", { kind: "k" });
  expect([a.model.id, s.state.picks]).toEqual([GEMINI.id, 1]);
});

test("a preferred model that is gone → the user is asked to pick again", async () => {
  const s = setup({ preferred: "retired-model", pick: CLAUDE });
  const a = await s.service.ask("p", { kind: "k" });
  expect([a.model.id, s.state.picks]).toEqual([CLAUDE.id, 1]);
});

test("dismissing the model picker → LlmError cancelled, provider not called, consent not asked", async () => {
  const s = setup({ preferred: "", pick: undefined, consent: false });
  expect(await kindOf(s.service.ask("p", { kind: "k" }))).toBe("cancelled");
  expect([s.provider.prompts.length, s.state.asked]).toEqual([0, 0]);
});

test("no models → LlmError no-model, consent never asked", async () => {
  const s = setup({ models: [], consent: false });
  expect(await kindOf(s.service.ask("p", { kind: "k" }))).toBe("no-model");
  expect([s.state.asked, s.state.picks]).toEqual([0, 0]);
});

test("declined consent → LlmError consent-declined, provider not called", async () => {
  const s = setup({ consent: false, grant: false });
  expect(await kindOf(s.service.ask("p", { kind: "k" }))).toBe("consent-declined");
  expect(s.provider.prompts).toEqual([]);
});

test("consent is asked once", async () => {
  const s = setup({ consent: false });
  await s.service.ask("p", { kind: "k" });
  await s.service.ask("q", { kind: "k" });
  expect(s.state.asked).toBe(1);
});

test("same prompt+kind+model is served from the cache", async () => {
  const s = setup();
  await s.service.ask("p", { kind: "k" });
  const again = await s.service.ask("p", { kind: "k" });
  expect([s.provider.prompts.length, again.cached, again.text, again.model.id])
    .toEqual([1, true, "hello", CLAUDE.id]);
});

test("a different model id or kind misses the cache", async () => {
  const s = setup();
  await s.service.ask("p", { kind: "k" });
  await s.service.ask("p", { kind: "other" });
  s.state.preferred = GEMINI.id;
  await s.service.ask("p", { kind: "k" });
  expect(s.provider.prompts.length).toBe(3);
});

test("regenerate bypasses and then overwrites the cache", async () => {
  const s = setup({ replies: ["one", "two"] });
  await s.service.ask("p", { kind: "k" });
  expect((await s.service.ask("p", { kind: "k", regenerate: true })).text).toBe("two");
  const later = await s.service.ask("p", { kind: "k" });
  expect([later.text, later.cached]).toEqual(["two", true]);
});

test("cached() returns undefined on a miss and never calls the provider", async () => {
  const s = setup();
  expect(await s.service.cached("p", "k")).toBeUndefined();
  await s.service.ask("p", { kind: "k" });
  expect((await s.service.cached("p", "k"))?.text).toBe("hello");
  expect(s.provider.prompts.length).toBe(1);
});

test("cached() with no valid preferred model → undefined, and the picker is not shown", async () => {
  const s = setup();
  await s.service.ask("p", { kind: "k" });
  s.state.preferred = "";
  expect(await s.service.cached("p", "k")).toBeUndefined();
  expect(s.state.picks).toBe(0);
});

test("a corrupt cache file is a miss", async () => {
  const s = setup({ replies: ["one", "two"] });
  await s.service.ask("p", { kind: "k" });
  for (const f of fs.readdirSync(s.dir)) fs.writeFileSync(path.join(s.dir, f), "{not json");
  expect((await s.service.ask("p", { kind: "k" })).text).toBe("two");
});

test("an aborted signal → LlmError cancelled and nothing is cached", async () => {
  const s = setup();
  const c = new AbortController();
  c.abort();
  expect(await kindOf(s.service.ask("p", { kind: "k", signal: c.signal }))).toBe("cancelled");
  expect(await s.service.cached("p", "k")).toBeUndefined();
});

test("a provider error → LlmError provider with its message; nothing cached", async () => {
  const s = setup({ replies: [new Error("quota exceeded")] });
  const e = await s.service.ask("p", { kind: "k" }).catch((x) => x);
  expect([e instanceof LlmError && e.kind, e.message]).toEqual(["provider", "quota exceeded"]);
  expect(await s.service.cached("p", "k")).toBeUndefined();
});

test("extractJson", () => {
  expect(extractJson('Sure!\n```json\n{"a": {"b": 1}}\n```\nDone {"c":2}')).toEqual({ a: { b: 1 } });
  expect(extractJson('{"s": "a } brace \\" quote"}')).toEqual({ s: 'a } brace " quote' });
  expect(() => extractJson("no json here")).toThrow(LlmError);
  expect(() => extractJson('{"open": 1')).toThrow(LlmError);
});
