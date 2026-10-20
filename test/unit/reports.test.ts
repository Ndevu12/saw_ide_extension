import { describe, expect, it } from "vitest";

import { parsePayload } from "../../src/core/contract";
import { block, inline, prose, webLink } from "../../src/core/markdown";
import { auditReport, fixReport, hooksReport, scanReport, type SettledScan } from "../../src/core/reports";
import { judge } from "../../src/core/verdict";
import { finding, report, target } from "./helpers";

function scanned(results: Record<string, unknown>[], exitCode = 1): SettledScan {
  const payload = parsePayload(report(results));
  return { kind: "scanned", ...judge(payload, exitCode), payload, durationMs: 1234 };
}

const infected = () => scanned([target({ verdict: "infected", findings: [finding(), finding({ confidence: "heuristic", severity: "low", signature_id: "vscode-task-autorun-visible", remediation: "manual", evidence: null })] })]);

const input = (outcome: SettledScan | undefined) => ({
  folderName: "web",
  folderPath: "/work/web",
  scanning: false,
  fixing: false,
  outcome,
  sawVersion: "0.13.0",
});

describe("Markdown from scanned data", () => {
  it("keeps link, image and HTML syntax literal in prose", () => {
    const text = prose("![x](https://attacker.example/p.png) [click](command:x) <img src=x> **bold**");
    expect(text).not.toMatch(/(?<!\\)[[\]()<>*!]/);
    expect(text).toContain("\\!\\[x\\]\\(https\\:\\/\\/attacker");
  });

  it("puts code spans and blocks around values with backticks of their own", () => {
    expect(inline("a`b")).toBe("``a`b``");
    expect(inline("`x`")).toBe("`` `x` ``");
    expect(inline("")).toBe("*(empty)*");
    expect(block("```\nnot closed early\n````")).toBe("`````text\n```\nnot closed early\n````\n`````");
  });

  it("links only to plain https pages", () => {
    expect(webLink("https://osv.dev/vulnerability/GHSA-1")).toBe("[`osv.dev`](https://osv.dev/vulnerability/GHSA-1)");
    expect(webLink("javascript:alert(1)")).toBe("`javascript:alert(1)`");
    expect(webLink("http://plain.example/")).toBe("`http://plain.example/`");
  });
});

