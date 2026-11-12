// Several model sources (the IDE's own models, Gemini with the user's key) behind one LlmProvider.
import { LlmError, type LlmModel, type LlmProvider } from "./provider";

export class CombinedProvider implements LlmProvider {
  constructor(private readonly sources: LlmProvider[]) {}

  /**
   * Every source's models, in order. A source that fails does not hide the others; when nothing at
   * all is offered, its failure is the reason and is thrown.
   */
  async listModels(): Promise<LlmModel[]> {
    return (await this.listed()).flatMap((s) => s.models);
  }

  async complete(prompt: string, opts: { modelId: string; signal?: AbortSignal }): Promise<string> {
    const owner = (await this.listed()).find((s) => s.models.some((m) => m.id === opts.modelId));
    if (!owner) throw new LlmError("provider", `The model ${opts.modelId} is no longer available`);
    return owner.source.complete(prompt, opts);
  }

  private async listed(): Promise<{ source: LlmProvider; models: LlmModel[] }[]> {
    const out: { source: LlmProvider; models: LlmModel[] }[] = [];
    let failure: unknown;
    for (const source of this.sources) {
      try {
        out.push({ source, models: await source.listModels() });
      } catch (e) {
        failure ??= e;
      }
    }
    if (failure !== undefined && out.every((s) => s.models.length === 0)) {
      throw failure instanceof LlmError
        ? failure
        : new LlmError("provider", failure instanceof Error ? failure.message : String(failure));
    }
    return out;
  }
}
