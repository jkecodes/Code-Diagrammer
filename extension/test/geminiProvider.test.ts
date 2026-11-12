import { expect, test } from "vitest";
import { CombinedProvider } from "../src/llm/combinedProvider";
import { GEMINI_PREFIX, GeminiProvider } from "../src/llm/geminiProvider";
import { LlmError } from "../src/llm/provider";
import { CLAUDE, FakeProvider } from "./fakeProvider";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
type Reply = { status?: number; json?: unknown; text?: string } | Error | ((signal?: AbortSignal) => Promise<Response>);

/** A scripted `fetch`: replies are consumed in order, the last one repeats. */
function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input), method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(init?.signal ?? undefined);
    return new Response(reply.text ?? JSON.stringify(reply.json), { status: reply.status ?? 200 });
  };
  return { fn: fn as typeof fetch, calls };
}

const MODELS = {
  models: [
    { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
    { name: "models/gemini-embedding-001", displayName: "Gemini Embedding", supportedGenerationMethods: ["embedContent"] },
    { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
    { name: "models/imagen-4", displayName: "Imagen 4", supportedGenerationMethods: ["predict"] },
  ],
};
const answer = (text: string) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] });
const provider = (replies: Reply[], key: string | null = "KEY-123") => {
  const f = fakeFetch(replies);
  return { p: new GeminiProvider(async () => key ?? undefined, f.fn), calls: f.calls };
};
const failure = async (run: Promise<unknown>) => {
  const e = await run.catch((x) => x);
  expect(e).toBeInstanceOf(LlmError);
  return e as LlmError;
};

test("without a key no model is offered and nothing is requested", async () => {
  const { p, calls } = provider([{ json: MODELS }], null);
  expect(await p.listModels()).toEqual([]);
  expect(calls).toEqual([]);
});

test("lists the models that can generate text, with the key in a header and never in the URL", async () => {
  const { p, calls } = provider([{ json: MODELS }]);
  expect(await p.listModels()).toEqual([
    { id: "gemini:gemini-2.5-flash", name: "Gemini 2.5 Flash (Google API key)", vendor: "Google" },
    { id: "gemini:gemini-2.5-pro", name: "gemini-2.5-pro (Google API key)", vendor: "Google" },
  ]);
  expect(GEMINI_PREFIX).toBe("gemini:");
  expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200");
  expect(calls[0].headers["x-goog-api-key"]).toBe("KEY-123");
  expect(calls[0].url).not.toContain("KEY-123");
});

test("follows nextPageToken", async () => {
  const { p, calls } = provider([
    { json: { models: [MODELS.models[0]], nextPageToken: "p 2" } },
    { json: { models: [MODELS.models[2]] } },
  ]);
  expect((await p.listModels()).map((m) => m.id)).toEqual(["gemini:gemini-2.5-flash", "gemini:gemini-2.5-pro"]);
  expect(calls[1].url).toContain("pageToken=p%202");
});

test("the model list is remembered, until the key changes", async () => {
  const { p, calls } = provider([{ json: MODELS }]);
  await p.listModels();
  await p.listModels();
  expect(calls).toHaveLength(1);
  p.keyChanged();
  await p.listModels();
  expect(calls).toHaveLength(2);
});

test("a rejected key is a provider error with Google's message, and is not remembered", async () => {
  const { p, calls } = provider([
    { status: 400, json: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } } },
    { json: MODELS },
  ]);
  const e = await failure(p.listModels());
  expect([e.kind, e.message]).toEqual(["provider", "API key not valid. Please pass a valid API key."]);
  expect(await p.listModels()).toHaveLength(2);
  expect(calls).toHaveLength(2);
});

test("no network is a provider error", async () => {
  const e = await failure(provider([new TypeError("fetch failed")]).p.listModels());
  expect(e.kind).toBe("provider");
  expect(e.message).toContain("fetch failed");
});

