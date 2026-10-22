import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { auditArgs, auditVerdict, canFix, fixArgs, gitIdentity, hookArgs, readAudit, readFix, readHookJson, readHookStatus, rotationSentence } from "../../src/core/actions";
import { NO_CAPABILITIES, readCapabilities } from "../../src/core/capabilities";
import { runProgram } from "../../src/core/run";
import { lines } from "../../src/core/text";
import { fakeSaw, onWindows, tempDir } from "./helpers";

const fixReport = (remediation: string, cause = "", more: Record<string, unknown> = {}) =>
  JSON.stringify({ results: [{ repository: "/work/repo", remediation, cause, pull_request: null, url: "", ...more }] });

const sawWith = (...features: string[]) => readCapabilities(JSON.stringify({ features }), 0);

describe("saw fix", () => {
  it("is run only by a saw that reports what it did", () => {
    expect(canFix("0.13.0", NO_CAPABILITIES)).toBe(true);
    expect(canFix("1.0.0", NO_CAPABILITIES)).toBe(true);
    expect(canFix("0.12.3", NO_CAPABILITIES)).toBe(false);
    expect(canFix("dev", NO_CAPABILITIES)).toBe(false);
    expect(canFix("dev", sawWith("fix.json"))).toBe(true);
  });

  it("never publishes: no --pr, and the report as JSON", () => {
    expect(fixArgs("/work/repo", "")).toEqual(["fix", "/work/repo", "--json", "--no-stream"]);
    expect(fixArgs("/work/repo", "/home/me/saw.yml")).toContain("/home/me/saw.yml");
  });

  it("reads a prepared clean-up, and whether part of it is left for the operator", () => {
    expect(readFix(fixReport("prepared"), 0)).toEqual({ kind: "prepared", needsReview: false });
    expect(readFix(fixReport("prepared"), 2)).toEqual({ kind: "prepared", needsReview: true });
  });

  it("reads where the clean-up is and what became of uncommitted work, from a saw that says", () => {
    const outcome = readFix(
      fixReport("prepared", "", {
        partial: false,
        branch: "security/auto-clean-main",
        base: "main",
        removed: [".vscode/tasks.json", 42],
        uncommitted: { branch: "saw/wip-main", files: 3, withheld: 1, unsaved: 0, unread: 0, reason: "" },
        history_holds_payload: false,
        needs_review: [],
      }),
      0,
    );
    expect(outcome).toEqual({
      kind: "prepared",
      needsReview: false,
      details: {
        partial: false,
        branch: "security/auto-clean-main",
        base: "main",
        removed: [".vscode/tasks.json"],
        uncommitted: { branch: "saw/wip-main", files: 3, withheld: 1, unsaved: 0, unread: 0, reason: "" },
        historyHoldsPayload: false,
        needsReview: [],
      },
    });
  });

  it("needs the operator when saw cleaned only part, history still holds the payload, or it lists items", () => {
    expect(readFix(fixReport("prepared", "", { partial: true }), 0)).toMatchObject({ needsReview: true });
    expect(readFix(fixReport("prepared", "", { history_holds_payload: true }), 0)).toMatchObject({ needsReview: true });
    expect(readFix(fixReport("prepared", "", { needs_review: ["package.json postinstall"] }), 0)).toMatchObject({ needsReview: true });
  });

  it("refuses a fix report newer than it reads", () => {
    expect(readFix(JSON.stringify({ schema_version: 2, results: [{ remediation: "prepared" }] }), 0)).toMatchObject({ kind: "failed", cause: expect.stringMatching(/update the extension/) });
    expect(readFix(JSON.stringify({ schema_version: 99, results: [] }), 0)).toMatchObject({ kind: "failed", cause: expect.stringMatching(/update the extension/) });
  });

  it("reads nothing to fix as nothing changed", () => {
    expect(readFix(fixReport("skipped"), 0)).toEqual({ kind: "skipped" });
  });

  it("passes saw's cause on when it could not clean", () => {
    expect(readFix(fixReport("failed", "dirty-worktree"), 2)).toEqual({ kind: "failed", cause: "dirty-worktree" });
  });

  it("treats a missing or unknown report as a failure, never as cleaned", () => {
    expect(readFix("", 2).kind).toBe("failed");
    expect(readFix("{}", 0).kind).toBe("failed");
    expect(readFix(fixReport("rewritten"), 0).kind).toBe("failed");
    expect(readFix(JSON.stringify({ results: [] }), 0).kind).toBe("failed");
  });

  it("refuses a published fix, which this extension never asks for", () => {
    expect(readFix(fixReport("pr"), 0).kind).toBe("failed");
  });
});

