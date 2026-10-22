import { chmodSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { answerLine, decisionLine, isAskEvent, readAsk, type AskQuestion } from "../../src/core/fix/ask";
import { fixReport } from "../../src/core/report/reports";
import { runProgram } from "../../src/core/run";
import { onWindows, tempDir } from "./helpers";

const delivery = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    event: "ask",
    schema_version: 1,
    id: "1",
    question: {
      kind: "delivery",
      commit: "a".repeat(40),
      known_as: ["b".repeat(40)],
      date: "2026-10-01",
      subject: "add files",
      recorded: true,
      removing: ["payload.js"],
      files: [{ path: "src/util.js", blob: "c".repeat(40), named_by: 2 }, { path: 1 }],
      changed: ["README.md"],
      ...over,
    },
  });

describe("questions saw asks during a fix", () => {
  it("ignores a line that is not an ask", () => {
    expect(readAsk("")).toBeUndefined();
    expect(readAsk("not json")).toBeUndefined();
    expect(readAsk(JSON.stringify({ event: "step", label: "scanning" }))).toBeUndefined();
    expect(isAskEvent(JSON.stringify({ event: "step" }))).toBe(false);
  });

  it("reads a delivery, a package and a file, and drops a field it cannot use", () => {
    const read = readAsk(delivery());
    expect(read).toMatchObject({
      kind: "delivery",
      id: "1",
      recorded: true,
      removing: ["payload.js"],
      files: [{ path: "src/util.js", blob: "c".repeat(40), namedBy: 2 }],
      changed: ["README.md"],
      knownAs: ["b".repeat(40)],
    });
    expect(readAsk(JSON.stringify({ event: "ask", schema_version: 1, id: "2", question: { kind: "package", name: "left-pad", versions: ["1.2.3"], manifests: [{ path: "package.json", proposed: "{}" }, { path: "other.json" }] } }))).toEqual({
      kind: "package",
      id: "2",
      name: "left-pad",
      versions: ["1.2.3"],
      manifests: [{ path: "package.json", proposed: "{}" }, { path: "other.json" }],
    });
    const file = readAsk(JSON.stringify({ event: "ask", id: "3", question: { kind: "file", path: "src/a.js", confirmed: true, supply: true, restore: { commit: "d".repeat(40), blob: "e".repeat(40) }, sha256: "ab" } }));
    expect(file).toMatchObject({ kind: "file", id: "3", confirmed: true, supply: true, sha256: "ab", withheld: false, restore: { commit: "d".repeat(40), blob: "e".repeat(40) } });
  });

  it("refuses a question it must not guess an answer to", () => {
    expect(readAsk(JSON.stringify({ event: "ask", schema_version: 2, id: "1", question: { kind: "package", name: "x" } }))).toEqual({ refused: expect.stringMatching(/schema 2/) });
    expect(readAsk(JSON.stringify({ event: "ask", id: "", question: { kind: "package", name: "x" } }))).toEqual({ refused: expect.stringMatching(/cannot read/) });
    expect(readAsk(JSON.stringify({ event: "ask", id: "1", question: { kind: "other" } }))).toEqual({ refused: expect.stringMatching(/cannot read/) });
    expect(isAskEvent(JSON.stringify({ event: "ask" }))).toBe(true);
  });

  it("answers in the words saw already uses, and rejects an action the question did not offer", () => {
    const question = readAsk(delivery()) as AskQuestion;
    expect(answerLine(question, { action: "keep" })).toBe(JSON.stringify({ id: "1", action: "keep" }));
    expect(answerLine(question, { action: "take-out", chosen: ["src/util.js", "missing.js"] })).toBe(JSON.stringify({ id: "1", action: "take-out", chosen: ["src/util.js"] }));
    expect(answerLine(question, { action: "take-out", chosen: ["missing.js"] })).toBeUndefined();
    expect(answerLine(question, { action: "remove" })).toBeUndefined();
    const file = readAsk(JSON.stringify({ event: "ask", id: "3", question: { kind: "file", path: "src/a.js", supply: false } })) as AskQuestion;
    expect(answerLine(file, { action: "restore" })).toBeUndefined();
    expect(answerLine(file, { action: "supply", path: "/tmp/clean.js" })).toBeUndefined();
    expect(answerLine(file, { action: "remove" })).toBe(JSON.stringify({ id: "3", action: "remove" }));
    const pack = readAsk(JSON.stringify({ event: "ask", id: "2", question: { kind: "package", name: "left-pad" } })) as AskQuestion;
    expect(answerLine(pack, { action: "take-out", chosen: [] })).toBe(JSON.stringify({ id: "2", action: "take-out" }));
    expect(decisionLine(question, { action: "keep" })).toMatch(/^kept the files added in aaaaaa/);
    expect(decisionLine(file, { action: "remove" })).toBe("will remove src/a.js");
    expect(decisionLine(pack, { action: "keep" })).toBe("left left-pad declared");
  });

  it("puts the choices into the fix report", () => {
    const text = fixReport({ folderName: "web", folderPath: "/work/web", run: { startedAt: 0, said: "" }, outcome: { kind: "prepared", needsReview: false }, decisions: ["kept src/a.js", "will remove left-pad"], sawVersion: "0.14.0" }, "preview");
    expect(text).toContain("## What you decided");
    expect(text).toContain("kept src\\/a\\.js");
    expect(text).toContain("will remove left\\-pad");
  });

  it.skipIf(onWindows)("writes an answer on standard input, and does not time out while the operator is deciding", async () => {
    const file = path.join(tempDir("ask-saw-"), "saw");
    writeFileSync(
      file,
      `#!${process.execPath}
let got = "";
process.stdin.on("data", (chunk) => {
  got += chunk;
  if (got.includes("\\n")) {
    process.stdout.write(got);
    process.exit(0);
  }
});
process.stderr.write("waiting\\n");
`,
    );
    chmodSync(file, 0o755);
    const result = await runProgram(file, [], {
      timeoutMs: 200,
      input: true,
      onReady: (control) => {
        control.hold(true);
        setTimeout(() => {
          control.hold(false);
          control.writeLine('{"id":"1","action":"keep"}');
        }, 400);
      },
    });
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('{"id":"1","action":"keep"}\n');
  });
});
