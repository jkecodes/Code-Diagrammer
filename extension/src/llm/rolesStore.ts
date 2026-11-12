// The class roles the last project view obtained, kept in the workspace so that single-model
// diagrams can use them without asking the language model again.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Color, Look, Shape } from "../ir";
import { COLORS, type RoleMap, SHAPES } from "../look";

function rolesPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".code-diagrammer", "roles.json");
}

/** Missing, malformed or hand-edited into something else: those entries are simply not used. */
export function loadRoles(workspaceRoot: string): RoleMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(rolesPath(workspaceRoot), "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out = new Map<string, Look>();
  for (const [name, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object") continue;
    const { role, shape, color } = value as Record<string, unknown>;
    if (!(SHAPES as readonly unknown[]).includes(shape) || !(COLORS as readonly unknown[]).includes(color)) continue;
    const look: Look = { shape: shape as Shape, color: color as Color };
    if (typeof role === "string" && role) look.role = role;
    out.set(name, look);
  }
  return Object.fromEntries(out);
}

export function saveRoles(workspaceRoot: string, roles: RoleMap): void {
  const file = rolesPath(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(roles, null, 2) + "\n", "utf8");
}
