// The language-model boundary. No `vscode` import here: see vscodeLmProvider.ts.

export type LlmModel = { id: string; name: string; vendor: string };

export type LlmErrorKind = "no-model" | "consent-declined" | "cancelled" | "provider" | "invalid-output";

export class LlmError extends Error {
  constructor(readonly kind: LlmErrorKind, message: string) {
    super(message);
    this.name = "LlmError";
  }
}

export interface LlmProvider {
  /** Models the IDE offers right now; empty when it offers none. */
  listModels(): Promise<LlmModel[]>;
  /** Throws LlmError ("provider" or "cancelled"). */
  complete(prompt: string, opts: { modelId: string; signal?: AbortSignal }): Promise<string>;
}
