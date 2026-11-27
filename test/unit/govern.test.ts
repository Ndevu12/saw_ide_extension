import { describe, expect, it } from "vitest";

import { letInArgs, mayRelease, offersGovernRestore, offersGovernVerdict, openAdmission, readGoverned, readNotice, readRestore, restoreArgs, shouldRestore, unheldAfter, verdictArgs } from "../../src/core/govern/contract";

describe("saw govern's report", () => {
  it("lets in a clean or residue update and calls anything else held", () => {
    expect(mayRelease("clean")).toBe(true);
    expect(mayRelease("residue")).toBe(true);
    expect(mayRelease("suspicious")).toBe(false);
    expect(mayRelease("infected")).toBe(false);
    expect(mayRelease("incomplete")).toBe(false);
  });

  it("reads a checking notice, and ignores a file that is not one", () => {
    expect(readNotice(JSON.stringify({ repo: "/work/app", phase: "checking", step: "reading git history (2/6)", reasons: [], at: 1 }))).toMatchObject({
      phase: "checking",
      step: "reading git history (2/6)",
    });
    expect(readNotice(JSON.stringify({ repo: "/work/app", phase: "held", verdict: "infected", reasons: ["a workflow arrived"], at: 2 }))?.phase).toBe("held");
    expect(readNotice(JSON.stringify({ repo: "/work/app", phase: "finished", reasons: [], at: 3 }))?.phase).toBe("finished");
    expect(readNotice("not json")).toBeUndefined();
    expect(readNotice(JSON.stringify({ released: true }))).toBeUndefined();
  });

  it("reads whether saw let the tree in, and treats anything else as no answer", () => {
    expect(verdictArgs("/work/app")).toEqual(["govern", "verdict", "--json", "--repo", "/work/app"]);
    expect(readGoverned(JSON.stringify({ schema_version: 1, governed: "let-in", reason: "this tree is one saw let in" })).answer).toBe("let-in");
    expect(readGoverned(JSON.stringify({ schema_version: 1, governed: "not-let-in", reason: "this tree is not one saw let in" })).answer).toBe("not-let-in");
    expect(readGoverned(JSON.stringify({ schema_version: 1, governed: "could-not-answer", reason: "the open folder has no commit yet" })).answer).toBe("could-not-answer");
    expect(readGoverned(JSON.stringify({ schema_version: 1, governed: "clean" })).answer).toBe("could-not-answer");
    expect(readGoverned("not json").answer).toBe("could-not-answer");
    expect(readGoverned(JSON.stringify({ schema_version: 2, governed: "let-in" })).answer).toBe("could-not-answer");
  });

  it("keys off saw's machine code and the commits it names, not the prose", () => {
    const commit = "a".repeat(40);
    const other = "b".repeat(40);
    expect(readGoverned(JSON.stringify({
      schema_version: 1, governed: "not-let-in", code: "unknown-commit", reason: "this tree is not one saw let in", head: other, let_in: commit,
    }))).toEqual({ answer: "not-let-in", code: "unknown-commit", head: other, letIn: commit });
    expect(readGoverned(JSON.stringify({ schema_version: 1, governed: "not-let-in", code: "tree-changed", reason: "rewritten prose" })).code).toBe("tree-changed");
    expect(readGoverned(JSON.stringify({ schema_version: 1, governed: "let-in", reason: "this tree is one saw let in" })).code).toBeUndefined();
    expect(restoreArgs("/work/app")).toEqual(["govern", "restore", "--json", "--repo", "/work/app"]);
    expect(readRestore(JSON.stringify({ schema_version: 1, restored: true, commit })).restored).toBe(true);
    expect(readRestore(JSON.stringify({ schema_version: 1, restored: false, reason: "nothing to put back" }))).toMatchObject({ restored: false });
    expect(shouldRestore("unknown-commit", true)).toBe(true);
    expect(shouldRestore("tree-changed", true)).toBe(false);
    expect(shouldRestore("unknown-commit", false)).toBe(false);
    expect(shouldRestore(undefined, true)).toBe(false);
    expect(offersGovernRestore("  {prepare,apply,verdict,restore}\n")).toBe(true);
    expect(offersGovernRestore("  {prepare,apply,verdict}\n")).toBe(false);
  });

  it("reads a tree you let in yourself, and asks saw to let a held update in for a folder", () => {
    const reading = readGoverned(JSON.stringify({ schema_version: 1, governed: "not-let-in", code: "let-in-by-you", reason: "you let this tree in although saw found it infected" }));
    expect(reading).toEqual({ answer: "not-let-in", code: "let-in-by-you" });
    expect(openAdmission(reading, true)).toBe("mark");
    expect(letInArgs("/work/app")).toEqual(["govern", "let-in", "--repo", "/work/app"]);
  });

  it("decides an open folder from the verdict, and leaves no answer alone", () => {
    const unknown = { answer: "not-let-in" as const, code: "unknown-commit" as const };
    const changed = { answer: "not-let-in" as const, code: "tree-changed" as const };
    expect(openAdmission({ answer: "let-in" }, false)).toBe("clear");
    expect(openAdmission({ answer: "let-in", code: "let-in" }, true)).toBe("clear");
    expect(openAdmission(unknown, true)).toBe("restore");
    expect(openAdmission(unknown, false)).toBe("mark");
    expect(openAdmission(changed, true)).toBe("mark");
    expect(openAdmission({ answer: "not-let-in" }, true)).toBe("mark");
    expect(openAdmission({ answer: "could-not-answer" }, true)).toBe("leave");
    expect(openAdmission({ answer: "not-let-in", code: "could-not-answer" }, false)).toBe("leave");
    expect(openAdmission(undefined, true)).toBe("leave");
  });

  it("calls out a tree saw did not let in, and stays quiet when saw already let it in", () => {
    expect(unheldAfter("let-in", true)).toBe("clear");
    expect(unheldAfter("let-in", false)).toBe("clear");
    expect(unheldAfter("not-let-in", true)).toBe("mark");
    expect(unheldAfter("not-let-in", false)).toBe("mark");
    expect(unheldAfter("could-not-answer", true)).toBe("leave");
    expect(unheldAfter("could-not-answer", false)).toBe("leave");
    expect(unheldAfter(undefined, true)).toBe("leave");
    expect(unheldAfter(undefined, false)).toBe("mark");
  });

  it("recognises saw's verdict command from its help, and not an older govern", () => {
    expect(offersGovernVerdict("  {prepare,apply,verdict,install}\n")).toBe(true);
    expect(offersGovernVerdict("  verdict  say whether the open folder's tree is one saw let in\n")).toBe(true);
    expect(offersGovernVerdict("  {prepare,apply,install,status,uninstall}\n")).toBe(false);
  });
});
