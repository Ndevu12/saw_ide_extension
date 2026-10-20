// The shape of `saw scan --json`, as `stayawake.bots.security.models.ScanReport.to_payload` emits it.
// Only the fields this extension reads are declared; everything else is ignored, so saw may add fields.

import { schemaProblem } from "./capabilities";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ["confirmed", "heuristic", "residue", "informational"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const TARGET_VERDICTS = ["clean", "suspicious", "residue", "infected"] as const;
export type TargetVerdict = (typeof TARGET_VERDICTS)[number];

export interface Finding {
  signatureId: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  path: string;
  line: number | null;
  description: string;
  evidence: string | null;
  remediation: string;
  advisoryOnly: boolean;
  /** What to run or change, e.g. the fixed version of a dependency. */
  fixAdvice: string | null;
  /** A page about the advisory or technique. */
  reference: string | null;
}

export interface TargetResult {
  target: string;
  verdict: TargetVerdict;
  error: string | null;
  findings: Finding[];
  advisories: Finding[];
  informational: Finding[];
  notes: string[];
}

export interface ScanPayload {
  generatedAt: string;
  results: TargetResult[];
}

export class ContractError extends Error {
  override name = "ContractError";
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new ContractError(`${field} is ${JSON.stringify(value)}, expected one of ${allowed.join(", ")}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ContractError(`${field} is not a string`);
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function list(value: unknown, field: string): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ContractError(`${field} is not a list`);
  }
  return value;
}

function parseFinding(raw: unknown, field: string): Finding {
  if (!isObject(raw)) {
    throw new ContractError(`${field} is not an object`);
  }
  const line = raw["line"];
  return {
    signatureId: text(raw["signature_id"], `${field}.signature_id`),
    category: text(raw["category"], `${field}.category`),
    severity: oneOf(SEVERITIES, raw["severity"], `${field}.severity`),
    confidence: oneOf(CONFIDENCES, raw["confidence"], `${field}.confidence`),
    path: text(raw["path"], `${field}.path`),
    line: typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null,
    description: text(raw["description"], `${field}.description`),
    evidence: optionalText(raw["evidence"]),
    remediation: optionalText(raw["remediation"]) ?? "manual",
    advisoryOnly: raw["advisory_only"] === true,
    fixAdvice: optionalText(raw["fix_advice"]),
    reference: optionalText(raw["reference"]),
  };
}

function parseTarget(raw: unknown, field: string): TargetResult {
  if (!isObject(raw)) {
    throw new ContractError(`${field} is not an object`);
  }
  const findings = (name: string) =>
    list(raw[name], `${field}.${name}`).map((f, i) => parseFinding(f, `${field}.${name}[${i}]`));
  return {
    target: text(raw["target"], `${field}.target`),
    verdict: oneOf(TARGET_VERDICTS, raw["verdict"], `${field}.verdict`),
    error: optionalText(raw["error"]),
    findings: findings("findings"),
    advisories: findings("advisories"),
    informational: findings("informational"),
    notes: list(raw["notes"], `${field}.notes`).filter((n): n is string => typeof n === "string"),
  };
}

export function parsePayload(stdout: string): ScanPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new ContractError("saw did not print a JSON report");
  }
  if (!isObject(raw)) {
    throw new ContractError("the report is not a JSON object");
  }
  const unreadable = schemaProblem("scan", raw);
  if (unreadable) {
    throw new ContractError(unreadable);
  }
  return {
    generatedAt: text(raw["generated_at"], "generated_at"),
    results: list(raw["results"], "results").map((r, i) => parseTarget(r, `results[${i}]`)),
  };
}
