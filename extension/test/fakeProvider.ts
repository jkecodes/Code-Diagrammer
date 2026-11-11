// A scripted language model for tests: replies are consumed in order, the last one repeats.
import { LlmError, type LlmModel, type LlmProvider } from "../src/llm/provider";

export const CLAUDE: LlmModel = { id: "claude-x", name: "Claude X", vendor: "anthropic" };
export const GEMINI: LlmModel = { id: "gemini-y", name: "Gemini Y", vendor: "google" };

export class FakeProvider implements LlmProvider {
  prompts: string[] = [];
  modelIds: string[] = [];
  constructor(private models: LlmModel[], private replies: (string | Error)[]) {}

  async listModels(): Promise<LlmModel[]> {
    return this.models;
  }

  async complete(prompt: string, opts: { modelId: string; signal?: AbortSignal }): Promise<string> {
    if (opts.signal?.aborted) throw new LlmError("cancelled", "Cancelled");
    this.prompts.push(prompt);
    this.modelIds.push(opts.modelId);
    const reply = this.replies.length > 1 ? this.replies.shift()! : this.replies[0];
    if (reply instanceof Error) throw reply;
    return reply;
  }
}
