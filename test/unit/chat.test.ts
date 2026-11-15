import { describe, expect, it } from "vitest";

import { chatPage, groupFindings, progressLine, renderChat, type ChatFindingInput, type ChatFolderInput, type ChatMachineInput } from "../../src/core/chat/transcript";
import { PAGE_PLACES, renderVerdict, verdictPage } from "../../src/core/chat/verdictPage";

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

function chat(folders: ChatFolderInput[], extra?: Partial<ChatMachineInput>): string {
  return renderChat(chatPage(folders, { ...machine, ...extra }), "nonce");
}

function tab(input: ChatFolderInput): string {
  return renderVerdict(verdictPage(input, 0), "nonce");
}

/** The words Chat draws, without markup, attributes, or the page's CSS and script. */
function words(html: string): string {
  const body = html.slice(html.indexOf("<body"), html.indexOf("<script"));
  return body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

function mainButtons(html: string): number {
  return (html.match(/<div class="cta">/g) ?? []).length;
}

const MERGES = ["0fb8655554", "23f55a6aa7", "25600c5d1e", "4a0d3dc770", "4aebdbce90", "5b1c2d3e4f"].map((where, index) =>
  finding("a merge commit that adds code of its own; check it", where, "medium", index + 1),
);
const HOOK = finding("a Claude Code hook that runs a command when Claude Code starts", ".claude/settings.json", "high", 0);

describe("the sidebar chat", () => {
  it("says where a folder stands and leaves the findings to the verdict tab", () => {
    const html = chat([folder({ verdict: "suspicious", findings: [HOOK, ...MERGES], unheld: true, unheldFrom: "open" })]);
    expect(html).toContain('<article class="card warn">');
    expect(html).toContain('<span class="pill">suspicious</span>');
    expect(html).toContain("7 findings · 1 high · 6 medium");
    expect(html).toContain('<p class="notice warn">This version arrived without a check.</p>');
    expect(html).toContain('<div class="cta"><button type="button" class="primary" data-act="verdict:0">See what was found</button></div>');
    expect(html).toContain('<button type="button" class="link" data-act="scan:0">Scan again</button>');
    expect(html).not.toContain("Claude Code hook");
    expect(html).not.toContain("0fb8655554");
    expect(html).not.toContain("open:0:");
    expect(html).not.toContain("report:0");
  });

  it("gives every folder card one main button at most", () => {
    const states: Partial<ChatFolderInput>[] = [
      {},
      { verdict: "clean" },
      { verdict: "suspicious", findings: MERGES },
      { verdict: "infected", findings: [HOOK] },
      { verdict: "infected", phase: "deciding" },
      { verdict: "infected", phase: "fixing" },
      { verdict: "clean", phase: "scanning", progress: "Scanning ~/a — 9 files" },
      { verdict: "clean", cleanup: { branch: "security/auto-clean-main", historyHoldsPayload: true, partial: false, needsYou: true } },
    ];
    for (const over of states) {
      const html = chat([folder(over)]);
      expect(mainButtons(html)).toBeLessThanOrEqual(1);
      expect((html.match(/class="link" data-act="(verdict|scan|fix-report):0"/g) ?? []).length).toBeLessThanOrEqual(3);
    }
  });

  it("does not repeat saw's name in what it says about a folder or the machine", () => {
    const html = chat(
      [folder({ verdict: "suspicious", findings: MERGES, unheld: true, unheldFrom: "open", held: { verdict: "infected", reasons: [] } })],
      { hooks: "repair", auditLabel: "safe once you confirm a few items", auditTone: "warn" },
    );
    expect(words(html)).not.toMatch(/\bsaw\b/i);
    expect(html).not.toContain("stayAwakeBot");
  });

  it("makes the fix the next step for an infected folder, with the verdict a link away", () => {
    const html = chat([folder({ verdict: "infected", findings: [finding("a task <img src=x onerror=alert(1)>", "tasks.json", "critical", 0)] })]);
    expect(html).toContain('<div class="cta"><button type="button" class="danger" data-act="fix:0">Clean this folder</button><p class="note">Past commits are not changed. Nothing is pushed.</p></div>');
    expect(html).toContain('data-act="verdict:0">See results</button>');
    expect(html).toContain('<article class="card bad">');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Cleaning past commits");
  });

  it("asks to scan a folder that has not been scanned", () => {
    const html = chat([folder()]);
    expect(html).toContain('<span class="pill">not scanned</span>');
    expect(html).toContain('class="primary" data-act="scan:0">Scan this folder<');
    expect(html).toContain("Not scanned yet. A scan only reads the folder.");
  });

  it("names the one notice that matters most", () => {
    const html = chat([folder({
      verdict: "clean",
      cleanup: { branch: "security/auto-clean-main", historyHoldsPayload: true, partial: false, needsYou: true },
    })]);
    expect(html).toContain('<p class="notice bad">Past commits still contain the malicious code.</p>');
    expect(html).not.toContain("security/auto-clean-main");
    expect(html).toContain('data-act="fix-report:0">Cleaning details<');
    expect(html).not.toContain("fix:0");
    const held = chat([folder({ verdict: "clean", held: { verdict: "infected", reasons: ["a workflow arrived"] } })]);
    expect(held).toContain('<p class="notice bad">An update was stopped (infected). The folder is unchanged.</p>');
    expect(held).not.toContain("a workflow arrived");
    for (const verdict of ["clean", "infected"] as const) {
      expect(chat([folder({ verdict, unheld: true, unheldFrom: "open" })])).not.toContain('class="notice');
    }
    expect(chat([folder({ verdict: "clean", unheld: true })])).toContain('<p class="notice bad">A git command changed this folder without a check.</p>');
  });

  it("shows a running scan on one line, keeps the last verdict, and offers no second scan", () => {
    const html = chat([folder({ phase: "scanning", progress: "Scanning ~/Dev/web/geofinda/GEOFINDA-Web — 17864 files across 5 workers", verdict: "suspicious" })]);
    expect(html).toContain('<span class="pill">suspicious</span>');
    expect(html).toContain("Scanning: 17864 files across 5 workers");
    expect(html).not.toContain("~/Dev/web/geofinda");
    expect(html).not.toContain("scan:0");
    expect(progressLine("Reading git history")).toBe("Reading git history");
    const checking = chat([folder({ verdict: "clean", checking: true, checkStep: "reading git history (2/6)" })]);
    expect(checking).toContain("Checking: reading git history (2/6)");
    expect(checking).toContain('class="live"');
  });

  it("opens a waiting decision from the card", () => {
    const html = chat([folder({ verdict: "infected", phase: "deciding", decision: "This question is part of fixing the checkout." })]);
    expect(html).toContain('class="primary" data-act="decide:0">Choose what to keep<');
    expect(html).toContain("Cleaning is waiting for your choice");
    expect(html).not.toContain("fix:0");
  });

  it("shows the machine as short rows that open their reports, with an action only for what needs one", () => {
    const html = chat([], { hooks: "repair", auditLabel: "safe once you confirm a few items", auditTone: "warn" });
    expect(html).toContain('<span class="pill">2 to do</span>');
    expect(html).toContain('data-act="machine:audit"');
    expect(html).toContain('data-act="machine:hooks"');
    expect(html).toContain('class="small primary" data-act="hooks:repair">Repair<');
    expect(html).toContain('class="small secondary" data-act="audit">Check again<');
    const ready = chat([], { auditLabel: "safe to change them", auditTone: "ok", watchLine: "The watcher is in place. <img src=x>" });
    expect(ready).toContain('<span class="pill">all good</span>');
    expect(ready).not.toContain('class="small');
    expect(ready).toContain("The watcher is in place. &lt;img src=x&gt;");
    expect(chat([])).toContain('class="small primary" data-act="audit">Check<');
  });

  it("ends with the way to every report and to what the verdicts mean", () => {
    const html = chat([folder({ verdict: "clean" })]);
    expect(html).toContain('<nav class="foot"><button type="button" class="link" data-act="reports">All details</button><button type="button" class="link" data-act="docs">What these results mean</button></nav>');
  });

  it("says saw cannot run, with the install as the one button", () => {
    const html = chat([], { engine: { phase: "unavailable", message: "saw 0.17.0 cannot be installed on this machine.", canInstall: true } });
    expect(html).toContain("saw cannot run");
    expect(html).toContain('class="primary" data-act="install">Install saw<');
    expect(html).toContain('data-act="log">Show log<');
  });
});

describe("the verdict tab", () => {
  it("lists every kind of finding, the most severe first, with the places under it", () => {
    const html = tab(folder({ verdict: "suspicious", path: "/home/me/app", findings: [...MERGES, HOOK], advisories: 38, reasons: ["a merge commit adds code"] }));
    expect(html).toContain('<span class="pill">suspicious</span><h1 class="title">app</h1>');
    expect(html).toContain('<p class="path">/home/me/app</p>');
    expect(html).toContain("7 findings · 1 high · 6 medium");
    expect(html).toContain('<span class="count">× 6</span>');
    expect(html).toContain('data-act="open:0:6"');
    expect(html.indexOf("Claude Code hook")).toBeLessThan(html.indexOf("A merge commit"));
    expect(html).toContain("<h2>Why saw says this</h2>");
    expect(html).toContain("38 packages have known security problems. Full details lists them.");
    expect(html).toContain('data-act="report:0">Full details<');
    expect(html).toContain('data-act="scan:0">Scan again<');
    expect(html).toContain('class="editor"');
  });

  it("explains the checkout fix beside its button, and what it does not do", () => {
    const html = tab(folder({ verdict: "infected", findings: [finding("a payload loader <img src=x>", "a1b2c3", "critical", 0)] }));
    expect(html).toContain('<div class="bar"><button type="button" class="danger" data-act="fix:0">Clean this folder</button>');
    expect(html).toContain("Past commits are not changed, and nothing is pushed.");
    expect(html).toContain("Cleaning past commits is a separate step.");
    expect(html).toContain('<span class="sev critical">critical</span>');
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img");
  });

  it("carries the full notices Chat shortens", () => {
    const html = tab(folder({
      verdict: "clean",
      unheld: true,
      unheldFrom: "open",
      cleanup: { branch: "security/auto-clean-main", historyHoldsPayload: true, partial: false, needsYou: true },
    }));
    expect(html).toContain("check this version of the folder before it arrived. Nothing was changed.");
    expect(html).toContain("The cleaned files are on the local branch security/auto-clean-main.");
    expect(html).toContain("Past commits still contain the malicious code.");
    expect(html).toContain('data-act="fix-report:0"');
    expect(html).toContain("saw found nothing harmful that it knows of.");
    const checking = tab(folder({ verdict: "clean", checking: true, checkAbout: "admission" }));
    expect(checking).toContain("saw is checking this version of the folder. Nothing has changed.");
  });

  it("leaves places past the first few to the full report", () => {
    const many = Array.from({ length: PAGE_PLACES + 3 }, (_, index) => finding("same kind", `file${index}`, "low", index));
    const [group] = groupFindings(many, 0, PAGE_PLACES);
    expect(group?.places).toHaveLength(PAGE_PLACES);
    expect(group?.hidden).toBe(3);
    expect(tab(folder({ verdict: "suspicious", findings: many }))).toContain("+3 more in Full details");
  });

  it("paints saw's own colors", () => {
    const html = tab(folder({ verdict: "infected" }));
    for (const color of ["#070908", "#7ee7b0", "#4cd07d", "#e3b341", "#ff6b6b"]) {
      expect(html).toContain(color);
    }
    expect(html).not.toContain("--vscode-button-background");
  });
});
