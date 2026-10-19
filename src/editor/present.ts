import * as vscode from "vscode";

import type { Confidence, Finding } from "../core/contract";
import { plain } from "../core/text";
import type { FolderVerdict } from "../core/verdict";

export const VERDICT_LABEL: Record<FolderVerdict, string> = {
  clean: "clean",
  residue: "residue",
  suspicious: "suspicious",
  incomplete: "could not scan",
  infected: "infected",
};

export const VERDICT_ICON: Record<FolderVerdict, vscode.ThemeIcon> = {
  clean: new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")),
  residue: new vscode.ThemeIcon("info"),
  suspicious: new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground")),
  incomplete: new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("problemsWarningIcon.foreground")),
  infected: new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground")),
};

export const CONFIDENCE_SEVERITY: Record<Confidence, vscode.DiagnosticSeverity> = {
  confirmed: vscode.DiagnosticSeverity.Error,
  heuristic: vscode.DiagnosticSeverity.Warning,
  residue: vscode.DiagnosticSeverity.Information,
  informational: vscode.DiagnosticSeverity.Hint,
};

/** One line describing a finding. Evidence is bytes from the scanned file, so it is shown as plain text only. */
export function findingMessage(finding: Finding): string {
  const description = plain(finding.description, 400);
  const evidence = finding.evidence ? plain(finding.evidence, 120) : "";
  return evidence && !description.includes(evidence) ? `${description} — ${evidence}` : description;
}
