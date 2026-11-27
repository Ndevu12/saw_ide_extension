import { readFindings, strings, type HeldFinding } from "./contract";

export const QUESTIONS_ENV = "SAW_GOVERN_QUESTIONS";

export type QuestionAnswer = "run-as-typed" | "let-in" | "leave-unchanged";

interface QuestionBase {
  id: string;
  argv: string[];
  folder: string;
}

export interface CannotCheckQuestion extends QuestionBase {
  kind: "cannot-check";
  reason: string;
  checked: boolean;
}

export interface HeldQuestion extends QuestionBase {
  kind: "held";
  findings: HeldFinding[];
  nextSteps: string[];
  accept: string;
  confirm: boolean;
}

/** A question saw asks the editor when git runs with no terminal. */
export type Question = CannotCheckQuestion | HeldQuestion;

export function questionFileName(id: string): string {
  return `${id}.question.json`;
}

export function answerFileName(id: string): string {
  return `${id}.answer.json`;
}

export function questionId(fileName: string): string | undefined {
  const match = /^([A-Za-z0-9_-]+)\.question\.json$/.exec(fileName);
  return match?.[1];
}

export function readQuestion(text: string): Question | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const { schema_version: schema, id, kind, folder } = record;
  const argv = strings(record["argv"]);
  const choices = strings(record["choices"]);
  if (schema !== 1 || typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id) || typeof folder !== "string" || folder === "" || !argv.length) {
    return undefined;
  }
  if (kind === "cannot-check" && choices.includes("run-as-typed")) {
    const reason = typeof record["reason"] === "string" ? record["reason"] : "";
    return { kind, id, argv, folder, reason, checked: record["checked"] === true };
  }
  const accept = record["accept"];
  if (kind === "held" && choices.includes("let-in") && typeof accept === "string" && accept !== "") {
    return { kind, id, argv, folder, findings: readFindings(record["findings"]), nextSteps: strings(record["next_steps"]), accept, confirm: record["confirm"] === true };
  }
  return undefined;
}

export function answerText(question: Question, answer: QuestionAnswer): string {
  if (answer === "let-in" && question.kind === "held") {
    return JSON.stringify({ id: question.id, answer, accept: question.accept, confirm: question.confirm });
  }
  return JSON.stringify({ id: question.id, answer });
}
