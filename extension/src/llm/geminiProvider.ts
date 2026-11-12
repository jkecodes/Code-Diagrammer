// Gemini through Google's API with the user's own key, for IDEs that offer no model to extensions.
// No `vscode` import: the key and `fetch` are handed in.
import { LlmError, type LlmModel, type LlmProvider } from "./provider";

export const GEMINI_PREFIX = "gemini:";
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_PAGES = 5;

type ListedModel = { name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown };

export class GeminiProvider implements LlmProvider {
  private listed: LlmModel[] | undefined; // of the current key; asked for once, not on every request

  constructor(
    private readonly getKey: () => Promise<string | undefined>,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 120_000,
  ) {}

  /** The key was set, replaced or removed: the remembered model list belongs to the old one. */
  keyChanged(): void {
    this.listed = undefined;
  }

  /** Empty without a key. Throws LlmError("provider") when Google rejects the key or cannot be reached. */
  async listModels(): Promise<LlmModel[]> {
    const key = (await this.getKey())?.trim();
    if (!key) return [];
    if (this.listed) return this.listed;
    const models: LlmModel[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${BASE}/models?pageSize=200` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const data = await this.request(url, key, { method: "GET" }) as { models?: unknown; nextPageToken?: unknown };
      for (const m of (Array.isArray(data.models) ? data.models : []) as ListedModel[]) {
        const name = typeof m?.name === "string" ? m.name : "";
        const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
        if (!name.startsWith("models/gemini") || !methods.includes("generateContent")) continue;
        const id = name.slice("models/".length);
        const label = typeof m.displayName === "string" && m.displayName ? m.displayName : id;
        models.push({ id: GEMINI_PREFIX + id, name: `${label} (Google API key)`, vendor: "Google" });
      }
      pageToken = typeof data.nextPageToken === "string" && data.nextPageToken ? data.nextPageToken : undefined;
      if (!pageToken) break;
    }
    this.listed = models;
    return models;
  }

  async complete(prompt: string, opts: { modelId: string; signal?: AbortSignal }): Promise<string> {
    if (opts.signal?.aborted) throw new LlmError("cancelled", "Cancelled");
    if (!opts.modelId.startsWith(GEMINI_PREFIX)) {
      throw new LlmError("provider", `${opts.modelId} is not a Gemini model`);
    }
    const key = (await this.getKey())?.trim();
    if (!key) throw new LlmError("provider", "No Gemini API key is set");
    const model = encodeURIComponent(opts.modelId.slice(GEMINI_PREFIX.length));
    const data = await this.request(`${BASE}/models/${model}:generateContent`, key, {
      method: "POST",
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // every question this extension asks wants JSON back
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    }, opts.signal) as {
      candidates?: { content?: { parts?: { text?: unknown }[] }; finishReason?: unknown }[];
      promptFeedback?: { blockReason?: unknown };
    };
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
    if (text) return text;
    const reason = data.promptFeedback?.blockReason ?? candidate?.finishReason ?? "no answer";
    throw new LlmError("provider", `Gemini returned no text (${String(reason)})`);
  }

  /** One HTTP exchange. The key travels in a header, and is removed from anything that is reported. */
  private async request(url: string, key: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const abort = new AbortController();
    let timedOut = false;
    const onCancel = () => abort.abort();
    signal?.addEventListener("abort", onCancel);
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.timeoutMs);
    const clean = (text: string) => text.split(key).join("***");
    try {
      const response = await this.fetchFn(url, {
        ...init,
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        signal: abort.signal,
      });
      const body = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
      if (!response.ok) {
        const message = (parsed as { error?: { message?: unknown } } | undefined)?.error?.message;
        throw new LlmError("provider",
          typeof message === "string" && message ? clean(message) : `Google answered with HTTP ${response.status}`);
      }
      if (parsed === undefined || parsed === null || typeof parsed !== "object") {
        throw new LlmError("provider", "Google's answer could not be read");
      }
      return parsed;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (timedOut) {
        throw new LlmError("provider", `Gemini did not answer within ${Math.round(this.timeoutMs / 1000)} s`);
      }
      if (signal?.aborted) throw new LlmError("cancelled", "Cancelled");
      throw new LlmError("provider", clean(e instanceof Error ? e.message : String(e)));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCancel);
    }
  }
}
