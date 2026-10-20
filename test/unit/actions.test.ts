import { describe, expect, it } from "vitest";

import { auditVerdict, canFix, fixArgs, readFix, readHookStatus, rotationSentence } from "../../src/core/actions";
import { runProgram } from "../../src/core/run";
import { forTerminal } from "../../src/core/text";
import { fakeSaw, onWindows } from "./helpers";

const fixReport = (remediation: string, cause = "") =>
  JSON.stringify({ results: [{ repository: "/work/repo", remediation, cause, pull_request: null, url: "" }] });

describe("saw fix", () => {
  it("is run only by a saw that reports what it did", () => {
    expect(canFix("0.13.0")).toBe(true);
    expect(canFix("1.0.0")).toBe(true);
    expect(canFix("0.12.3")).toBe(false);
    expect(canFix("dev")).toBe(false);
  });

  it("never publishes: no --pr, and the report as JSON", () => {
    expect(fixArgs("/work/repo", "")).toEqual(["fix", "/work/repo", "--json", "--no-stream"]);
    expect(fixArgs("/work/repo", "/home/me/saw.yml")).toContain("/home/me/saw.yml");
  });

  it("reads a prepared clean-up, and whether part of it is left for the operator", () => {
    expect(readFix(fixReport("prepared"), 0)).toEqual({ kind: "prepared", needsReview: false });
    expect(readFix(fixReport("prepared"), 2)).toEqual({ kind: "prepared", needsReview: true });
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

describe("terminal output", () => {
  it("keeps lines and drops the escape sequences a terminal would act on", () => {
    expect(forTerminal("a\nb\r\n\u001b]0;pwned\u0007c\u202e")).toBe("a\r\nb\r\n\uFFFD]0;pwned\uFFFDc\uFFFD");
  });

  it.skipIf(onWindows)("hands over output as it comes, without splitting a character", async () => {
    const seen: string[] = [];
    const saw = fakeSaw({ stderr: "→ ✓ done\n" });
    await runProgram(saw, [], { timeoutMs: 10_000, onOutput: (text, stream) => seen.push(`${stream}:${text}`) });
    expect(seen.join("")).toBe("stderr:→ ✓ done\n");
  });
});
