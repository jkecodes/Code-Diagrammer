// Language models the IDE exposes to extensions (Claude, Gemini, ...) through `vscode.lm`.
import * as vscode from "vscode";
import { LlmError, type LlmModel, type LlmProvider } from "./provider";

export class VsCodeLmProvider implements LlmProvider {
  async listModels(): Promise<LlmModel[]> {
    // older or forked IDEs may not have the API at all
    if (typeof vscode.lm?.selectChatModels !== "function") return [];
    try {
      const models = await vscode.lm.selectChatModels();
      return models.map((m) => ({ id: m.id, name: m.name, vendor: m.vendor }));
    } catch {
      return [];
    }
  }

  async complete(prompt: string, opts: { modelId: string; signal?: AbortSignal }): Promise<string> {
    const source = new vscode.CancellationTokenSource();
    const onAbort = () => source.cancel();
    opts.signal?.addEventListener("abort", onAbort);
    try {
      if (opts.signal?.aborted) throw new LlmError("cancelled", "Cancelled");
      const [model] = await vscode.lm.selectChatModels({ id: opts.modelId });
      if (!model) throw new LlmError("provider", `The model ${opts.modelId} is no longer available`);
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)], {}, source.token);
      let text = "";
      for await (const part of response.text) text += part;
      if (opts.signal?.aborted) throw new LlmError("cancelled", "Cancelled");
      return text;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (opts.signal?.aborted || e instanceof vscode.CancellationError) {
        throw new LlmError("cancelled", "Cancelled");
      }
      throw new LlmError("provider", e instanceof Error ? e.message : String(e));
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      source.dispose();
    }
  }
}
