// "Which classes are this project's main models?" — asked of a language model, validated here.
import * as path from "node:path";
import type { ScannedClass } from "../ir";
import * as M from "../messages";
import { LlmError } from "./provider";
import { extractJson, type LlmService } from "./service";

export type ProjectModel = { name: string; file: string; line: number; summary: string };

const MAX_SENT = 60;
const MAX_SUMMARY = 200;

function relative(file: string, root: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function fileKey(relativePath: string): string {
  return relativePath.split("\\").join("/").replace(/^\.\//, "").toLowerCase();
}

export function projectPrompt(candidates: ScannedClass[], root: string): string {
  const lines = candidates.filter((c) => c.candidate).map((c) => {
    const parts = [`${relative(c.file, root)}::${c.name}(${c.forwardParams.join(", ")})`];
    if (c.docstring) parts.push(c.docstring);
    if (c.submoduleTypes.length > 0) parts.push(`uses: ${c.submoduleTypes.join(", ")}`);
    return `- ${parts.join(" — ")}`;
  });
  return [
    "These PyTorch nn.Module classes of one project are not used as a submodule of any other class.",
    "Pick the project's main models (the networks a reader should look at first), most important first, at most 12.",
    "Skip test doubles, toy examples and thin wrappers when better candidates exist.",
    "",
    ...lines,
    "",
    'Answer with JSON only: {"models": [{"name": "ClassName", "file": "relative/path.py", "summary": "one sentence on what the model does"}]}',
    "Use only names and files from the list above.",
  ].join("\n");
}

/** Throws LlmError("invalid-output") when the reply has no usable `models` array. */
export function parseProjectModels(text: string, candidates: ScannedClass[], root: string): ProjectModel[] {
  const raw = extractJson(text) as { models?: unknown };
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.models)) {
    throw new LlmError("invalid-output", "The language model did not return a list of models");
  }
  const known = new Map<string, ScannedClass>();
  for (const c of candidates) known.set(`${fileKey(relative(c.file, root))}::${c.name}`, c);
  const out: ProjectModel[] = [];
  const seen = new Set<ScannedClass>();
  for (const entry of raw.models) {
    if (!entry || typeof entry !== "object") continue;
    const { name, file, summary } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof file !== "string") continue;
    const match = known.get(`${fileKey(file)}::${name}`);
    if (!match || seen.has(match)) continue;
    seen.add(match);
    const oneLine = (typeof summary === "string" ? summary : "").split(/\s+/).join(" ").trim();
    out.push({ name: match.name, file: match.file, line: match.line, summary: oneLine.slice(0, MAX_SUMMARY) });
  }
  return out;
}

const plain = (c: ScannedClass): ProjectModel => ({ name: c.name, file: c.file, line: c.line, summary: "" });

/** Never fails for lack of a model: the candidates are then listed without summaries, with a note. */
export async function projectModels(
  classes: ScannedClass[], root: string, llm: LlmService, opts: { regenerate?: boolean } = {},
): Promise<{ models: ProjectModel[]; note?: string }> {
  const candidates = classes.filter((c) => c.candidate);
  if (candidates.length === 0) return { models: [] };
  const sent = candidates.slice(0, MAX_SENT);
  const rest = candidates.slice(MAX_SENT).map(plain);
  let note: string;
  try {
    const answer = await llm.ask(projectPrompt(sent, root), { kind: "project-models", regenerate: opts.regenerate });
    const picked = parseProjectModels(answer.text, sent, root);
    if (picked.length > 0) return { models: [...picked, ...rest] };
    note = M.LLM_INVALID_OUTPUT;
  } catch (e) {
    if (!(e instanceof LlmError) || e.kind === "consent-declined" || e.kind === "cancelled") throw e;
    note = e.kind === "no-model" ? M.NO_LANGUAGE_MODEL
      : e.kind === "invalid-output" ? M.LLM_INVALID_OUTPUT : M.LLM_FAILED(e.message);
  }
  return { models: [...sent.map(plain), ...rest], note };
}
