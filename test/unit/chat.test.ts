import { describe, expect, it } from "vitest";

import { chatCards, groupFindings, progressLine, renderChat, type ChatFindingInput, type ChatFolderInput, type ChatMachineInput } from "../../src/core/chat/transcript";

const machine: ChatMachineInput = {
  engine: { phase: "ready", canInstall: false },
  auditing: false,
  hooks: "installed",
  hooksDetail: "post-checkout, post-merge",
};

function folder(over: Partial<ChatFolderInput> = {}): ChatFolderInput {
  return { name: "app", phase: "idle", reasons: [], findings: [], ...over };
}

function finding(what: string, where: string, severity: ChatFindingInput["severity"], open: number): ChatFindingInput {
  return { what, where, severity, open };
}

function page(folders: ChatFolderInput[], extra?: Partial<ChatMachineInput>): string {
  return renderChat(chatCards(folders, { ...machine, ...extra }), "nonce");
}

const MERGES = ["0fb8655554", "23f55a6aa7", "25600c5d1e", "4a0d3dc770", "4aebdbce90", "5b1c2d3e4f"].map((where, index) =>
  finding("a merge commit that adds code of its own; check it", where, "medium", index + 1),
);

describe("the sidebar chat", () => {
  it("gives an infected folder a fix button and keeps a finding as text", () => {
    const html = page([folder({
      verdict: "infected",
      reasons: ["a task runs on open"],
      findings: [finding("a task that runs on open <img src=x onerror=alert(1)>", "tasks.json", "critical", 0)],
    })]);
    expect(html).toContain('class="danger" data-act="fix:0"');
    expect(html).toContain("Fix the checkout");
    expect(html).toContain("Past commits stay as they are, and nothing is pushed.");
    expect(html).toContain("Amending history is a different act.");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain('data-act="open:0:0"');
    expect(html).toContain('<section class="card bad">');
  });

  it("does not offer fix for a clean folder, and says when an update was held", () => {
    const html = page([folder({
      verdict: "clean",
      held: { verdict: "infected", reasons: ["a workflow arrived"] },
    })]);
    expect(html).not.toContain("fix:0");
    expect(html).toContain('<p class="notice bad">An update was held (infected). The folder was not changed.</p>');
    expect(html).toContain('data-act="report:0"');
    expect(html).toContain("Open the scan report");
    expect(html).toContain('data-act="scan:0"');
  });

  it("says a clean folder had nothing saw knows", () => {
    expect(page([folder({ verdict: "clean" })])).toContain("saw found nothing it knows in this folder.");
  });

  it("asks to scan a folder that has not been scanned, and to install missing hooks", () => {
    const html = page([folder()], { hooks: "missing" });
    expect(html).toContain("Scan this folder");
    expect(html).toContain('class="primary" data-act="scan:0"');
    expect(html).toContain('data-act="hooks:install"');
    expect(html).toContain('data-act="watch"');
    expect(html).toContain(">Open report<");
  });

  it("quotes the last watch report as text", () => {
    const html = page([], { watchLine: "Watch is in place. <img src=x>" });
    expect(html).toContain("Watch is in place. &lt;img src=x&gt;");
    expect(html).not.toContain("in place. <img");
  });

  it("says when the checkout fix left the payload in history", () => {
    const html = page([folder({
      verdict: "clean",
      cleanup: { branch: "security/auto-clean-main", historyHoldsPayload: true, partial: false, needsYou: true },
    })]);
    expect(html).toContain("The clean-up is on the local branch security/auto-clean-main.");
    expect(html).toContain("left the malicious code in git history");
    expect(html).toContain('data-act="fix-report:0"');
    expect(html).not.toContain("fix:0");
  });

  it("says saw is checking an update, and when a git command was not held", () => {
    const checking = page([folder({ verdict: "clean", checking: true, checkStep: "reading git history (2/6)" })]);
    expect(checking).toContain("saw is checking this update: reading git history (2/6). The folder has not changed.");
    expect(checking).toContain('class="live"');
    expect(checking).toContain(">clean<");
    const landed = page([folder({ verdict: "clean", unheld: true })]);
    expect(landed).toContain('<p class="notice bad">A git command saw did not run changed this folder.');
    const opened = page([folder({ verdict: "clean", unheld: true, unheldFrom: "open" })]);
    expect(opened).toContain('<p class="notice warn">saw has no record of letting this commit in. The folder was left as it is.</p>');
    expect(opened).not.toContain("git command");
    const opening = page([folder({ verdict: "clean", checking: true, checkAbout: "admission" })]);
    expect(opening).toContain("saw is checking whether it let this folder in. The folder has not changed.");
    expect(opening).not.toContain("checking this update");
  });

  it("keeps the last verdict on the badge while the next scan runs, without the folder's path", () => {
    const html = page([folder({
      phase: "scanning",
      progress: "Scanning ~/Dev/web/geofinda/GEOFINDA-Web — 17864 files across 5 workers",
      verdict: "suspicious",
    })]);
    expect(html).toContain('<section class="card warn">');
    expect(html).toContain('<span class="badge">suspicious</span>');
    expect(html).toContain("Scanning: 17864 files across 5 workers");
    expect(html).not.toContain("~/Dev/web/geofinda");
    expect(html).not.toContain("scan:0");
    expect(progressLine("Scanning ~/a b/c — 9 files")).toBe("Scanning: 9 files");
    expect(progressLine("Reading git history")).toBe("Reading git history");
  });

  it("lists one line per kind of finding, the most severe first, with every place under it", () => {
    const findings = [...MERGES, finding("a Claude Code hook that runs a command when Claude Code starts", ".claude/settings.json", "high", 0)];
    const { groups, unlisted } = groupFindings(findings, 0);
    expect(groups.map((group) => [group.severity, group.count])).toEqual([["high", 1], ["medium", 6]]);
    expect(groups[1]?.what).toBe("A merge commit that adds code of its own; check it");
    expect(groups[1]?.places.map((place) => place.label)).toEqual(["0fb8655554", "23f55a6aa7", "25600c5d1e", "4a0d3dc770"]);
    expect(groups[1]?.places[0]?.act).toBe("open:0:1");
    expect(groups[1]?.hidden).toBe(2);
    expect(unlisted).toBe(0);
    const html = page([folder({ verdict: "suspicious", findings })]);
    expect(html).toContain("7 findings · 1 high · 6 medium");
    expect(html).toContain('<span class="count">× 6</span>');
    expect(html).toContain('data-act="report:0">+2 in the report</button>');
    expect(html.indexOf("Claude Code hook")).toBeLessThan(html.indexOf("A merge commit"));
  });

  it("leaves kinds past the first few to the report", () => {
    const many = Array.from({ length: 8 }, (_, index) => finding(`kind ${index}`, `file${index}`, "low", index));
    const { groups, unlisted } = groupFindings(many, 0);
    expect(groups).toHaveLength(5);
    expect(unlisted).toBe(3);
    expect(page([folder({ verdict: "suspicious", findings: many })])).toContain("3 more findings are in the report.");
  });

  it("makes reading the report the next step for a suspicious folder", () => {
    const html = page([folder({ verdict: "suspicious", findings: MERGES })]);
    expect(html).toContain('<div class="main"><button type="button" class="primary" data-act="report:0">Open the scan report</button></div>');
    expect(html).toContain('class="secondary" data-act="scan:0"');
    expect(html).toContain('class="secondary" data-act="verdict:0"');
  });

  it("shows the machine as lines with their own state and action", () => {
    const html = page([], { hooks: "repair", auditLabel: "safe once you confirm saw's items", auditTone: "warn" });
    expect(html).toContain('<span class="badge">2 to do</span>');
    expect(html).toContain("Changing them: safe once you confirm saw&#39;s items.");
    expect(html).toContain('class="primary" data-act="hooks:repair">Repair<');
    expect(html).toContain('<span class="dot warn">');
    const ready = page([], { auditLabel: "no hazard found", auditTone: "ok", watchLine: "The watcher is in place." });
    expect(ready).toContain('<span class="badge">in order</span>');
    expect(ready).toContain("In place: post-checkout, post-merge.");
    const fresh = page([]);
    expect(fresh).toContain("Not audited yet. Audit before you change a password or token.");
    expect(fresh).toContain('class="primary" data-act="audit">Audit<');
  });

  it("paints saw's own colors and draws every control as a button", () => {
    const html = page([folder({ verdict: "infected", findings: [finding("a payload loader", "a1b2c3", "critical", 0)] })]);
    expect(html).toContain("#070908");
    expect(html).toContain("#7ee7b0");
    expect(html).toContain("#4cd07d");
    expect(html).toContain("#e3b341");
    expect(html).toContain("#ff6b6b");
    expect(html).toContain('<span class="sev critical">critical</span>');
    expect(html).toContain('class="place"');
    expect(html).not.toContain("--vscode-button-background");
    const wide = renderChat(chatCards([folder({ verdict: "infected", phase: "deciding" })], machine), "nonce", "editor");
    expect(wide).toContain("stayAwakeBot");
    expect(wide).toContain("the sentinel saw the worm");
    expect(wide).toContain("Open the decision");
    expect(wide).toContain('class="editor"');
  });
});