describe("the scan report", () => {
  it("leads with the verdict and what to do, then the findings strongest first", () => {
    const text = scanReport(input(infected()), "preview");
    expect(text).toMatch(/^# saw scan: web\n/);
    expect(text).toContain("## Infected\n\nMalicious code is in this folder.");
    expect(text).toContain("- Scanned at `2026-10-19T00:00:00Z` in 1.2 s with saw `0.13.0`");
    expect(text).toContain("- 2 findings: 1 confirmed, 1 to review, 0 residue; 0 dependency advisories");
    expect(text).toContain("Use **Fix…** on the folder");
    expect(text.indexOf("### Confirmed (1)")).toBeLessThan(text.indexOf("### To review by hand (1)"));
    expect(text).toContain("**critical** · `.vscode/tasks.json` · `vscode-task-runs-font`");
    expect(text).toContain("**Fix…** removes this.");
    expect(text).toContain("saw does not remove this itself: deal with it by hand.");
  });

  it("shows evidence in the preview and withholds it from the saved copy", () => {
    expect(scanReport(input(infected()), "preview")).toContain("  ```text\n  node .vscode/a.woff2\n  ```");
    const saved = scanReport(input(infected()), "saved");
    expect(saved).not.toContain("a.woff2");
    expect(saved).toContain("*Evidence withheld from this copy (20 characters).*");
  });

  it("keeps a hostile file name and evidence literal", () => {
    const text = scanReport(input(scanned([target({
      verdict: "infected",
      findings: [finding({ path: "x](https://attacker.example/beacon.png)![", evidence: "```\n<img src=https://attacker.example/2>\n```" })],
    })])), "preview");
    const outsideCode = text.replace(/(`{3,})text\n[\s\S]*?\n\s*\1/g, "").replace(/(`+)[^`][\s\S]*?\1/g, "");
    expect(outsideCode).not.toContain("attacker");
    expect(text).toContain("````text\n  ```\n  <img src=https://attacker.example/2>\n  ```\n  ````");
  });

  it("says why a scan is not verified, and what saw could not read", () => {
    const text = scanReport(input(scanned([target({ error: "2 path(s) unreadable: a, b", notes: ["history not read"] })], 2)), "preview");
    expect(text).toContain("## Not verified");
    expect(text).toContain("## Why it is not verified\n\n- \\/work\\/repo\\: 2 path\\(s\\) unreadable\\: a\\, b");
    expect(text).toContain("### Not read");
    expect(text).toContain("### Coverage notes\n\n- history not read");
  });

  it("says when a scan is running, and when there has been none", () => {
    expect(scanReport({ ...input(undefined), scanning: true }, "preview")).toContain("> **Scanning now.**");
    expect(scanReport({ ...input(infected()), scanning: true }, "preview")).toContain("below is the previous scan");
    expect(scanReport(input(undefined), "preview")).toContain("saw has not scanned this folder in this window yet.");
    expect(scanReport(input(scanned([target()], 0)), "preview")).toContain("*No findings.*");
  });
});

describe("the command reports", () => {
  const run = { startedAt: Date.UTC(2026, 9, 20, 13, 0, 0), finishedAt: Date.UTC(2026, 9, 20, 13, 0, 4), said: "Security fix\n  → prepared 1 change(s) on 'security/auto-clean-main'\n" };

  it("fix: says what saw did, then saw's own report", () => {
    const text = fixReport({ folderName: "web", folderPath: "/work/web", run, outcome: { kind: "prepared", needsReview: true }, sawVersion: "0.13.0" }, "preview");
    expect(text).toContain("## Clean-up prepared");
    expect(text).toContain("Part of it needs you");
    expect(text).toContain("- Started 2026-10-20 13:00:00 UTC, took 4.0 s with saw `0.13.0`");
    expect(text).toContain("## saw's report\n\n```text\nSecurity fix\n  → prepared 1 change(s) on 'security/auto-clean-main'\n```");
    expect(text).toContain("Audit This Machine");
  });

  it("fix: while running, and when stopped or failed", () => {
    expect(fixReport({ folderName: "w", folderPath: "/w", run: { startedAt: 0, said: "" }, outcome: undefined, sawVersion: undefined }, "preview"))
      .toContain("## Fixing now");
    expect(fixReport({ folderName: "w", folderPath: "/w", run: { ...run, stopped: "cancelled" }, outcome: undefined, sawVersion: undefined }, "preview"))
      .toContain("## Stopped\n\n- It was stopped before it finished.");
    expect(fixReport({ folderName: "w", folderPath: "/w", run, outcome: { kind: "failed", cause: "git has no identity" }, sawVersion: undefined }, "preview"))
      .toContain("saw could not fix this folder: git has no identity");
  });

  it("audit: repeats saw's rotation sentence under the verdict", () => {
    const text = auditReport({ run, verdict: "rotation-unsafe", sentence: "Rotation safety: UNSAFE — a watcher is running", sawVersion: "0.13.0" }, "preview");
    expect(text).toContain("## Do not change your passwords or tokens yet");
    expect(text).toContain("> Rotation safety\\: UNSAFE — a watcher is running");
    expect(auditReport({ run: undefined, verdict: undefined, sentence: undefined, sawVersion: undefined }, "preview")).toContain("has not been audited");
  });

  it("fix: where the clean-up is, what it removed, and work it could not save", () => {
    const details = { partial: false, branch: "security/auto-clean-main", base: "main", removed: [".vscode/tasks.json"], uncommitted: { branch: "", files: 0, withheld: 0, unsaved: 0, unread: 0, reason: "no git identity" }, historyHoldsPayload: true, needsReview: ["postinstall in package.json"] };
    const text = fixReport({ folderName: "w", folderPath: "/w", run, outcome: { kind: "prepared", needsReview: true, details }, sawVersion: undefined }, "preview");
    expect(text).toContain("The local branch `security/auto-clean-main` from `main`. To review it: `git diff main...security/auto-clean-main`");
    expect(text).toContain("**git history still holds the malicious code.**");
    expect(text).toContain("**It could not be saved on a branch, and is on disk only.** no git identity");
    expect(text).toContain("## Left for you to decide\n\n- postinstall in package\\.json");
    expect(text).toContain("## Removed\n\n- `.vscode/tasks.json`");
  });

  it("audit: the items to confirm first, then the rest, what was not read and what it covers", () => {
    const finding = (id: string, title: string) => ({ id, severity: "medium", title, detail: "", fix: "", confidence: "heuristic", process: undefined });
    const details = { toConfirm: ["b"], findings: [finding("a", "a cron job"), finding("b", "ssh-agent holds keys")], incomplete: [{ probe: "browsers", reason: "permission denied" }], scopeNotes: ["user processes only"] };
    const text = auditReport({ run, verdict: "to-confirm", sentence: undefined, details, sawVersion: undefined }, "preview");
    expect(text).toContain("## Safe once you confirm the items below");
    expect(text.indexOf("## Confirm these are yours")).toBeLessThan(text.indexOf("## Findings"));
    expect(text).toContain("- **medium** · heuristic · ssh\\-agent holds keys");
    expect(text).toContain("## Not read\n\n- `browsers`: permission denied");
    expect(text).toContain("## What this audit covers\n\n- user processes only");
  });

  it("hooks: the state, what to run, and the last install", () => {
    expect(hooksReport({ status: { kind: "installed", events: ["post-checkout"], problems: [] }, checkedAt: 0, change: undefined, sawVersion: undefined }, "preview"))
      .toContain("## In place");
    const text = hooksReport({ status: { kind: "installed", events: [], problems: ["core.hooksPath points elsewhere"] }, checkedAt: 0, change: { ...run, subcommand: "repair" }, sawVersion: undefined }, "preview");
    expect(text).toContain("## Need repair");
    expect(text).toContain("- core\\.hooksPath points elsewhere");
    expect(text).toContain("## Last `saw hook repair`");
    expect(hooksReport({ status: { kind: "not-installed" }, checkedAt: undefined, change: undefined, sawVersion: undefined }, "preview"))
      .toContain("Install Scan-on-Clone Hooks");
  });
});