test("complete posts the prompt, asks for JSON and joins the parts of the answer", async () => {
  const { p, calls } = provider([
    { json: { candidates: [{ content: { parts: [{ text: '{"ok":' }, { text: " true}" }] } }] } },
  ]);
  expect(await p.complete("the prompt", { modelId: "gemini:gemini-2.5-flash" })).toBe('{"ok": true}');
  expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  expect(calls[0].method).toBe("POST");
  expect(calls[0].headers["x-goog-api-key"]).toBe("KEY-123");
  expect(calls[0].body).toEqual({
    contents: [{ role: "user", parts: [{ text: "the prompt" }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  });
});

test("complete: quota and other API errors carry Google's message", async () => {
  const { p } = provider([{ status: 429, json: { error: { message: "Quota exceeded for quota metric." } } }]);
  const e = await failure(p.complete("x", { modelId: "gemini:gemini-2.5-flash" }));
  expect([e.kind, e.message]).toEqual(["provider", "Quota exceeded for quota metric."]);
  const html = provider([{ status: 502, text: "<html>Bad Gateway</html>" }]).p;
  expect((await failure(html.complete("x", { modelId: "gemini:m" }))).message).toBe("Google answered with HTTP 502");
});

test("complete: an answer without text says why (blocked prompt, empty candidates)", async () => {
  const blocked = provider([{ json: { promptFeedback: { blockReason: "SAFETY" } } }]).p;
  expect((await failure(blocked.complete("x", { modelId: "gemini:m" }))).message).toContain("SAFETY");
  const empty = provider([{ json: { candidates: [{ finishReason: "MAX_TOKENS" }] } }]).p;
  expect((await failure(empty.complete("x", { modelId: "gemini:m" }))).message).toContain("MAX_TOKENS");
});

test("complete: no key, or an id that is not a Gemini id, is a provider error without a request", async () => {
  const none = provider([{ json: answer("x") }], null);
  expect((await failure(none.p.complete("x", { modelId: "gemini:m" }))).kind).toBe("provider");
  const wrong = provider([{ json: answer("x") }]);
  expect((await failure(wrong.p.complete("x", { modelId: "claude-x" }))).kind).toBe("provider");
  expect([...none.calls, ...wrong.calls]).toEqual([]);
});

test("complete: the model id cannot escape the URL path", async () => {
  const { p, calls } = provider([{ json: answer("x") }]);
  await p.complete("x", { modelId: "gemini:../../v1/evil?x=1" });
  expect(calls[0].url).toBe(
    "https://generativelanguage.googleapis.com/v1beta/models/..%2F..%2Fv1%2Fevil%3Fx%3D1:generateContent");
});

test("complete: cancelling aborts the request and reports cancelled", async () => {
  const abort = new AbortController();
  const hang = (signal?: AbortSignal) => new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const { p } = provider([hang]);
  const pending = p.complete("x", { modelId: "gemini:m", signal: abort.signal });
  setTimeout(() => abort.abort(), 20);
  expect((await failure(pending)).kind).toBe("cancelled");
  const already = new AbortController();
  already.abort();
  expect((await failure(p.complete("x", { modelId: "gemini:m", signal: already.signal }))).kind).toBe("cancelled");
});

test("complete: a model that never answers is given up on", async () => {
  const hang = (signal?: AbortSignal) => new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const f = fakeFetch([hang]);
  const p = new GeminiProvider(async () => "KEY", f.fn, 40);
  const e = await failure(p.complete("x", { modelId: "gemini:m" }));
  expect(e.kind).toBe("provider");
  expect(e.message).toContain("did not answer");
});

test("the key never appears in an error message", async () => {
  const { p } = provider([{ status: 403, json: { error: { message: "Key KEY-123 is not allowed" } } }]);
  expect((await failure(p.listModels())).message).toBe("Key *** is not allowed");
});

// ---- several sources behind one provider --------------------------------------------------

test("combined: models of every source, in order; requests go to the source that owns the id", async () => {
  const ide = new FakeProvider([CLAUDE], ["from the IDE"]);
  const g = provider([{ json: MODELS }, { json: answer("from Gemini") }]);
  const both = new CombinedProvider([ide, g.p]);
  expect((await both.listModels()).map((m) => m.id)).toEqual([CLAUDE.id, "gemini:gemini-2.5-flash", "gemini:gemini-2.5-pro"]);
  expect(await both.complete("p", { modelId: CLAUDE.id })).toBe("from the IDE");
  expect(await both.complete("p", { modelId: "gemini:gemini-2.5-pro" })).toBe("from Gemini");
  expect(ide.prompts).toEqual(["p"]);
});

test("combined: one failing source does not hide the other's models", async () => {
  const ide = new FakeProvider([CLAUDE], ["x"]);
  const bad = provider([{ status: 400, json: { error: { message: "API key not valid." } } }]);
  expect((await new CombinedProvider([ide, bad.p]).listModels()).map((m) => m.id)).toEqual([CLAUDE.id]);
});

test("combined: when no source has a model, a source's failure is the reason given", async () => {
  const none = new FakeProvider([], ["x"]);
  const bad = provider([{ status: 400, json: { error: { message: "API key not valid." } } }]);
  const e = await failure(new CombinedProvider([none, bad.p]).listModels());
  expect(e.message).toBe("API key not valid.");
  expect(await new CombinedProvider([none, provider([{ json: MODELS }], null).p]).listModels()).toEqual([]);
});

test("combined: an id no source offers is a provider error", async () => {
  const both = new CombinedProvider([new FakeProvider([CLAUDE], ["x"]), provider([{ json: MODELS }]).p]);
  expect((await failure(both.complete("p", { modelId: "ghost" }))).kind).toBe("provider");
});
