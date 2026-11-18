import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UNCHECKED_UPDATE, readNotice } from "../../src/core/govern/contract";
import { decisionFromEnv, readAnswer, readUpdateAsk, terminalAnswer } from "../../src/core/govern/decision";
import { folderKey, plan } from "../../src/core/govern/plan";
import { onWindows } from "./helpers";

describe("deciding about an update saw could not check", () => {
  it("reads saw's own setting for deciding ahead, and nothing else", () => {
    expect(decisionFromEnv({ SAW_GOVERN_DECISION: "run-as-typed" })).toBe("run-as-typed");
    expect(decisionFromEnv({ SAW_GOVERN_DECISION: " leave-unchanged " })).toBe("leave-unchanged");
    expect(decisionFromEnv({ SAW_GOVERN_DECISION: "yes" })).toBeUndefined();
    expect(decisionFromEnv({})).toBeUndefined();
  });

  it("runs the command only on an explicit yes", () => {
    expect(terminalAnswer("y")).toBe("run-as-typed");
    expect(terminalAnswer(" YES ")).toBe("run-as-typed");
    expect(terminalAnswer("")).toBe("leave-unchanged");
    expect(terminalAnswer("n")).toBe("leave-unchanged");
    expect(terminalAnswer("yep")).toBe("leave-unchanged");
  });

  it("reads only a well-formed question and answer", () => {
    const ask = { id: "a1-b2", repo: "/work/app", tool: "git", args: ["pull"], reason: "no remote", at: 1 };
    expect(readUpdateAsk(JSON.stringify(ask))).toEqual(ask);
    expect(readUpdateAsk(JSON.stringify({ ...ask, id: "../escape" }))).toBeUndefined();
    expect(readUpdateAsk(JSON.stringify({ ...ask, args: [1] }))).toBeUndefined();
    expect(readUpdateAsk("not json")).toBeUndefined();
    expect(readAnswer("run-as-typed\n")).toBe("run-as-typed");
    expect(readAnswer("maybe")).toBeUndefined();
  });

  it("holds a fetch only when the installed saw checks one", () => {
    const config = { enabled: true, saw: "/bin/saw", realGit: "/usr/bin/git", realGh: "", timeoutMs: 1000, folders: ["/work/app"], holdingRoot: "/h", markerDir: "/m", resultDir: "/r", progress: false };
    expect(plan(config, "git", ["fetch"], "/work/app").kind).toBe("passthrough");
    expect(plan({ ...config, decides: true }, "git", ["fetch"], "/work/app").kind).toBe("hold");
  });
});

describe.skipIf(onWindows)("the stand-in, when saw leaves the decision to the operator", () => {
  let root: string;
  let shim: string;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "saw-decide-")));
    shim = path.join(root, "govern-shim.js");
    await build({ entryPoints: [path.resolve(__dirname, "../../src/governShim.ts")], bundle: true, platform: "node", format: "cjs", outfile: shim, logLevel: "silent" });
  }, 30_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function setup(name: string, extra: Record<string, unknown> = {}) {
    const dir = path.join(root, name);
    const repo = path.join(dir, "app");
    mkdirSync(repo, { recursive: true });
    const ran = path.join(dir, "real-git-ran");
    const realGit = path.join(dir, "git");
    writeFileSync(realGit, `#!/bin/sh\necho "$@" > '${ran}'\n`, { mode: 0o755 });
    const saw = path.join(dir, "saw");
    writeFileSync(saw, `#!/bin/sh\necho '{"schema_version":1,"reason":"the repository has no remote to fetch from","decision":{"choices":["run-as-typed","leave-unchanged"],"scan_after":["saw","scan","${repo}"]}}'\nexit 2\n`, { mode: 0o755 });
    const results = path.join(dir, "res");
    const askDir = path.join(dir, "asks");
    const configPath = path.join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ enabled: true, saw, realGit, realGh: "", timeoutMs: 5000, folders: [repo], holdingRoot: path.join(dir, "hold"), markerDir: path.join(dir, "mark"), resultDir: results, progress: false, standinDirs: [], decides: true, ...extra }));
    const notice = () => readNotice(readFileSync(path.join(results, `${folderKey(repo)}.json`), "utf8"));
    return { repo, ran, askDir, configPath, notice };
  }

  it("runs the command as typed when SAW_GOVERN_DECISION says so, and scans after", () => {
    const { repo, ran, configPath, notice } = setup("ahead");
    const run = spawnSync(process.execPath, [shim, "--config", configPath, "--tool", "git", "--", "pull"], { cwd: repo, encoding: "utf8", timeout: 15_000, env: { ...process.env, SAW_GOVERN_DECISION: "run-as-typed" } });
    expect(run.status).toBe(0);
    expect(readFileSync(ran, "utf8").trim()).toBe("pull");
    expect(notice()).toMatchObject({ phase: "finished", reasons: [UNCHECKED_UPDATE, "the repository has no remote to fetch from"] });
  }, 20_000);

  it("leaves the folder unchanged when no one can answer", () => {
    const { repo, ran, configPath } = setup("nobody");
    const run = spawnSync(process.execPath, [shim, "--config", configPath, "--tool", "git", "--", "pull"], { cwd: repo, encoding: "utf8", timeout: 15_000, env: { ...process.env, SAW_GOVERN_DECISION: "" } });
    expect(run.status).toBe(1);
    expect(existsSync(ran)).toBe(false);
    expect(run.stderr).toContain("left the folder unchanged");
  }, 20_000);

  it("asks the editor when no terminal can answer, and does what it answers", async () => {
    for (const answer of ["leave-unchanged", "run-as-typed"] as const) {
      const { repo, ran, askDir, configPath } = setup(`editor-${answer}`, { askDir: path.join(root, `editor-${answer}`, "asks") });
      const child = spawn(process.execPath, [shim, "--config", configPath, "--tool", "git", "--", "pull", "--rebase"], { cwd: repo, env: { ...process.env, SAW_GOVERN_DECISION: "" } });
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      let asked: string | undefined;
      for (let i = 0; i < 100 && !asked; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        asked = existsSync(askDir) ? readdirSync(askDir).find((name) => name.endsWith(".ask.json")) : undefined;
      }
      if (!asked) {
        throw new Error(`the stand-in did not ask the editor (${answer})`);
      }
      const ask = readUpdateAsk(readFileSync(path.join(askDir, asked), "utf8"));
      expect(ask).toMatchObject({ repo, tool: "git", args: ["pull", "--rebase"], reason: "the repository has no remote to fetch from" });
      writeFileSync(path.join(askDir, `${ask?.id ?? ""}.answer`), answer);
      const code = await exited;
      expect(code, answer).toBe(answer === "run-as-typed" ? 0 : 1);
      expect(existsSync(ran), answer).toBe(answer === "run-as-typed");
      expect(readdirSync(askDir), answer).toEqual([]);
    }
  }, 30_000);

  it("holds a reason with no decision when this saw offers decisions, instead of running it unchecked", () => {
    const { repo, ran, configPath } = setup("no-decision");
    writeFileSync(path.join(path.dirname(configPath), "saw"), `#!/bin/sh\necho '{"schema_version":1,"reason":"the check could not finish"}'\nexit 2\n`, { mode: 0o755 });
    const run = spawnSync(process.execPath, [shim, "--config", configPath, "--tool", "git", "--", "pull"], { cwd: repo, encoding: "utf8", timeout: 15_000 });
    expect(run.status).toBe(1);
    expect(existsSync(ran)).toBe(false);
    expect(run.stderr).toContain("saw held this update");
  }, 20_000);
});
