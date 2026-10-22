// `saw fix --ask=jsonl` (stayAwakeBot#1847). One question per line on stderr, one answer per line
// on stdin. A saw that does not announce `fix.ask.json` is never asked this way.

import { plain } from "../text";

export const ASK_SCHEMA = 1;

export interface DeliveryFile {
  path: string;
  blob: string;
  /** How many other files in the project mention it, when saw counted that. */
  namedBy?: number;
}

export interface AskManifest {
  path: string;
  /** The manifest with the package removed, when saw can rewrite it exactly. */
  proposed?: string;
}

export interface AskDelivery {
  kind: "delivery";
  id: string;
  commit: string;
  knownAs: string[];
  date: string;
  subject: string;
  recorded: boolean;
  removing: string[];
  files: DeliveryFile[];
  changed: string[];
}

export interface AskPackage {
  kind: "package";
  id: string;
  name: string;
  versions: string[];
  manifests: AskManifest[];
}

export interface AskFile {
  kind: "file";
  id: string;
  path: string;
  category: string;
  signatureId: string;
  description: string;
  confirmed: boolean;
  introducedBy: string;
  arrivedWithRemoved: string[];
  originUnread: boolean;
  restore?: { commit: string; blob: string };
  supply: boolean;
  sha256: string;
  withheld: boolean;
}

export type AskQuestion = AskDelivery | AskPackage | AskFile;

export type AskDecision =
  | { action: "keep" }
  | { action: "take-out"; chosen: string[] }
  | { action: "remove" }
  | { action: "restore" }
  | { action: "supply"; path: string };

export type AskRead = AskQuestion | { refused: string } | undefined;

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const flag = (value: unknown): boolean => value === true;

/** A stderr line that is an ask event, whether or not this extension can read it. */
export function isAskEvent(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return !!parsed && typeof parsed === "object" && (parsed as { event?: unknown }).event === "ask";
  } catch {
    return false;
  }
}

/**
 * Read one ask line. Undefined when it is not an ask event. `{ refused }` when it is an ask this
 * extension must not guess an answer to.
 */
export function readAsk(line: string): AskRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { event?: unknown }).event !== "ask") {
    return undefined;
  }
  const event = parsed as Record<string, unknown>;
  const schema = event["schema_version"];
  if (schema !== undefined && schema !== ASK_SCHEMA) {
    return { refused: `saw asked a question in schema ${String(schema)}, and this extension reads schema ${ASK_SCHEMA}` };
  }
  const id = text(event["id"]);
  const body = event["question"];
  if (!id || !body || typeof body !== "object") {
    return { refused: "saw asked a question this extension cannot read" };
  }
  const question = readQuestion(id, body as Record<string, unknown>);
  return question ?? { refused: "saw asked a question this extension cannot read" };
}

function readQuestion(id: string, body: Record<string, unknown>): AskQuestion | undefined {
  switch (body["kind"]) {
    case "delivery":
      return readDelivery(id, body);
    case "package":
      return readPackage(id, body);
    case "file":
      return readFileQuestion(id, body);
    default:
      return undefined;
  }
}

function readDelivery(id: string, body: Record<string, unknown>): AskDelivery | undefined {
  const commit = text(body["commit"]);
  if (!commit) {
    return undefined;
  }
  const files: DeliveryFile[] = [];
  if (Array.isArray(body["files"])) {
    for (const item of body["files"]) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      const path = text(record["path"]);
      const blob = text(record["blob"]);
      if (!path || !blob) {
        continue;
      }
      const named = record["named_by"];
      files.push({ path, blob, ...(Number.isInteger(named) && (named as number) >= 0 ? { namedBy: named as number } : {}) });
    }
  }
  return {
    kind: "delivery",
    id,
    commit,
    knownAs: texts(body["known_as"]),
    date: text(body["date"]) ?? "",
    subject: text(body["subject"]) ?? "",
    recorded: flag(body["recorded"]),
    removing: texts(body["removing"]),
    files,
    changed: texts(body["changed"]),
  };
}

