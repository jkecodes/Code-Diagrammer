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

test("the paper view command is declared", () => {
  const commands = manifest.contributes.commands.map((c: { command: string }) => c.command);
  expect(commands).toContain("codeDiagrammer.togglePaperView");

});

test("the project command is contributed and the stages command is renamed", () => {
  const titles = Object.fromEntries(
    manifest.contributes.commands.map((c: { command: string; title: string }) => [c.command, c.title]));
  expect(titles["codeDiagrammer.openProject"]).toBe("Code Diagrammer: Open Project Architecture");
  expect(titles["codeDiagrammer.togglePaperView"]).toBe("Code Diagrammer: Toggle Stages View");
  expect(titles["codeDiagrammer.testModel"]).toBe("Code Diagrammer: Test Language Model");
  expect(manifest.version).toBe("0.4.0");
});

test("the Gemini key commands are contributed, and no setting can hold the key", () => {
  const titles = Object.fromEntries(
    manifest.contributes.commands.map((c: { command: string; title: string }) => [c.command, c.title]));
  expect(titles["codeDiagrammer.setGeminiKey"]).toBe("Code Diagrammer: Set Gemini API Key");
  expect(titles["codeDiagrammer.clearGeminiKey"]).toBe("Code Diagrammer: Clear Gemini API Key");
  const settings = Object.keys(manifest.contributes.configuration.properties);
  expect(settings.filter((s) => /key/i.test(s))).toEqual([]); // the key lives in the IDE's secret storage
});
