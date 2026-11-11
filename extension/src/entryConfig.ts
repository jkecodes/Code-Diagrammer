// Per-file entry settings, stored in <workspace>/.vscode/code-diagrammer.json.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ClassInfo, InputSpec } from "./ir";

export type EntryConfig = {
  className: string;
  ctorKwargs: Record<string, unknown>;
  inputs: Record<string, InputSpec>;
};

type ConfigFile = { entries: Record<string, EntryConfig> };

export function configPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".vscode", "code-diagrammer.json");
}

function key(workspaceRoot: string, file: string): string {
  return path.relative(workspaceRoot, file).split(path.sep).join("/");
}

function read(workspaceRoot: string): ConfigFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(workspaceRoot), "utf8"));
    if (parsed && typeof parsed.entries === "object" && parsed.entries !== null) {
      return { entries: parsed.entries };
    }
  } catch {
    // missing or malformed: treated as empty
  }
  return { entries: {} };
}

export function loadEntry(workspaceRoot: string, file: string): EntryConfig | undefined {
  const entry = read(workspaceRoot).entries[key(workspaceRoot, file)];
  if (!entry || typeof entry.className !== "string") return undefined;
  return { className: entry.className, ctorKwargs: entry.ctorKwargs ?? {}, inputs: entry.inputs ?? {} };
}

export function saveEntry(workspaceRoot: string, file: string, entry: EntryConfig): void {
  const config = read(workspaceRoot);
  config.entries[key(workspaceRoot, file)] = entry;
  fs.mkdirSync(path.dirname(configPath(workspaceRoot)), { recursive: true });
  fs.writeFileSync(configPath(workspaceRoot), JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** A starting point the user edits: every required forward parameter gets an image-like shape. */
export function templateFor(cls: ClassInfo): EntryConfig {
  const inputs: Record<string, InputSpec> = {};
  for (const p of cls.forwardParams) {
    if (!p.hasDefault) inputs[p.name] = [1, 3, 224, 224];
  }
  return { className: cls.name, ctorKwargs: {}, inputs };
}
