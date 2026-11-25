import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UNCHECKED_UPDATE, readNotice } from "../../src/core/govern/contract";
import { decisionFromEnv, heldTerminalAnswer, heldTerminalQuestion, readAnswer, readUpdateAsk, terminalAnswer, terminalQuestion, undecidedReason } from "../../src/core/govern/decision";
import { heldFileName, heldNextSteps, LET_IN_UPDATE, readHeldRecord, sawNextSteps } from "../../src/core/govern/held";
import { folderKey, plan } from "../../src/core/govern/plan";
import { finding, onWindows, report, target } from "./helpers";

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

  it("asks about a reason with no decision too, instead of holding the folder for good", () => {
    const { repo, ran, configPath } = setup("no-decision");
    writeFileSync(path.join(path.dirname(configPath), "saw"), `#!/bin/sh\necho '{"schema_version":1,"reason":"the check could not finish"}'\nexit 2\n`, { mode: 0o755 });
    const run = spawnSync(process.execPath, [shim, "--config", configPath, "--tool", "git", "--", "pull"], { cwd: repo, encoding: "utf8", timeout: 15_000, env: { ...process.env, SAW_GOVERN_DECISION: "" } });
    expect(run.status).toBe(1);
    expect(existsSync(ran)).toBe(false);
    expect(run.stderr).toContain("saw cannot check this update: the check could not finish.");
    expect(run.stderr).toContain("left the folder unchanged");
  }, 20_000);

  /** A saw that checked the update and found something in it. */
  function holding(name: string, verdict: "suspicious" | "infected", extra: Record<string, unknown> = {}) {
    const made = setup(name, extra);
    const dir = path.dirname(made.configPath);
    const confirmed = verdict === "infected";
    const answer = { schema_version: 1, scan: JSON.parse(report([target({ verdict, findings: [finding(confirmed ? {} : { confidence: "heuristic", severity: "medium" })] })])) };
    writeFileSync(path.join(dir, "answer.json"), JSON.stringify(answer));
    writeFileSync(path.join(dir, "saw"), `#!/bin/sh\ncat '${path.join(dir, "answer.json")}'\nexit ${confirmed ? 1 : 0}\n`, { mode: 0o755 });
    const record = () => readHeldRecord(readFileSync(path.join(dir, "res", heldFileName(folderKey(made.repo))), "utf8"));
    return { ...made, record };
  }

  it("keeps what saw found in a held update, says what to do, and lets it in when the editor says so", async () => {
    const askDir = path.join(root, "held-editor", "asks");
    const { repo, ran, configPath, notice, record } = holding("held-editor", "suspicious", { askDir });
    const child = spawn(process.execPath, [shim, "--config", configPath, "--tool", "git", "--", "pull"], { cwd: repo, env: { ...process.env, SAW_GOVERN_DECISION: "" } });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    let asked: string | undefined;
    for (let i = 0; i < 100 && !asked; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      asked = existsSync(askDir) ? readdirSync(askDir).find((name) => name.endsWith(".ask.json")) : undefined;
    }
    if (!asked) {
      throw new Error("the stand-in did not ask the editor");
    }
    expect(readUpdateAsk(readFileSync(path.join(askDir, asked), "utf8"))).toMatchObject({ repo, held: "suspicious" });
    expect(notice()).toMatchObject({ phase: "held", verdict: "suspicious" });
    const kept = record();
    expect(kept).toMatchObject({ repo, tool: "git", args: ["pull"], verdict: "suspicious" });
    expect(kept?.scan.results[0]?.findings).toHaveLength(1);
    expect(kept?.nextSteps.join(" ")).toContain("git pull");
    writeFileSync(path.join(askDir, asked.replace(".ask.json", ".answer")), "run-as-typed");
    expect(await exited).toBe(0);
    expect(readFileSync(ran, "utf8").trim()).toBe("pull");
    expect(notice()).toMatchObject({ phase: "finished", reasons: [LET_IN_UPDATE, expect.stringContaining("suspicious")] });
    expect(stderr).toContain("What to do:");
    expect(stderr).toContain("letting it in as you asked");
  }, 30_000);

  /** A saw that checked the update and released it clean, but could not bring it into the folder. */
  function releasedButNotApplied(name: string, extra: Record<string, unknown> = {}, outcome = "not_brought_in") {
    const made = setup(name, { exactApply: true, ...extra });
    const dir = path.dirname(made.configPath);
    writeFileSync(path.join(dir, "prepared.json"), JSON.stringify({ schema_version: 1, state_id: "ab12cd34ef", scan: JSON.parse(report([target()])) }));
    writeFileSync(path.join(dir, "saw"), [
      "#!/bin/sh",
      `if [ "$2" = apply ]; then echo "$@" > '${path.join(dir, "apply-args")}'; echo '{"schema_version":1,"applied":false,"outcome":"${outcome}","reason":"the new objects could not be packed"}'; exit 2; fi`,
      `cat '${path.join(dir, "prepared.json")}'`,
      "",
    ].join("\n"), { mode: 0o755 });
    const marker = path.join(dir, "mark", folderKey(made.repo));
    const applyArgs = () => readFileSync(path.join(dir, "apply-args"), "utf8").trim();
    return { ...made, marker, applyArgs };
  }

  it("asks the operator about a clean update saw could not bring in, instead of reporting it held", async () => {
    for (const answer of ["leave-unchanged", "run-as-typed"] as const) {
      const askDir = path.join(root, `released-${answer}`, "asks");
      const { repo, ran, configPath, notice, marker } = releasedButNotApplied(`released-${answer}`, { askDir });
      const child = spawn(process.execPath, [shim, "--config", configPath, "--tool", "git", "--", "pull"], { cwd: repo, env: { ...process.env, SAW_GOVERN_DECISION: "" } });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      let asked: string | undefined;
      for (let i = 0; i < 100 && !asked; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        asked = existsSync(askDir) ? readdirSync(askDir).find((file) => file.endsWith(".ask.json")) : undefined;
      }
      if (!asked) {
        throw new Error(`the stand-in did not ask the editor (${answer})`);
      }
      const ask = readUpdateAsk(readFileSync(path.join(askDir, asked), "utf8"));
      expect(ask, answer).toMatchObject({ repo, args: ["pull"], reason: "the new objects could not be packed", releasedButNotApplied: "clean" });
      expect(ask?.held, answer).toBeUndefined();
      expect(existsSync(marker), answer).toBe(false);
      expect(stderr, answer).toContain("saw checked this update (clean) but could not bring it into the folder: the new objects could not be packed.");
      writeFileSync(path.join(askDir, `${ask?.id ?? ""}.answer`), answer);
      expect(await exited, answer).toBe(answer === "run-as-typed" ? 0 : 1);
      expect(existsSync(ran), answer).toBe(answer === "run-as-typed");
      expect(notice(), answer).toMatchObject(answer === "run-as-typed"
        ? { phase: "finished", reasons: [UNCHECKED_UPDATE, "the new objects could not be packed"] }
        : { phase: "finished", reasons: [] });
    }
  }, 40_000);

  it("runs a clean update saw could not bring in when SAW_GOVERN_DECISION says so, and leaves it with no one to ask", () => {
    const ahead = releasedButNotApplied("released-ahead");
    const run = spawnSync(process.execPath, [shim, "--config", ahead.configPath, "--tool", "git", "--", "pull"], { cwd: ahead.repo, encoding: "utf8", timeout: 15_000, env: { ...process.env, SAW_GOVERN_DECISION: "run-as-typed" } });
    expect(run.status).toBe(0);
    expect(readFileSync(ahead.ran, "utf8").trim()).toBe("pull");
    expect(ahead.applyArgs()).toContain("--expect ab12cd34ef");
    const nobody = releasedButNotApplied("released-nobody");
    const left = spawnSync(process.execPath, [shim, "--config", nobody.configPath, "--tool", "git", "--", "pull"], { cwd: nobody.repo, encoding: "utf8", timeout: 15_000, env: { ...process.env, SAW_GOVERN_DECISION: "" } });
    expect(left.status).toBe(1);
    expect(existsSync(nobody.ran)).toBe(false);
    expect(left.stderr).toContain("but could not bring it into the folder: the new objects could not be packed.");
    expect(left.stderr).toContain("left the folder unchanged");
    expect(nobody.notice()).toMatchObject({ phase: "finished" });
  }, 30_000);

  it("never runs an update another check replaced, a held one, or one saw is busy with, whatever SAW_GOVERN_DECISION says", () => {
    for (const outcome of ["state_changed", "held", "busy", "nothing_to_apply"]) {
      const made = releasedButNotApplied(`released-${outcome}`, {}, outcome);
      const run = spawnSync(process.execPath, [shim, "--config", made.configPath, "--tool", "git", "--", "pull"], { cwd: made.repo, encoding: "utf8", timeout: 15_000, env: { ...process.env, SAW_GOVERN_DECISION: "run-as-typed" } });
      expect(run.status, outcome).toBe(1);
      expect(existsSync(made.ran), outcome).toBe(false);
      expect(run.stderr, outcome).toContain("saw did not change the folder: the new objects could not be packed.");
      expect(made.notice(), outcome).toMatchObject({ phase: "finished", reasons: [] });
    }
  }, 60_000);

  it("never asks about a failed apply when saw cannot name its outcome", () => {
    const made = releasedButNotApplied("released-older-saw", { exactApply: false });
    const run = spawnSync(process.execPath, [shim, "--config", made.configPath, "--tool", "git", "--", "pull"], { cwd: made.repo, encoding: "utf8", timeout: 15_000, env: { ...process.env, SAW_GOVERN_DECISION: "run-as-typed" } });
    expect(run.status).toBe(1);
    expect(existsSync(made.ran)).toBe(false);
    expect(made.applyArgs()).not.toContain("--expect");
  }, 30_000);

  it("scans the folder when an earlier apply did not finish", () => {
    const made = releasedButNotApplied("released-interrupted", {}, "folder_may_have_changed");
    const run = spawnSync(process.execPath, [shim, "--config", made.configPath, "--tool", "git", "--", "pull"], { cwd: made.repo, encoding: "utf8", timeout: 15_000, env: { ...process.env, SAW_GOVERN_DECISION: "run-as-typed" } });
    expect(run.status).toBe(1);
    expect(existsSync(made.ran)).toBe(false);
    expect(made.notice()).toMatchObject({ phase: "finished", reasons: [UNCHECKED_UPDATE, "the new objects could not be packed"] });
  }, 30_000);

  it("never lets a held update in because of SAW_GOVERN_DECISION", () => {
    const { repo, ran, configPath, notice } = holding("held-ahead", "infected");
    const run = spawnSync(process.execPath, [shim, "--config", configPath, "--tool", "git", "--", "pull"], { cwd: repo, encoding: "utf8", timeout: 15_000, env: { ...process.env, SAW_GOVERN_DECISION: "run-as-typed" } });
    expect(run.status).toBe(1);
    expect(existsSync(ran)).toBe(false);
    expect(notice()).toMatchObject({ phase: "held", verdict: "infected" });
    expect(run.stderr).toContain("saw held this update (infected)");
    expect(run.stderr).toMatch(/• critical: .*\.vscode\/tasks\.json/);
    expect(run.stderr).toContain("Do not bring this update in");
  }, 20_000);
});

