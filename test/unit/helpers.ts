import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export function tempDir(prefix = "saw-ext-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export interface FakeSaw {
  stdout?: string;
  stderr?: string;
  exit?: number;
  sleepMs?: number;
  /** Write the arguments it was given to this file, as JSON. */
  argsFile?: string;
}

/** A stand-in `saw` program: a Node script with a shebang, so POSIX only. */
export function fakeSaw(behaviour: FakeSaw): string {
  const file = path.join(tempDir("fake-saw-"), "saw");
  const script = `#!${process.execPath}
const b = ${JSON.stringify(behaviour)};
if (b.argsFile) require("fs").writeFileSync(b.argsFile, JSON.stringify(process.argv.slice(2)));
setTimeout(() => {
  if (b.stdout) process.stdout.write(b.stdout);
  if (b.stderr) process.stderr.write(b.stderr);
  process.exit(b.exit ?? 0);
}, b.sleepMs ?? 0);
`;
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}

export function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signature_id: "vscode-task-runs-font",
    category: "vscode-autorun",
    severity: "critical",
    path: ".vscode/tasks.json",
    description: "an editor task that runs a disguised payload",
    remediation: "remove-foreign-vscode",
    line: null,
    evidence: "node .vscode/a.woff2",
    confidence: "confirmed",
    advisory_only: false,
    ...overrides,
  };
}

export function report(results: Record<string, unknown>[]): string {
  return JSON.stringify({ generated_at: "2026-10-19T00:00:00Z", summary: {}, results });
}

export function target(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target: "/work/repo",
    source: "local",
    verdict: "clean",
    error: null,
    findings: [],
    advisories: [],
    notes: [],
    ...overrides,
  };
}

export const onWindows = process.platform === "win32";

// A task that runs a file disguised as a font when the folder opens: the shape saw confirms on its own.
export const DISGUISED_TASK = JSON.stringify({
  version: "2.0.0",
  tasks: [{ label: "x", type: "shell", command: "node .vscode/a.woff2", runOptions: { runOn: "folderOpen" } }],
});
