// "Does the language model work here?" — one fixed question, sent to the model the user chose.
// Nothing from the workspace is sent, so no consent is needed and nothing is cached.
import * as M from "../messages";
import type { LlmProvider } from "./provider";
import { extractJson } from "./service";

const QUESTION =
  'This is a connection test. Answer with JSON only, exactly in this form: {"ok": true, "answer": <2 + 2>}';

export async function testLanguageModel(
  provider: LlmProvider, preferredModelId: string,
): Promise<{ ok: boolean; report: string }> {
  const models = await provider.listModels();
  if (models.length === 0) return { ok: false, report: M.TEST_NO_MODELS };
  const offered = models.map((m) => m.name).join(", ");
  const model = models.find((m) => m.id === preferredModelId);
  if (!model) return { ok: false, report: M.TEST_NOT_CHOSEN(offered) };

  const started = Date.now();
  let reply: string;
  try {
    reply = await provider.complete(QUESTION, { modelId: model.id });
  } catch (e) {
    return { ok: false, report: M.TEST_REQUEST_FAILED(model.name, e instanceof Error ? e.message : String(e)) };
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
