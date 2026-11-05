import { describe, expect, it } from "vitest";

import { heldQuestion, isFolderOpenRun, openRunKey, openRunQuestion, settingSummary, shellQuestion, shellUsesFolder, terminalSettingQuestion } from "../../src/core/openRun";

describe("commands that start because a folder opened", () => {
  it("treats only a folder-open task as an open-time run", () => {
    expect(isFolderOpenRun("folderOpen")).toBe(true);
    expect(isFolderOpenRun("default")).toBe(false);
    expect(isFolderOpenRun(undefined)).toBe(false);
  });

  it("changes the question when the command changes, and keeps the command as plain text", () => {
    expect(openRunKey("/work/app", "Workspace", "x", "node evil")).not.toBe(openRunKey("/work/app", "Workspace", "x", "node other"));
    expect(openRunQuestion("x", "node .vscode/a.woff2")).toBe("This folder wants to run x — node .vscode/a.woff2 because it opened. Run it?");
    expect(openRunQuestion("x\n<img>", "")).not.toContain("\n");
    expect(heldQuestion("x", "node evil")).toContain("Restricted Mode is holding it.");
  });

  it("notices a shell program or argument inside the folder, and not the working directory alone", () => {
    expect(shellUsesFolder("/work/app/.vscode/a.woff2", [], ["/work/app"])).toBe(true);
    expect(shellUsesFolder("bash", ["-c", "/work/app/pwn.sh"], ["/work/app"])).toBe(true);
    expect(shellUsesFolder("/bin/bash", [], ["/work/app"])).toBe(false);
    expect(shellUsesFolder("bash", [], ["/work/app"])).toBe(false);
    expect(shellQuestion("/work/app/pwn.sh", [])).toContain("/work/app/pwn.sh");
    expect(terminalSettingQuestion(settingSummary({ path: "bash", args: ["-c", "node evil"] }))).toContain("node evil");
  });
});
