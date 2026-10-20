import { runProgram } from "./run";

// What the installed saw can do, from `saw capabilities --json` (stayawakebot#1815). A saw without
// that command reads as having none of the features below, and the extension uses what every saw
// it supports has.

export const FEATURES = {
  fixJson: "fix.json",
  auditJson: "audit.json",
  hookStatusJson: "hook.status.json",
  progress: "progress.jsonl",
  mcp: "mcp",
} as const;
export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

/** The newest `schema_version` of each document this extension reads. A newer one means a breaking change it does not know. */
export const KNOWN_SCHEMAS = { scan: 1, fix: 2, audit: 1, "hook-status": 1 } as const;
export type Document = keyof typeof KNOWN_SCHEMAS;

export interface Capabilities {
  features: ReadonlySet<string>;
  /** The `schema_version` saw says it writes for each document, when it says. */
  schemas: Readonly<Record<string, number>>;
}

export const NO_CAPABILITIES: Capabilities = { features: new Set(), schemas: {} };

export const CAPABILITIES_ARGS = ["capabilities", "--json"] as const;

export function readCapabilities(stdout: string, exitCode: number | null): Capabilities {
  if (exitCode !== 0) {
    return NO_CAPABILITIES;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return NO_CAPABILITIES;
  }
  const record = (parsed ?? {}) as { features?: unknown; schema_versions?: unknown };
  const features = Array.isArray(record.features) ? record.features.filter((f): f is string => typeof f === "string") : [];
  const schemas: Record<string, number> = {};
  if (record.schema_versions && typeof record.schema_versions === "object") {
    for (const [name, version] of Object.entries(record.schema_versions)) {
      if (Number.isInteger(version)) {
        schemas[name] = version as number;
      }
    }
  }
  return { features: new Set(features), schemas };
}

export async function probeCapabilities(binary: string, timeoutMs = 10_000): Promise<Capabilities> {
  const run = await runProgram(binary, CAPABILITIES_ARGS, { timeoutMs, maxOutputBytes: 64 * 1024 });
  return readCapabilities(run.stdout, run.exitCode);
}

/**
 * Whether saw has a feature in a shape this extension reads. A feature whose document saw writes in
 * a newer schema than the extension knows is treated as missing, so the older reading is used.
 */
export function supports(capabilities: Capabilities, feature: Feature, document?: Document): boolean {
  if (!capabilities.features.has(feature)) {
    return false;
  }
  if (document === undefined) {
    return true;
  }
  const schema = capabilities.schemas[document];
  return schema === undefined || schema <= KNOWN_SCHEMAS[document];
}

/**
 * Why a JSON document from saw cannot be read: undefined when its `schema_version` is absent or one
 * this extension knows.
 */
export function schemaProblem(document: Document, parsed: unknown): string | undefined {
  const version = (parsed as { schema_version?: unknown } | null)?.schema_version;
  if (version === undefined) {
    return undefined;
  }
  if (!Number.isInteger(version) || (version as number) < 1) {
    return `saw wrote a ${document} report with an invalid schema_version`;
  }
  if ((version as number) > KNOWN_SCHEMAS[document]) {
    return `saw wrote a newer ${document} report (schema ${version}) than this extension reads (schema ${KNOWN_SCHEMAS[document]}): update the extension`;
  }
  return undefined;
}