describe("who git says commits in a folder", () => {
  const unknownIdentity = "Committer identity unknown\n\n*** Please tell me who you are.\n\nfatal: empty ident name (for <me@host.(none)>) not allowed\n";

  it.skipIf(onWindows)("is missing when git cannot name an author, as on a machine with no git identity", async () => {
    expect(await gitIdentity("/work/repo", fakeSaw({ stderr: unknownIdentity, exit: 128 }))).toBe("missing");
  });

  it.skipIf(onWindows)("is known when git names one, and asks without a shell", async () => {
    const argsFile = path.join(tempDir(), "args.json");
    expect(await gitIdentity("/work/a b; touch x", fakeSaw({ stdout: "Me <me@example.com> 1 +0000\n", argsFile }))).toBe("known");
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual(["-C", "/work/a b; touch x", "var", "GIT_COMMITTER_IDENT"]);
  });

  it.skipIf(onWindows)("is unknown, not missing, when git fails for another reason or is not there", async () => {
    expect(await gitIdentity("/work/repo", fakeSaw({ stderr: "fatal: not a git repository\n", exit: 128 }))).toBe("unknown");
    expect(await gitIdentity("/work/repo", path.join(tempDir(), "no-git"))).toBe("unknown");
  });

  it("reads an identity set only in the repository, as saw's commit does", async () => {
    const repo = tempDir();
    const git = (...args: string[]) => execFileSync("git", ["-c", "init.templateDir=", ...args], { cwd: repo });
    git("init", "-q");
    git("config", "user.name", "Repo Only");
    git("config", "user.email", "repo@example.com");
    expect(await gitIdentity(repo)).toBe("known");
  });
});

describe("saw audit", () => {
  it("maps how the audit ended", () => {
    expect(auditVerdict(0)).toBe("no-hazard");
    expect(auditVerdict(3)).toBe("rotation-unsafe");
    expect(auditVerdict(2)).toBe("incomplete");
    expect(auditVerdict(1)).toBe("failed");
    expect(auditVerdict(null)).toBe("failed");
  });

  it("repeats saw's own rotation-safety sentence", () => {
    const report = "\nCRITICAL\n  ✓ Rotation safety: safe once you confirm the item(s) below are yours.\nmore\n";
    expect(rotationSentence(report)).toBe("Rotation safety: safe once you confirm the item(s) below are yours.");
    expect(rotationSentence("no verdict here")).toBeUndefined();
  });
});

describe("saw audit --json", () => {
  const audit = (verdict: string, more: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema_version: 1,
      rotation: { verdict, sentence: "safe once you confirm the item(s) below are yours.", to_confirm: ["ssh-agent"] },
      findings: [{ id: "ssh-agent", severity: "medium", title: "ssh-agent holds keys", detail: "", fix: "ssh-add -D", confidence: "heuristic", command: "saw audit --verify", process: { pid: 42, exe: "/usr/bin/ssh-agent" } }],
      incomplete: [{ probe: "browser-extensions", reason: "permission denied", title: "A location was not read", fix: "Read it by hand" }],
      scope_notes: ["user processes only"],
      ...more,
    });

  it("is asked for only from a saw that has it", () => {
    expect(auditArgs(NO_CAPABILITIES)).toEqual(["audit", "--no-stream"]);
    expect(auditArgs(sawWith("audit.json"))).toEqual(["audit", "--json", "--no-stream"]);
  });

  it("reads the verdict, saw's sentence and what it found", () => {
    const result = readAudit(audit("safe-once-confirmed"), "", 0, true);
    expect(result.verdict).toBe("to-confirm");
    expect(result.sentence).toBe("Rotation safety: safe once you confirm the item(s) below are yours.");
    expect(result.details).toEqual({
      toConfirm: ["ssh-agent"],
      findings: [{ id: "ssh-agent", severity: "medium", title: "ssh-agent holds keys", detail: "", fix: "ssh-add -D", confidence: "heuristic", command: "saw audit --verify", process: { pid: 42, exe: "/usr/bin/ssh-agent" } }],
      incomplete: [{ probe: "browser-extensions", reason: "permission denied", title: "A location was not read", fix: "Read it by hand" }],
      scopeNotes: ["user processes only"],
    });
  });

  it("takes the more alarming of the JSON and the exit status", () => {
    expect(readAudit(audit("safe"), "", 3, true).verdict).toBe("rotation-unsafe");
    expect(readAudit(audit("unsafe"), "", 0, true).verdict).toBe("rotation-unsafe");
    expect(readAudit(audit("safe"), "", 2, true).verdict).toBe("incomplete");
  });

  it("falls back to the exit status and saw's text when the JSON is missing, unknown or newer", () => {
    const text = "  ✓ Rotation safety: safe — nothing found.\n";
    expect(readAudit(text, "", 0, false)).toEqual({ verdict: "no-hazard", sentence: "Rotation safety: safe — nothing found.", details: undefined });
    expect(readAudit("", text, 3, true)).toEqual({ verdict: "rotation-unsafe", sentence: "Rotation safety: safe — nothing found.", details: undefined });
    expect(readAudit(audit("maybe"), "", 0, true).details).toBeUndefined();
    expect(readAudit(audit("safe", { schema_version: 2 }), "", 0, true).details).toBeUndefined();
  });
});

