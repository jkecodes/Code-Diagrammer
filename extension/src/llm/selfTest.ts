// "Does the language model work here?" — one fixed question, sent to the model the user chose.
// Nothing from the workspace is sent, so no consent is needed and nothing is cached.
import * as M from "../messages";
import type { LlmProvider } from "./provider";
import { extractJson } from "./service";

const QUESTION =
  'This is a connection test. Answer with JSON only, exactly in this form: {"ok": true, "answer": <2 + 2>}';

export type TestResult = { ok: boolean; report: string; cancelled?: true };

export async function testLanguageModel(
  provider: LlmProvider, preferredModelId: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<TestResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let models;
  try {
    models = await provider.listModels();
  } catch (e) {
    return { ok: false, report: M.TEST_LIST_FAILED(e instanceof Error ? e.message : String(e)) };
  }
  if (models.length === 0) return { ok: false, report: M.TEST_NO_MODELS };
  const offered = models.map((m) => m.name).join(", ");
  const model = models.find((m) => m.id === preferredModelId);
  if (!model) return { ok: false, report: M.TEST_NOT_CHOSEN(offered) };

  if (opts.signal?.aborted) return { ok: false, cancelled: true, report: M.TEST_CANCELLED };

  // one signal for the request: the user's cancel or the timeout, whichever comes first
  const abort = new AbortController();
  let timedOut = false;
  const onCancel = () => abort.abort();
  opts.signal?.addEventListener("abort", onCancel);
  if (opts.signal?.aborted) abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    if (abort.signal.aborted) reject(new Error("stopped")); // cancelled while the models were listed
    abort.signal.addEventListener("abort", () => reject(new Error("stopped")));
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);
  });

  const started = Date.now();
  let reply: string;
  try {
    const request = provider.complete(QUESTION, { modelId: model.id, signal: abort.signal });
    request.catch(() => undefined); // a provider that ignores the signal may still fail later
    reply = await Promise.race([request, stopped]);
  } catch (e) {
    if (timedOut) return { ok: false, report: M.TEST_TIMEOUT(model.name, timeoutMs / 1000) };
    if (abort.signal.aborted) return { ok: false, cancelled: true, report: M.TEST_CANCELLED };
    return { ok: false, report: M.TEST_REQUEST_FAILED(model.name, e instanceof Error ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCancel);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  let parsed: unknown;
  try {
    parsed = extractJson(reply);
  } catch {
    parsed = undefined;
  }
  const usable = typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === true;
  const excerpt = reply.trim().slice(0, 200);
  return usable
    ? { ok: true, report: M.TEST_PASSED(model.name, models.length, seconds, excerpt) }
    : { ok: false, report: M.TEST_BAD_FORMAT(model.name, excerpt) };
}
