import * as vscode from "vscode";

import type { Finding } from "../core/contract";
import { plain } from "../core/text";
import { findingRange, findingUri } from "./diagnostics";
import type { FolderState, Model } from "./model";
import { findingMessage, VERDICT_ICON, VERDICT_LABEL } from "./present";

type Node =
  | { kind: "folder"; state: FolderState }
  | { kind: "reason"; text: string }
  | { kind: "finding"; target: string; finding: Finding; advisory: boolean }
  | { kind: "notes"; notes: string[] }
  | { kind: "note"; text: string };

const FINDING_ICON = {
  confirmed: new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground")),
  heuristic: new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground")),
  residue: new vscode.ThemeIcon("info"),
  informational: new vscode.ThemeIcon("lightbulb"),
} as const;

export class FindingsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly model: Model) {
    this.subscription = model.onDidChange(() => this.changed.fire());
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.model.states().map((state) => ({ kind: "folder", state }));
    }
    if (node.kind === "notes") {
      return node.notes.map((text) => ({ kind: "note", text }));
    }
    if (node.kind !== "folder" || !node.state.last) {
      return [];
    }
    const last = node.state.last;
    const children: Node[] = last.reasons.map((text) => ({ kind: "reason", text }));
    if (last.kind === "scanned") {
      const notes: string[] = [];
      for (const result of last.payload.results) {
        for (const finding of [...result.findings, ...result.informational]) {
          children.push({ kind: "finding", target: result.target, finding, advisory: false });
        }
        for (const finding of result.advisories) {
          children.push({ kind: "finding", target: result.target, finding, advisory: true });
        }
        notes.push(...result.notes);
      }
      if (notes.length) {
        children.push({ kind: "notes", notes });
      }
    }
    return children;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "folder": {
        const { state } = node;
        const item = new vscode.TreeItem(state.folder.name, vscode.TreeItemCollapsibleState.Expanded);
        if (state.scanning) {
          item.description = "scanning…";
          item.iconPath = new vscode.ThemeIcon("sync~spin");
        } else if (state.last) {
          item.description = VERDICT_LABEL[state.last.verdict];
          item.iconPath = VERDICT_ICON[state.last.verdict];
        } else {
          item.description = "not scanned";
        }
        if (state.last?.kind === "scanned" && state.last.verdict === "clean") {
          item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        }
        item.tooltip = state.folder.uri.fsPath;
        return item;
      }
      case "reason": {
        const item = new vscode.TreeItem(plain(node.text, 300));
        item.iconPath = new vscode.ThemeIcon("circle-slash");
        item.tooltip = plain(node.text, 2000);
        return item;
      }
      case "finding": {
        const { finding } = node;
        const item = new vscode.TreeItem(findingMessage(finding));
        item.description = plain(finding.line ? `${finding.path}:${finding.line}` : finding.path, 200);
        item.iconPath = node.advisory ? new vscode.ThemeIcon("package") : FINDING_ICON[finding.confidence];
        item.tooltip = `${finding.signatureId} · ${finding.confidence} · ${finding.severity}${node.advisory ? " · advisory" : ""}`;
        const uri = findingUri(node.target, finding);
        if (uri) {
          item.command = {
            command: "vscode.open",
            title: "Open",
            arguments: [uri, { selection: findingRange(finding) } satisfies vscode.TextDocumentShowOptions],
          };
        }
        return item;
      }
      case "notes": {
        const item = new vscode.TreeItem(`Coverage notes (${node.notes.length})`, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon("note");
        return item;
      }
      case "note": {
        const item = new vscode.TreeItem(plain(node.text, 300));
        item.tooltip = plain(node.text, 2000);
        return item;
      }
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
