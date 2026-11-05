import { describe, expect, it } from "vitest";

import { chatCards, renderChat, type ChatFolderInput, type ChatMachineInput } from "../../src/core/chat/transcript";

const machine: ChatMachineInput = {
  engine: { phase: "ready", canInstall: false },
  auditing: false,
  hooks: "installed",
  hooksDetail: "post-checkout, post-merge",
};

function folder(over: Partial<ChatFolderInput> = {}): ChatFolderInput {
  return { name: "app", phase: "idle", reasons: [], findings: [], ...over };
}

function page(folders: ChatFolderInput[], extra?: Partial<ChatMachineInput>): string {
  return renderChat(chatCards(folders, { ...machine, ...extra }), "nonce");
}

describe("the sidebar chat", () => {
  it("gives an infected folder a fix button and keeps a finding as text", () => {
    const html = page([folder({
      verdict: "infected",
      reasons: ["a task runs on open"],
      findings: [{ label: `tasks.json — <img src=x onerror=alert(1)>` }],
    })]);
    expect(html).toContain('class="danger" data-act="fix:0"');
    expect(html).toContain("Fix the checkout");
    expect(html).toContain("Past commits stay as they are, and nothing is pushed.");
    expect(html).toContain("Amending history is a different act.");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain('data-act="open:0:0"');
  });

  it("does not offer fix for a clean folder, and says when an update was held", () => {
    const html = page([folder({
      verdict: "clean",
      held: { verdict: "infected", reasons: ["a workflow arrived"] },
    })]);
    expect(html).not.toContain("fix:0");
    expect(html).toContain("An update was held (infected). The folder was not changed.");
    expect(html).toContain('data-act="report:0"');
    expect(html).toContain("Open the scan report");
    expect(html).toContain('data-act="scan:0"');
  });

  it("asks to scan a folder that has not been scanned, and to install missing hooks", () => {
    const html = page([folder()], { hooks: "missing" });
    expect(html).toContain("Scan this folder");
    expect(html).toContain('class="primary" data-act="scan:0"');
    expect(html).toContain('data-act="hooks:install"');
    expect(html).toContain('data-act="watch"');
    expect(html).toContain("Open the watch report");
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
    expect(checking).toContain(">checking<");
    const landed = page([folder({ verdict: "clean", unheld: true })]);
    expect(landed).toContain("was not held before it landed");
    const opened = page([folder({ verdict: "clean", unheld: true, unheldFrom: "open" })]);
    expect(opened).toContain("This folder is not a commit saw let in, and it was not put back.");
    expect(opened).not.toContain("git command");
    const opening = page([folder({ verdict: "clean", checking: true, checkAbout: "admission" })]);
    expect(opening).toContain("saw is checking whether it let this folder in. The folder has not changed.");
    expect(opening).toContain(">checking<");
    expect(opening).not.toContain("checking this update");
  });

  it("paints saw's own colors and draws every control as a button", () => {
    const html = page([folder({
      phase: "scanning",
      progress: "Scanning ~/huge — 35359 files",
      verdict: "suspicious",
    })]);
    expect(html).toContain("#070908");
    expect(html).toContain("#7ee7b0");
    expect(html).toContain("#4cd07d");
    expect(html).toContain("#5fd3dd");
    expect(html).toContain("button.primary { background: #4cd07d;");
    expect(html).toContain("button.secondary { background: #0e1c18; border-color: #5fd3dd;");
    expect(html).toContain('class="secondary" data-act="verdict:0"');
    expect(html).toContain("Open verdict");
    expect(html).toContain(">scanning<");
    expect(html).toContain("Scanning ~/huge — 35359 files");
    expect(html).not.toContain("scanning: Scanning");
    expect(html).not.toContain("--vscode-button-background");
    const wide = renderChat(chatCards([folder({ verdict: "infected", phase: "deciding" })], machine), "nonce", "editor");
    expect(wide).toContain("stayAwakeBot");
    expect(wide).toContain("the sentinel saw the worm");
    expect(wide).toContain("Open the decision");
    expect(wide).toContain('class="editor"');
  });
});
