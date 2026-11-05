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
    expect(checking).toContain("checking: reading git history (2/6)");
    const landed = page([folder({ verdict: "clean", unheld: true })]);
    expect(landed).toContain("was not held before it landed");
    const opened = page([folder({ verdict: "clean", unheld: true, unheldFrom: "open" })]);
    expect(opened).toContain("This folder is not a commit saw let in, and it was not put back.");
    expect(opened).not.toContain("git command");
    const opening = page([folder({ verdict: "clean", checking: true, checkAbout: "admission" })]);
    expect(opening).toContain("saw is checking whether it let this folder in. The folder has not changed.");
    expect(opening).toContain("checking this folder");
    expect(opening).not.toContain("checking this update");
  });

  it("puts the primary action on its own row of the card", () => {
    const html = page([folder({ verdict: "infected" })]);
    expect(html).toContain(".actions button.primary, .actions button.danger { flex: 1 1 100%; }");
  });
});
