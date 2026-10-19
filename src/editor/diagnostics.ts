import * as path from "node:path";

import * as vscode from "vscode";

import type { Finding, TargetResult } from "../core/contract";
import { CONFIDENCE_SEVERITY, findingMessage } from "./present";
import type { Settled } from "./model";

export function findingUri(target: string, finding: Finding): vscode.Uri | undefined {
  const file = path.resolve(target, finding.path);
  const relative = path.relative(target, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return vscode.Uri.file(file);
}

export function findingRange(finding: Finding): vscode.Range {
  const line = finding.line ? finding.line - 1 : 0;
  return new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
}

function toDiagnostic(finding: Finding, advisory: boolean): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    findingRange(finding),
    findingMessage(finding),
    advisory ? vscode.DiagnosticSeverity.Information : CONFIDENCE_SEVERITY[finding.confidence],
  );
  diagnostic.source = advisory ? "saw (advisory)" : "saw";
  diagnostic.code = finding.signatureId;
  return diagnostic;
}

function* everyFinding(result: TargetResult): Generator<[Finding, boolean]> {
  for (const finding of result.findings) yield [finding, false];
  for (const finding of result.informational) yield [finding, false];
  for (const finding of result.advisories) yield [finding, true];
}

/** Puts each folder's findings in the Problems panel, replacing whatever that folder showed before. */
export class Diagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("saw");
  private readonly owned = new Map<string, vscode.Uri[]>();

  constructor(private readonly log: vscode.LogOutputChannel) {}

  publish(folder: vscode.WorkspaceFolder, outcome: Settled): void {
    this.clear(folder);
    if (outcome.kind !== "scanned") {
      return;
    }
    const byFile = new Map<string, { uri: vscode.Uri; items: vscode.Diagnostic[] }>();
    for (const result of outcome.payload.results) {
      for (const [finding, advisory] of everyFinding(result)) {
        const uri = findingUri(result.target, finding);
        if (!uri) {
          this.log.warn(`Not shown: ${finding.signatureId} names a path outside ${result.target}.`);
          continue;
        }
        const entry = byFile.get(uri.toString()) ?? { uri, items: [] };
        entry.items.push(toDiagnostic(finding, advisory));
        byFile.set(uri.toString(), entry);
      }
    }
    for (const { uri, items } of byFile.values()) {
      this.collection.set(uri, items);
    }
    this.owned.set(folder.uri.toString(), [...byFile.values()].map((entry) => entry.uri));
  }

  clear(folder: vscode.WorkspaceFolder): void {
    for (const uri of this.owned.get(folder.uri.toString()) ?? []) {
      this.collection.delete(uri);
    }
    this.owned.delete(folder.uri.toString());
  }

  dispose(): void {
    this.collection.dispose();
  }
}
