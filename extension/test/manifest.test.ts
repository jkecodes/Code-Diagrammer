import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "vitest";

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));

test("an untrusted workspace cannot choose the interpreter that gets run", () => {
  expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations)
    .toContain("codeDiagrammer.pythonPath");
});
