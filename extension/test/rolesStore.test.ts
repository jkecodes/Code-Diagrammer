import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { loadRoles, saveRoles } from "../src/llm/rolesStore";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cd-roles-store-"));

test("save then load round-trips; a missing file is empty", () => {
  const root = tmp();
  expect(loadRoles(root)).toEqual({});
  const roles = { Enc: { role: "encoder", shape: "trapezoid-narrow", color: "blue" } as const };
  saveRoles(root, roles);
  expect(loadRoles(root)).toEqual(roles);
  expect(fs.existsSync(path.join(root, ".code-diagrammer", "roles.json"))).toBe(true);
});

test("entries with an unknown shape or colour, and malformed files, are not used", () => {
  const root = tmp();
  const file = path.join(root, ".code-diagrammer", "roles.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    A: { role: "x", shape: "star", color: "blue" }, B: { shape: "rect", color: "none", role: 3 }, C: "encoder", D: null,
  }));
  expect(loadRoles(root)).toEqual({ B: { shape: "rect", color: "none" } });
  fs.writeFileSync(file, "{ not json");
  expect(loadRoles(root)).toEqual({});
  fs.writeFileSync(file, "[1]");
  expect(loadRoles(root)).toEqual({});
});