describe("saw hook status --json", () => {
  const status = (more: Record<string, unknown>) => JSON.stringify({ schema_version: 1, installed: true, events: ["post-checkout"], via: "core.hooksPath", disabled_by_env: false, problems: [], ...more });

  it("is asked for only from a saw that has it", () => {
    expect(hookArgs("status", NO_CAPABILITIES)).toEqual(["hook", "status", "--no-stream"]);
    expect(hookArgs("repair", sawWith("hook.status.json"))).toEqual(["hook", "repair", "--json", "--no-stream"]);
  });

  it("reads the hooks, and each problem with what repairs it", () => {
    expect(readHookJson(status({}), "", 0)).toEqual({ kind: "installed", events: ["post-checkout"], problems: [] });
    const problems = readHookJson(status({ disabled_by_env: true, problems: [{ code: "drift", message: "2 files differ", repair: "saw hook repair" }] }), "", 0);
    expect(problems).toEqual({ kind: "installed", events: ["post-checkout"], problems: ["SAW_HOOK_DISABLED is set, so the hooks do nothing.", "2 files differ (saw hook repair)"] });
    expect(readHookJson(status({ installed: false }), "", 0)).toEqual({ kind: "not-installed" });
  });

  it("reads an older saw's text, and calls an unknown or newer document unknown", () => {
    expect(readHookJson("scan-on-clone: not installed\n", "", 0)).toEqual({ kind: "not-installed" });
    expect(readHookJson(status({ installed: "yes" }), "", 0).kind).toBe("unknown");
    expect(readHookJson(status({ schema_version: 2 }), "", 0).kind).toBe("unknown");
  });
});

describe("saw hook status", () => {
  it("reads hooks that are in place", () => {
    const out = "scan-on-clone: INSTALLED (post-checkout, post-merge, post-rewrite, pre-push)\n  saw's scan is also set in your git settings.\n";
    expect(readHookStatus(out, 0)).toEqual({ kind: "installed", events: ["post-checkout", "post-merge", "post-rewrite", "pre-push"], problems: [] });
  });

  it("collects what would stop them", () => {
    const out = [
      "scan-on-clone: INSTALLED (post-checkout)",
      "  ⚠ 2 file(s) are not what saw installs, where saw's hooks run — see `saw audit`; put them back with `saw hook repair`.",
      "  SAW_HOOK_DISABLED is set — the hook is currently a no-op.",
    ].join("\n");
    const status = readHookStatus(out, 0);
    expect(status.kind === "installed" && status.problems).toHaveLength(2);
  });

  it("reads hooks that are not installed", () => {
    expect(readHookStatus("scan-on-clone: not installed  ·  enable with `saw hook install`\n", 0)).toEqual({ kind: "not-installed" });
  });

  it("calls anything else unknown, never installed", () => {
    expect(readHookStatus("Traceback (most recent call last):\n  boom\n", 1).kind).toBe("unknown");
    expect(readHookStatus("scan-on-clone: INSTALLED (post-checkout)\n", 2).kind).toBe("unknown");
    expect(readHookStatus("scan-on-clone: PARTIAL\n", 0).kind).toBe("unknown");
  });
});

describe("saw's own report, as a report shows it", () => {
  it("keeps lines, drops colour and replaces every other control character", () => {
    expect(lines("a\nb\r\n\u001b[31mred\u001b[0m \u001b]0;pwned\u0007c\u202e\n\n")).toBe("a\nb\nred \uFFFD]0;pwned\uFFFDc\uFFFD");
  });

  it("is bounded", () => {
    expect(lines("x".repeat(12), 10)).toBe("xxxxxxxxxx\n… (2 more characters not shown)");
  });

  it.skipIf(onWindows)("hands over output as it comes, without splitting a character", async () => {
    const seen: string[] = [];
    const saw = fakeSaw({ stderr: "→ ✓ done\n" });
    await runProgram(saw, [], { timeoutMs: 10_000, onOutput: (text, stream) => seen.push(`${stream}:${text}`) });
    expect(seen.join("")).toBe("stderr:→ ✓ done\n");
  });
});
