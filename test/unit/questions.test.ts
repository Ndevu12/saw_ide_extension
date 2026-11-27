import { describe, expect, it } from "vitest";

import { readCapabilities } from "../../src/core/capabilities";
import { readNotice } from "../../src/core/govern/contract";
import { answerFileName, answerText, questionFileName, questionId, readQuestion, type Question } from "../../src/core/govern/questions";

const finding = { signature_id: "vscode-task-runs-font", severity: "critical", path: ".vscode/tasks.json", description: "a task runs a hidden script" };

describe("saw's questions about git run with no terminal", () => {
  it("reads an update saw cannot check, and answers with the choice alone", () => {
    const question = readQuestion(JSON.stringify({
      schema_version: 1, id: "q1", kind: "cannot-check", choices: ["run-as-typed", "leave-unchanged"], argv: ["git", "pull"], folder: "/work/app", reason: "the fetch did not finish", checked: false,
    }));
    expect(question).toEqual({ kind: "cannot-check", id: "q1", argv: ["git", "pull"], folder: "/work/app", reason: "the fetch did not finish", checked: false });
    expect(JSON.parse(answerText(question as Question, "run-as-typed"))).toEqual({ id: "q1", answer: "run-as-typed" });
  });

  it("lets a held update in with exactly the commit saw checked, confirmed when saw asks", () => {
    const question = readQuestion(JSON.stringify({
      schema_version: 1, id: "q2", kind: "held", choices: ["let-in", "leave-unchanged"], argv: ["git", "merge", "origin/main"], folder: "/work/app",
      findings: [finding], next_steps: ["Do not merge it."], accept: "e03fafdf84df", confirm: true,
    }));
    expect(question).toMatchObject({ kind: "held", accept: "e03fafdf84df", confirm: true, nextSteps: ["Do not merge it."] });
    expect(question?.kind === "held" ? question.findings : []).toEqual([{ severity: "critical", path: ".vscode/tasks.json", description: "a task runs a hidden script" }]);
    expect(JSON.parse(answerText(question as Question, "let-in"))).toEqual({ id: "q2", answer: "let-in", accept: "e03fafdf84df", confirm: true });
    expect(JSON.parse(answerText(question as Question, "leave-unchanged"))).toEqual({ id: "q2", answer: "leave-unchanged" });
  });

  it("ignores a question it cannot read, and names the files as saw does", () => {
    expect(readQuestion("not json")).toBeUndefined();
    expect(readQuestion(JSON.stringify({ schema_version: 2, id: "q", kind: "held", choices: ["let-in"], argv: ["git"], folder: "/w", accept: "a" }))).toBeUndefined();
    expect(readQuestion(JSON.stringify({ schema_version: 1, id: "../q", kind: "cannot-check", choices: ["run-as-typed"], argv: ["git"], folder: "/w" }))).toBeUndefined();
    expect(readQuestion(JSON.stringify({ schema_version: 1, id: "q", kind: "held", choices: ["let-in"], argv: ["git"], folder: "/w" }))).toBeUndefined();
    expect(questionFileName("q1")).toBe("q1.question.json");
    expect(answerFileName("q1")).toBe("q1.answer.json");
    expect(questionId("q1.question.json")).toBe("q1");
    expect(questionId("q1.answer.json")).toBeUndefined();
  });
});

describe("what saw records about a held update", () => {
  it("reads the findings, the command, what to do, and whether saw can review it again", () => {
    const notice = readNotice(JSON.stringify({
      repo: "/work/app", phase: "held", at: 1, verdict: "infected", reasons: ["the update was not applied"],
      findings: [finding], command: { argv: ["git", "merge", "origin/main"], folder: "/work/app" }, next_steps: ["Do not merge it."], let_in: true,
    }));
    expect(notice?.details).toEqual({
      command: "git merge origin/main",
      findings: [{ severity: "critical", path: ".vscode/tasks.json", description: "a task runs a hidden script" }],
      nextSteps: ["Do not merge it."],
      letIn: true,
    });
    expect(readNotice(JSON.stringify({ repo: "/work/app", phase: "held", at: 1, reasons: [] }))?.details).toBeUndefined();
    expect(readNotice(JSON.stringify({ repo: "/work/app", phase: "applied", at: 1, reasons: [], findings: [finding] }))?.details).toBeUndefined();
  });

  it("reads where saw's git and gh check is installed", () => {
    expect(readCapabilities(JSON.stringify({ features: [], programs: { git_standin: "/venv/bin/saw-git-standin" } }), 0).gitStandin).toBe("/venv/bin/saw-git-standin");
    expect(readCapabilities(JSON.stringify({ features: [], programs: { git_standin: null } }), 0).gitStandin).toBeUndefined();
    expect(readCapabilities(JSON.stringify({ features: [] }), 0).gitStandin).toBeUndefined();
  });
});
