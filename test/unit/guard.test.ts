import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import * as esbuild from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

import { decide, folderOf, GUARDED_COMMAND, hooksJson, isGuarded, recordName, shellQuote, type GuardRecord } from "../../src/core/agent/guard";

const record = (verdict: GuardRecord["verdict"], updatedAt = 1): GuardRecord => ({
  path: "/work/web",
  name: "web",
  verdict,
  report: `saw verdict: ${verdict ?? "unknown"}`,
  updatedAt,
});

describe("which commands the agent guard checks", () => {
  it("commands that install or run a project's code", () => {
    for (const command of [
      "npm install",
      "npm ci",
      "pnpm i",
      "yarn",
      "npx vite build",
      "cd web && npm run build",
      "NODE_ENV=production node server.js",
      "sudo make install",
      "python3 -m pytest",
      "pip install -r requirements.txt",
      "cargo build",
      "./gradlew test",
      "../scripts/setup.sh",
      "bash scripts/install.sh",
      "/usr/local/bin/npm test",
      "git checkout main",
      "git -c core.hooksPath=x commit -m wip",
      "ls; go run .",
      "(yarn build)",
    ]) {
      expect(isGuarded(command), command).toBe(true);
    }
  });

  it("not commands that only read", () => {
    for (const command of ["ls -la", "cat package.json", "git status", "git diff main", "rg npm src", "echo npm install", "which node", "cat ./README.md", "grep -r yarn ."]) {
      expect(isGuarded(command), command).toBe(false);
    }
  });

  it("puts the same pattern in Cursor's hook configuration", () => {
    const config = JSON.parse(hooksJson("run-hook")) as { version: number; hooks: { beforeShellExecution: { command: string; matcher: string }[] } };
    expect(config.version).toBe(1);
    expect(config.hooks.beforeShellExecution).toEqual([{ command: "run-hook", matcher: GUARDED_COMMAND, timeout: 10 }]);
  });
});

describe("the folder a command runs in", () => {
  it("is the innermost workspace root holding its directory", () => {
    expect(folderOf({ cwd: "/work/web/src", workspace_roots: ["/work", "/work/web"] })).toBe("/work/web");
    expect(folderOf({ cwd: "/work/web", workspace_roots: ["/work/web"] })).toBe("/work/web");
    expect(folderOf({ cwd: "/work/webapp", workspace_roots: ["/work/web"] })).toBeUndefined();
    expect(folderOf({ cwd: "/tmp", workspace_roots: ["/work/web"] })).toBeUndefined();
  });

  it("is the only root when Cursor names no directory", () => {
    expect(folderOf({ workspace_roots: ["/work/web"] })).toBe("/work/web");
    expect(folderOf({ workspace_roots: ["/a", "/b"] })).toBeUndefined();
  });
});

describe("the guard's decision", () => {
  const input = { command: "npm install", cwd: "/work/web", workspace_roots: ["/work/web"] };

  it("refuses in an infected folder and tells the agent saw's verdict", () => {
    expect(decide(input, record("infected"))).toEqual({
      permission: "deny",
      user_message: expect.stringContaining("found web infected"),
      agent_message: "saw verdict: infected",
    });
  });

  it("asks the person when saw found something suspicious, could not finish, or has no verdict", () => {
    for (const verdict of ["suspicious", "incomplete", undefined] as const) {
      expect(decide(input, record(verdict)).permission, String(verdict)).toBe("ask");
    }
  });

  it("allows a clean folder, residue, a folder the extension does not watch, and commands it does not check", () => {
    expect(decide(input, record("clean"))).toEqual({ permission: "allow" });
    expect(decide(input, record("residue"))).toEqual({ permission: "allow" });
    expect(decide(input, undefined)).toEqual({ permission: "allow" });
    expect(decide({ ...input, command: "git status" }, record("infected"))).toEqual({ permission: "allow" });
  });
});

describe("the hook program", () => {
  let script: string;
  let store: string;

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "saw-hook-"));
    script = path.join(dir, "cursor-hook.js");
    store = path.join(dir, "verdicts");
    await esbuild.build({ entryPoints: ["src/cursorHook.ts"], bundle: true, platform: "node", format: "cjs", outfile: script, logLevel: "silent" });
    spawnSync("mkdir", [store]);
  });

  const run = (input: unknown, storeDir = store) =>
    JSON.parse(spawnSync(process.execPath, [script, storeDir], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" }).stdout) as { permission: string; agent_message?: string };

  it("answers from the newest window's record for the folder", () => {
    writeFileSync(path.join(store, recordName("/work/web", "older")), JSON.stringify(record("clean", 1)));
    writeFileSync(path.join(store, recordName("/work/web", "newer")), JSON.stringify(record("infected", 2)));
    const answer = run({ command: "npm install", cwd: "/work/web", workspace_roots: ["/work/web"] });
    expect(answer.permission).toBe("deny");
    expect(answer.agent_message).toBe("saw verdict: infected");
  });

  it("asks the person when it cannot read its input or its records", () => {
    expect(run("not json").permission).toBe("ask");
    expect(run({ command: "npm install", cwd: "/work/web", workspace_roots: ["/work/web"] }, path.join(store, "missing")).permission).toBe("ask");
  });

  it("is quoted safely into the shell command Cursor runs", () => {
    expect(shellQuote("/Apps/Cursor's/cursor")).toBe(`'/Apps/Cursor'\\''s/cursor'`);
  });
});