function readPackage(id: string, body: Record<string, unknown>): AskPackage | undefined {
  const name = text(body["name"]);
  if (!name) {
    return undefined;
  }
  const manifests: AskManifest[] = [];
  if (Array.isArray(body["manifests"])) {
    for (const item of body["manifests"]) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      const path = text(record["path"]);
      if (!path) {
        continue;
      }
      const proposed = text(record["proposed"]);
      manifests.push({ path, ...(proposed !== undefined ? { proposed } : {}) });
    }
  }
  return { kind: "package", id, name, versions: texts(body["versions"]), manifests };
}

function readFileQuestion(id: string, body: Record<string, unknown>): AskFile | undefined {
  const path = text(body["path"]);
  if (!path) {
    return undefined;
  }
  const restore = body["restore"];
  let clean: { commit: string; blob: string } | undefined;
  if (restore && typeof restore === "object") {
    const record = restore as Record<string, unknown>;
    const commit = text(record["commit"]);
    const blob = text(record["blob"]);
    if (commit && blob) {
      clean = { commit, blob };
    }
  }
  return {
    kind: "file",
    id,
    path,
    category: text(body["category"]) ?? "",
    signatureId: text(body["signature_id"]) ?? "",
    description: text(body["description"]) ?? "",
    confirmed: flag(body["confirmed"]),
    introducedBy: text(body["introduced_by"]) ?? "",
    arrivedWithRemoved: texts(body["arrived_with_removed"]),
    originUnread: flag(body["origin_unread"]),
    ...(clean ? { restore: clean } : {}),
    supply: flag(body["supply"]),
    sha256: text(body["sha256"]) ?? "",
    withheld: flag(body["withheld"]),
  };
}

/** The answer saw reads, or undefined when `decision` is not legal for `question`. */
export function answerLine(question: AskQuestion, decision: AskDecision): string | undefined {
  const body = answerBody(question, decision);
  if (!body) {
    return undefined;
  }
  return JSON.stringify({ id: question.id, ...body });
}

function answerBody(question: AskQuestion, decision: AskDecision): Record<string, unknown> | undefined {
  if (decision.action === "keep") {
    return { action: "keep" };
  }
  if (question.kind === "delivery" && decision.action === "take-out") {
    const offered = new Set(question.files.map((file) => file.path));
    const chosen = decision.chosen.filter((path) => offered.has(path));
    return chosen.length ? { action: "take-out", chosen } : undefined;
  }
  if (question.kind === "file" && decision.action === "remove") {
    return { action: "remove" };
  }
  if (question.kind === "file" && decision.action === "restore" && question.restore) {
    return { action: "restore" };
  }
  if (question.kind === "file" && decision.action === "supply" && question.supply && decision.path.trim()) {
    return { action: "supply", path: decision.path };
  }
  if (question.kind === "package" && decision.action === "take-out") {
    return { action: "take-out" };
  }
  return undefined;
}

/** One line for the fix report and the Decide log, in the operator's words. */
export function decisionLine(question: AskQuestion, decision: AskDecision): string {
  switch (question.kind) {
    case "file": {
      const path = plain(question.path, 200);
      if (decision.action === "remove") return `will remove ${path}`;
      if (decision.action === "restore") return `will restore ${path}`;
      if (decision.action === "supply") return `will replace ${path}`;
      return `kept ${path}`;
    }
    case "package":
      return decision.action === "take-out" ? `will remove ${plain(question.name, 200)}` : `left ${plain(question.name, 200)} declared`;
    case "delivery": {
      const commit = plain(question.commit.slice(0, 12), 20);
      if (decision.action === "take-out") {
        return `will take out ${decision.chosen.map((path) => plain(path, 200)).join(", ")} from ${commit}`;
      }
      return `kept the files added in ${commit}`;
    }
  }
}