describe("letting in an update saw held", () => {
  it("takes the folder's name for an infected update, and a yes for the rest", () => {
    expect(heldTerminalAnswer("y", "infected", "/work/app")).toBe("leave-unchanged");
    expect(heldTerminalAnswer(" app ", "infected", "/work/app")).toBe("run-as-typed");
    expect(heldTerminalAnswer("y", "suspicious", "/work/app")).toBe("run-as-typed");
    expect(heldTerminalAnswer("app", "suspicious", "/work/app")).toBe("leave-unchanged");
    expect(heldTerminalQuestion("infected", "/work/app")).toContain("type the folder name (app)");
  });

  it("uses saw's next steps when it gives them, and its own otherwise", () => {
    expect(sawNextSteps({ next_steps: ["Ask the author.", 3, ""] })).toEqual(["Ask the author."]);
    expect(sawNextSteps({ scan: {} })).toEqual([]);
    expect(heldNextSteps("infected", "git", ["pull"]).join(" ")).toContain("type the folder's name");
    expect(heldNextSteps("suspicious", "git", ["pull"])[0]).toContain("`git pull`");
  });

  it("reads only a well-formed held record", () => {
    const record = { repo: "/work/app", at: 1, tool: "git", args: ["pull"], verdict: "infected", reasons: ["x"], scan: JSON.parse(report([target()])), nextSteps: ["a"] };
    expect(readHeldRecord(JSON.stringify(record))).toMatchObject({ repo: "/work/app", verdict: "infected", nextSteps: ["a"] });
    expect(readHeldRecord(JSON.stringify({ ...record, verdict: "clean" }))).toBeUndefined();
    expect(readHeldRecord(JSON.stringify({ ...record, scan: { nope: 1 } }))).toBeUndefined();
    expect(readUpdateAsk(JSON.stringify({ id: "a", repo: "/r", tool: "git", args: [], reason: "x", at: 1, held: "infected" }))?.held).toBe("infected");
    expect(readUpdateAsk(JSON.stringify({ id: "a", repo: "/r", tool: "git", args: [], reason: "x", at: 1, held: "clean" }))?.held).toBeUndefined();
  });

  it("reads a released update only with a verdict that releases one, and never alongside a held one", () => {
    const ask = { id: "a", repo: "/r", tool: "git", args: [], reason: "x", at: 1 };
    expect(readUpdateAsk(JSON.stringify({ ...ask, releasedButNotApplied: "clean" }))?.releasedButNotApplied).toBe("clean");
    expect(readUpdateAsk(JSON.stringify({ ...ask, releasedButNotApplied: "residue" }))?.releasedButNotApplied).toBe("residue");
    expect(readUpdateAsk(JSON.stringify({ ...ask, releasedButNotApplied: "suspicious" }))?.releasedButNotApplied).toBeUndefined();
    expect(readUpdateAsk(JSON.stringify({ ...ask, held: "suspicious", releasedButNotApplied: "clean" }))).toMatchObject({ held: "suspicious" });
    expect(readUpdateAsk(JSON.stringify({ ...ask, held: "suspicious", releasedButNotApplied: "clean" }))?.releasedButNotApplied).toBeUndefined();
  });

  it("says what saw did, and that running it as typed can bring newer commits", () => {
    expect(terminalQuestion("git", ["pull"], "no remote")).toBe("saw cannot check this update: no remote.\nRun `git pull` as typed anyway? The folder is scanned straight after. [y/N] ");
    const question = terminalQuestion("git", ["pull"], "the new objects could not be packed", "clean");
    expect(question).toContain("saw checked this update (clean) but could not bring it into the folder: the new objects could not be packed.");
    expect(question).toContain("newer than the ones saw checked");
    expect(undecidedReason("x", "clean", "app")).toBe("saw checked this update to app (clean) but could not bring it into the folder: x.");
    expect(undecidedReason("x", undefined, "app")).toBe("saw cannot check this update to app: x.");
  });
});
