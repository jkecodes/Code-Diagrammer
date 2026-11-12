// "What role does each class play?" — asked of a language model once per project, validated here.
import type { Look, ScannedClass } from "../ir";
import { COLORS, MODEL_ROLES, resolveLook, type RoleMap, SHAPES } from "../look";
import { LlmError } from "./provider";
import { extractJson, type LlmService } from "./service";

export const MAX_ROLE_CLASSES = 150;
const KIND = "roles";

/** No file paths: class names, signatures, docstrings and submodule types are enough. */
export function rolesPrompt(classes: ScannedClass[]): string {
  const lines = classes.map((c) => {
    const parts = [`${c.name}(${c.forwardParams.join(", ")})`];
    if (c.docstring) parts.push(c.docstring);
    if (c.submoduleTypes.length > 0) parts.push(`uses: ${c.submoduleTypes.join(", ")}`);
    return `- ${parts.join(" — ")}`;
  });
  return [
    "These are the PyTorch nn.Module classes of one project. An architecture diagram draws each class",
    "with a shape and colour that depend on its role.",
    `Give a class one of these roles when it clearly fits: ${MODEL_ROLES.join(", ")}.`,
    "When none fits but the class has a clear role of its own, invent a short role name (at most 20 characters)",
    `and choose its "shape" (${SHAPES.join(", ")}) and "color" (${COLORS.join(", ")}).`,
    "Use the same invented role for classes that play the same part. Leave out generic building blocks.",
    "",
    ...lines,
    "",
    'Answer with JSON only: {"roles": [{"name": "ClassName", "role": "encoder"}, '
      + '{"name": "OtherClass", "role": "vocoder", "shape": "hexagon", "color": "teal"}]}',
    "Use only class names from the list above.",
  ].join("\n");
}

/** Throws LlmError("invalid-output") when the reply has no `roles` array. */
export function parseRoles(text: string, classes: ScannedClass[]): RoleMap {
  const raw = extractJson(text) as { roles?: unknown } | null;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.roles)) {
    throw new LlmError("invalid-output", "The language model did not return a list of roles");
  }
  const known = new Set(classes.map((c) => c.name));
  const invented = new Map<string, Look>();
  const out = new Map<string, Look>();
  for (const entry of raw.roles) {
    if (!entry || typeof entry !== "object") continue;
    const { name, role, shape, color } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !known.has(name) || out.has(name)) continue;
    const look = resolveLook({
      role: role as string,
      shape: typeof shape === "string" ? shape : undefined,
      color: typeof color === "string" ? color : undefined,
    }, invented);
    if (look) out.set(name, look);
  }
  return Object.fromEntries(out);
}

/** The project's main candidates are sent first, so the cap drops helper classes rather than models. */
export async function classRoles(
  classes: ScannedClass[], llm: LlmService, opts: { regenerate?: boolean; signal?: AbortSignal } = {},
): Promise<RoleMap> {
  if (classes.length === 0) return {};
  const sent = [...classes.filter((c) => c.candidate), ...classes.filter((c) => !c.candidate)]
    .slice(0, MAX_ROLE_CLASSES);
  const answer = await llm.ask(rolesPrompt(sent), { kind: KIND, regenerate: opts.regenerate, signal: opts.signal });
  return parseRoles(answer.text, sent);
}
