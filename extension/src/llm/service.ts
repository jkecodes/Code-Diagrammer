// Model choice, consent and the on-disk cache around an LlmProvider.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { LlmError, type LlmModel, type LlmProvider } from "./provider";

export interface LlmHost {
  /** The user's saved choice, "" if none. */
  preferredModelId(): string;
  /** Shows the picker and persists the choice. */
  pickModel(models: LlmModel[]): Promise<LlmModel | undefined>;
  hasConsent(): boolean;
  /** Must persist a "yes" itself. */
  askConsent(modelName: string): Promise<boolean>;
}

export type AskOptions = { kind: string; regenerate?: boolean; signal?: AbortSignal };
export type Answer = { text: string; model: LlmModel; cached: boolean };

export class LlmService {
  constructor(
    private readonly provider: LlmProvider,
    private readonly host: LlmHost,
    private readonly cacheDir: string,
  ) {}

  /** Throws LlmError. The model is always the user's choice, never a silent default. */
  async ask(prompt: string, opts: AskOptions): Promise<Answer> {
    const models = await this.provider.listModels();
    if (models.length === 0) throw new LlmError("no-model", "No language model available");
    const preferred = this.host.preferredModelId();
    const model = models.find((m) => m.id === preferred) ?? (await this.host.pickModel(models));
    if (!model) throw new LlmError("cancelled", "No language model was chosen");
    if (!this.host.hasConsent() && !(await this.host.askConsent(model.name))) {
      throw new LlmError("consent-declined", "Sending code to the language model was declined");
    }
    const file = this.cacheFile(opts.kind, model.id, prompt);
    if (!opts.regenerate) {
      const hit = this.read(file);
      if (hit !== undefined) return { text: hit, model, cached: true };
    }
    if (opts.signal?.aborted) throw new LlmError("cancelled", "Cancelled");
    let text: string;
    try {
      text = await this.provider.complete(prompt, { modelId: model.id, signal: opts.signal });
    } catch (e) {
      if (e instanceof LlmError) throw e;
      throw new LlmError("provider", e instanceof Error ? e.message : String(e));
    }
    if (opts.signal?.aborted) throw new LlmError("cancelled", "Cancelled");
    this.write(file, text);
    return { text, model, cached: false };
  }

  /** Cache lookup only: never calls the provider, never shows UI. */
  async cached(prompt: string, kind: string): Promise<Answer | undefined> {
    const preferred = this.host.preferredModelId();
    if (!preferred) return undefined;
    let models: LlmModel[];
    try {
      models = await this.provider.listModels();
    } catch {
      return undefined;
    }
    const model = models.find((m) => m.id === preferred);
    if (!model) return undefined;
    const hit = this.read(this.cacheFile(kind, model.id, prompt));
    return hit === undefined ? undefined : { text: hit, model, cached: true };
  }

  private cacheFile(kind: string, modelId: string, prompt: string): string {
    const key = createHash("sha256").update(`${kind}\n${modelId}\n${prompt}`).digest("hex");
    return path.join(this.cacheDir, `${key}.json`);
  }

  private read(file: string): string | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return typeof parsed?.text === "string" ? parsed.text : undefined;
    } catch {
      return undefined; // missing or corrupt: a miss
    }
  }

  private write(file: string, text: string): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ text }), "utf8");
      fs.renameSync(tmp, file);
    } catch {
      // a read-only workspace only loses the cache
    }
  }
}

/** The first balanced JSON object in a model's reply (prose and code fences around it are ignored). */
export function extractJson(text: string): unknown {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break; // not JSON after all: try the next "{"
        }
      }
    }
  }
  throw new LlmError("invalid-output", "The language model did not return JSON");
}
