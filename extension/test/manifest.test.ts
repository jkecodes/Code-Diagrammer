import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "vitest";

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));

test("an untrusted workspace cannot choose the interpreter that gets run", () => {
  expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations)
    .toContain("codeDiagrammer.pythonPath");
});

test("language-model commands and the model setting are declared", () => {
  const commands = manifest.contributes.commands.map((c: { command: string }) => c.command);
  expect(commands).toContain("codeDiagrammer.chooseModel");
  expect(commands).toContain("codeDiagrammer.scanProject");
  expect(manifest.contributes.configuration.properties["codeDiagrammer.llm.model"].default).toBe("");
});
