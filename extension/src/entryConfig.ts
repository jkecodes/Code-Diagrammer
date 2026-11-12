// Per-file entry settings, stored in <workspace>/.vscode/code-diagrammer.json.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ClassInfo, InputSpec } from "./ir";
import type { StyleOverride } from "./look";

export type EntryConfig = {
  className: string;
  ctorKwargs: Record<string, unknown>;
  inputs: Record<string, InputSpec>;
};

/** Keys other than `entries` (e.g. `styles`) belong to the user and are written back unchanged. */
type ConfigFile = { entries: Record<string, EntryConfig>; [key: string]: unknown };

export function configPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".vscode", "code-diagrammer.json");
}

function key(workspaceRoot: string, file: string): string {
  return path.relative(workspaceRoot, file).split(path.sep).join("/");
}

/** `undefined`: the file exists but is not a JSON object (the user is probably editing it). */
function parse(workspaceRoot: string): ConfigFile | undefined {
  let text: string;
  try {
    text = fs.readFileSync(configPath(workspaceRoot), "utf8");
  } catch {
    return { entries: {} }; // no file yet
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = typeof parsed.entries === "object" && parsed.entries !== null ? parsed.entries : {};
      return { ...parsed, entries };
    }
  } catch {
    // not JSON
  }
  return undefined;
}

function read(workspaceRoot: string): ConfigFile {
  return parse(workspaceRoot) ?? { entries: {} };
}

/** True when the config file exists but cannot be used. It must then not be written. */
export function configMalformed(workspaceRoot: string): boolean {
  return parse(workspaceRoot) === undefined;
}

export function loadEntry(workspaceRoot: string, file: string): EntryConfig | undefined {
  const entry = read(workspaceRoot).entries[key(workspaceRoot, file)];
  if (!entry || typeof entry.className !== "string") return undefined;
  return { className: entry.className, ctorKwargs: entry.ctorKwargs ?? {}, inputs: entry.inputs ?? {} };
}

/**
 * Returns false, writing nothing, when the existing file is malformed: rewriting it would delete
 * the entries and styles the user has in it.
 */
export function saveEntry(workspaceRoot: string, file: string, entry: EntryConfig): boolean {
  const config = parse(workspaceRoot);
  if (!config) return false;
  config.entries[key(workspaceRoot, file)] = entry;
  fs.mkdirSync(path.dirname(configPath(workspaceRoot)), { recursive: true });
  fs.writeFileSync(configPath(workspaceRoot), JSON.stringify(config, null, 2) + "\n", "utf8");
  return true;
}

/** The user's per-class looks ("styles"): class name → role, shape and/or colour. */
export function loadStyles(workspaceRoot: string): Record<string, StyleOverride> {
  const styles = read(workspaceRoot).styles;
  if (!styles || typeof styles !== "object" || Array.isArray(styles)) return {};
  const out: Record<string, StyleOverride> = {};
  for (const [name, value] of Object.entries(styles)) {
    if (value && typeof value === "object" && !Array.isArray(value)) out[name] = value as StyleOverride;
  }
  return out;
}

/** A starting point the user edits: every required forward parameter gets an image-like shape. */
export function templateFor(cls: ClassInfo): EntryConfig {
  const inputs: Record<string, InputSpec> = {};
  for (const p of cls.forwardParams) {
    if (!p.hasDefault) inputs[p.name] = [1, 3, 224, 224];
  }
  return { className: cls.name, ctorKwargs: {}, inputs };
}
