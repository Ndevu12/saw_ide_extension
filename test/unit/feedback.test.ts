import { describe, expect, it } from "vitest";

import { chatCards, renderChat, type ChatFolderInput, type ChatMachineInput } from "../../src/core/chat/transcript";
import {
  askBlocked,
  askKind,
  dismissAsk,
  EMPTY_FEEDBACK,
  feedbackCard,
  issueUrl,
  moments,
  noteHold,
  noteScan,
  readMemory,
  reviewUrl,
  showAsk,
  starUrl,
  supportAsk,
  type FeedbackFacts,
} from "../../src/core/feedback/ask";

const OPEN = { checking: false, scanning: false, deciding: false, fixing: false };

function scans(count: number, verdict: "clean" | "residue" | "infected" | "incomplete" | "suspicious" = "clean") {
  let memory = EMPTY_FEEDBACK;
  for (let i = 0; i < count; i++) {
    memory = noteScan(memory, "app", `scan-${i}`, verdict);
  }
  return memory;
}

const facts: FeedbackFacts = {
  extensionVersion: "0.4.0",
  sawVersion: "0.15.0",
  editor: "Visual Studio Code",
  verdict: "clean",
};

describe("when Chat asks", () => {
  it("earns one quiet moment from three clean or residue scans, and ignores the rest", () => {
    expect(moments(scans(2))).toBe(0);
    expect(moments(scans(3))).toBe(1);
    expect(moments(scans(3, "residue"))).toBe(1);
    expect(moments(scans(3, "infected"))).toBe(0);
    expect(moments(scans(3, "incomplete"))).toBe(0);
    expect(moments(scans(3, "suspicious"))).toBe(0);
    const again = noteScan(scans(3), "app", "scan-2", "clean");
    expect(moments(again)).toBe(1);
  });

  it("earns a moment from the first hold, and does not count that hold twice", () => {
    const held = noteHold(EMPTY_FEEDBACK, "app:1");
    expect(moments(held)).toBe(1);
    expect(moments(noteHold(held, "app:1"))).toBe(1);
    expect(askKind(EMPTY_FEEDBACK)).toBe("ready");
    expect(askKind(held)).toBe("held");
    expect(askKind(scans(3))).toBe("quiet");
  });

  it("shows after a moment, hides for that version once dismissed, and returns on the next version after another moment", () => {
    const earned = noteHold(EMPTY_FEEDBACK, "app:1");
    expect(showAsk(earned, "0.4.0", false)).toBe(true);
    const dismissed = dismissAsk(earned, "0.4.0");
    expect(showAsk(dismissed, "0.4.0", false)).toBe(false);
    const later = noteHold(dismissed, "app:2");
    expect(showAsk(later, "0.4.0", false)).toBe(false);
    expect(showAsk(dismissed, "0.5.0", false)).toBe(false);
    expect(showAsk(later, "0.5.0", false)).toBe(true);
  });

  it("stops asking after a rating or a star", () => {
    const earned = supportAsk(noteHold(EMPTY_FEEDBACK, "app:1"));
    expect(showAsk(earned, "0.5.0", false)).toBe(false);
    expect(showAsk(noteHold(earned, "app:2"), "0.5.0", false)).toBe(false);
  });

  it("stays away while a folder is checking, unfinished, infected, or waiting on a fix", () => {
    const earned = noteHold(EMPTY_FEEDBACK, "app:1");
    expect(askBlocked([{ ...OPEN, checking: true }])).toBe(true);
    expect(askBlocked([{ ...OPEN, scanning: true }])).toBe(true);
    expect(askBlocked([{ ...OPEN, deciding: true }])).toBe(true);
    expect(askBlocked([{ ...OPEN, fixing: true }])).toBe(true);
    expect(askBlocked([{ ...OPEN, verdict: "infected" }])).toBe(true);
    expect(askBlocked([{ ...OPEN, verdict: "incomplete" }])).toBe(true);
    expect(askBlocked([{ ...OPEN, verdict: "suspicious" }])).toBe(true);
    expect(askBlocked([{ ...OPEN, verdict: "clean" }])).toBe(false);
    expect(showAsk(earned, "0.4.0", true)).toBe(false);
  });

  it("keeps a stored dismissal and drops a value it cannot read", () => {
    const stored = readMemory({ ...noteHold(EMPTY_FEEDBACK, "app:1"), supported: true, extra: 1 });
    expect(stored.holds).toBe(1);
    expect(stored.supported).toBe(true);
    expect(readMemory(null)).toEqual(EMPTY_FEEDBACK);
  });
});

