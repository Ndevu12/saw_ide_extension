import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { fixArgs, HOOK_STATUS_ARGS, readFix, readHookStatus } from "../../src/core/actions";
import { defaultIsExecutableFile, locate, probe } from "../../src/core/locate";
import { runProgram } from "../../src/core/run";
import { scanFolder } from "../../src/core/scan";
import { DISGUISED_TASK, onWindows, tempDir } from "./helpers";

// The contract with the real saw: skipped where it is not installed, required in CI. saw does not
// run on Windows (it imports POSIX-only modules), so there it is not tested.
const located = locate(process.env["SAW_BIN"] ?? "", {
  platform: process.platform,
  homedir: homedir(),
  pathVariable: process.env["PATH"],
  isExecutableFile: defaultIsExecutableFile,
});
const binary = located.kind === "found" ? (located.candidates[0]?.binary ?? "") : "";
const required = process.env["SAW_CONTRACT_REQUIRED"] === "1";

describe.skipIf(onWindows || (!binary && !required))("the installed saw", () => {
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

  it("fixes an infected repository on a local branch, keeping what was not committed", async () => {
    const repo = tempDir();
    // No template: this machine's own git hooks stay out of the test repository.
    const git = (...args: string[]) => execFileSync("git", ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    // saw commits the uncommitted work as the operator, so the repository needs an identity.
    git("config", "user.name", "t");
    git("config", "user.email", "t@example.com");
    mkdirSync(path.join(repo, ".vscode"));
    writeFileSync(path.join(repo, ".vscode", "tasks.json"), DISGUISED_TASK);
    writeFileSync(path.join(repo, ".vscode", "a.woff2"), "console.log(1)\n");
    writeFileSync(path.join(repo, "index.js"), "console.log('hello');\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    writeFileSync(path.join(repo, "notes.txt"), "not committed\n");

    const run = await runProgram(binary, fixArgs(repo, ""), { timeoutMs: 120_000 });
    expect(readFix(run.stdout, run.exitCode)).toMatchObject({ kind: "prepared" });
    expect(existsSync(path.join(repo, ".vscode", "tasks.json"))).toBe(false);
    const branches = git("branch", "--format=%(refname:short)");
    expect(branches).toMatch(/^security\/auto-clean/m);
    expect(branches).toMatch(/^saw\/uncommitted-/m);
  }, 180_000);

  it("answers hook status in a shape this extension reads", async () => {
    const run = await runProgram(binary, HOOK_STATUS_ARGS, { timeoutMs: 30_000 });
    expect(readHookStatus(`${run.stdout}\n${run.stderr}`, run.exitCode).kind).not.toBe("unknown");
  }, 60_000);
});
