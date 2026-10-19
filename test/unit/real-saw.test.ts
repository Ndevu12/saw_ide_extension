import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultIsExecutableFile, locate, probe } from "../../src/core/locate";
import { scanFolder } from "../../src/core/scan";
import { DISGUISED_TASK, tempDir } from "./helpers";

// The contract with the real saw: skipped where it is not installed, required in CI.
const located = locate(process.env["SAW_BIN"] ?? "", {
  platform: process.platform,
  homedir: homedir(),
  pathVariable: process.env["PATH"],
  isExecutableFile: defaultIsExecutableFile,
});
const binary = located.kind === "found" ? (located.candidates[0]?.binary ?? "") : "";
const required = process.env["SAW_CONTRACT_REQUIRED"] === "1";

describe.skipIf(!binary && !required)("the installed saw", () => {
  it("is found and new enough", async () => {
    expect(located.kind).toBe("found");
    expect((await probe(binary)).kind).toBe("ready");
  });

  it("confirms a task that runs a disguised payload when the folder opens", async () => {
    const folder = tempDir();
    mkdirSync(path.join(folder, ".vscode"));
    writeFileSync(path.join(folder, ".vscode", "tasks.json"), DISGUISED_TASK);
    const outcome = await scanFolder({ binary, folder, configPath: "", timeoutMs: 60_000 });
    expect(outcome).toMatchObject({ kind: "scanned", verdict: "infected" });
    const findings = outcome.kind === "scanned" ? outcome.payload.results.flatMap((r) => r.findings) : [];
    expect(findings).toContainEqual(expect.objectContaining({
      signatureId: "vscode-task-runs-font",
      path: ".vscode/tasks.json",
      confidence: "confirmed",
    }));
  }, 90_000);

  it("reads a folder with nothing in it as clean", async () => {
    const folder = tempDir();
    writeFileSync(path.join(folder, "index.js"), "console.log('hello');\n");
    const outcome = await scanFolder({ binary, folder, configPath: "", timeoutMs: 60_000 });
    expect(outcome).toMatchObject({ kind: "scanned", verdict: "clean" });
  }, 90_000);

  it("never reads a folder that does not exist as clean", async () => {
    const outcome = await scanFolder({ binary, folder: path.join(tempDir(), "gone"), configPath: "", timeoutMs: 60_000 });
    expect(outcome.kind === "cancelled" ? "cancelled" : outcome.verdict).toBe("incomplete");
  }, 90_000);
});