describe("the feedback card", () => {
  const machine: ChatMachineInput = {
    engine: { phase: "ready", canInstall: false },
    auditing: false,
    hooks: "installed",
  };

  it("uses the hold sentence, then the quiet one, and offers the five actions", () => {
    const held = feedbackCard("held", false);
    expect(held.paragraphs[0]).toBe("saw held an update before it changed this folder. A rating is how the next person finds it.");
    const quiet = feedbackCard("quiet", false);
    expect(quiet.paragraphs[0]).toBe("saw has checked this folder and found nothing it knows. If that matched what you saw, a rating helps the next person.");
    expect(quiet.actions.map((button) => button.label)).toEqual(["Rate", "Star", "Report a problem", "Request a feature", "Not now"]);
    const choosing = feedbackCard("ready", true);
    expect(choosing.actions.map((button) => button.label)).toEqual(["The editor", "What saw found", "Back"]);
  });

  it("renders under the folder cards", () => {
    const folder: ChatFolderInput = { name: "app", phase: "idle", reasons: [], findings: [], verdict: "clean" };
    const html = renderChat(chatCards([folder], machine, feedbackCard("held", false)), "nonce");
    const folderAt = html.indexOf("app");
    const askAt = html.indexOf("A rating is how the next person finds it.");
    const machineAt = html.indexOf("This machine");
    expect(folderAt).toBeGreaterThan(-1);
    expect(askAt).toBeGreaterThan(folderAt);
    expect(machineAt).toBeGreaterThan(askAt);
    expect(html).toContain('data-act="feedback:rate"');
    expect(html).toContain('data-act="feedback:dismiss"');
  });
});

describe("where the buttons go", () => {
  it("opens the Marketplace review in VS Code and Open VSX everywhere else", () => {
    expect(reviewUrl("Visual Studio Code")).toBe("https://marketplace.visualstudio.com/items?itemName=ndevu12.stayawakebot&ssr=false#review-details");
    expect(reviewUrl("Cursor")).toBe("https://open-vsx.org/extension/Ndevu12/stayawakebot/reviews");
    expect(starUrl()).toBe("https://github.com/Ndevu12/saw_ide_extension");
  });

  it("prefills an issue with versions and the verdict, and leaves the folder out", () => {
    const editor = new URL(issueUrl("extension", "problem", facts));
    const found = new URL(issueUrl("saw", "problem", facts));
    const feature = new URL(issueUrl("extension", "feature", facts));
    expect(editor.hostname).toBe("github.com");
    expect(editor.pathname).toBe("/Ndevu12/saw_ide_extension/issues/new");
    expect(found.pathname).toBe("/Ndevu12/stayAwakeBot/issues/new");
    expect(feature.pathname).toBe("/Ndevu12/saw_ide_extension/issues/new");
    const body = editor.searchParams.get("body") ?? "";
    expect(body).toContain("Extension 0.4.0");
    expect(body).toContain("saw 0.15.0");
    expect(body).toContain("Editor Visual Studio Code");
    expect(body).toContain("Verdict clean");
    expect(body).not.toContain("/Users");
    expect(body).not.toContain("evidence");
    expect(feature.searchParams.get("title")).toBe("Feature request");
  });
});
