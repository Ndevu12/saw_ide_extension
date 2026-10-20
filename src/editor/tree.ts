import * as vscode from "vscode";

import type { Finding } from "../core/contract";
import { plain } from "../core/text";
import { findingRange, findingUri } from "./diagnostics";
import type { FolderState, Model } from "./model";
import { findingMessage, VERDICT_ICON, VERDICT_LABEL } from "./present";

type Node =
  | { kind: "machine" }
  | { kind: "audit" }
  | { kind: "hooks" }
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
      return [...this.model.states().map((state): Node => ({ kind: "folder", state })), { kind: "machine" }];
    }
    if (node.kind === "machine") {
      return [{ kind: "audit" }, { kind: "hooks" }];
    }
    if (node.kind === "hooks") {
      const hooks = this.model.machine.hooks;
      return hooks?.kind === "installed" ? hooks.problems.map((text) => ({ kind: "note", text })) : [];
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
      case "machine": {
        const item = new vscode.TreeItem("This machine", vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon("device-desktop");
        return item;
      }
      case "audit":
        return this.auditItem();
      case "hooks":
        return this.hooksItem();
      case "folder": {
        const { state } = node;
        const item = new vscode.TreeItem(state.folder.name, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = state.last?.verdict === "infected" && !state.fixing ? "folder.infected" : "folder";
        if (state.fixing) {
          item.description = "fixing…";
          item.iconPath = new vscode.ThemeIcon("sync~spin");
        } else if (state.scanning) {
          item.description = state.progress ? `scanning: ${state.progress}` : "scanning…";
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

  private auditItem(): vscode.TreeItem {
    const { audit, auditing, auditProgress } = this.model.machine;
    const item = new vscode.TreeItem("Changing credentials");
    item.contextValue = "audit";
    item.command = { command: "saw.auditMachine", title: "Audit This Machine" };
    if (auditing) {
      item.description = auditProgress ? `auditing: ${auditProgress}` : "auditing…";
      item.iconPath = new vscode.ThemeIcon("sync~spin");
      return item;
    }
    if (!audit) {
      item.description = "not audited yet";
      item.iconPath = new vscode.ThemeIcon("circle-outline");
      item.tooltip = "Run saw audit before you change any password or token: changing them first can set off code that deletes your files.";
      return item;
    }
    const looks = {
      "no-hazard": { text: "no hazard found", icon: new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")) },
      "to-confirm": { text: "safe once you confirm saw's items", icon: new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground")) },
      "rotation-unsafe": { text: "do not change them yet", icon: new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground")) },
      incomplete: { text: "not known to be safe", icon: new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground")) },
      failed: { text: "audit did not finish", icon: new vscode.ThemeIcon("circle-slash") },
    }[audit.verdict];
    item.description = looks.text;
    item.iconPath = looks.icon;
    item.tooltip = `${audit.sentence ? `${plain(audit.sentence, 600)}\n` : ""}Audited ${new Date(audit.at).toLocaleString()}. Click to audit again.`;
    return item;
  }

  private hooksItem(): vscode.TreeItem {
    const hooks = this.model.machine.hooks;
    const item = new vscode.TreeItem("Scan-on-clone hooks");
    item.contextValue = "hooks";
    if (!hooks) {
      item.description = "checking…";
      return item;
    }
    switch (hooks.kind) {
      case "installed":
        if (hooks.problems.length) {
          item.description = "need repair";
          item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
          item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
          item.command = { command: "saw.repairHooks", title: "Repair" };
        } else {
          item.description = "in place";
          item.iconPath = new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
          item.tooltip = `Clones, pulls and branch switches are scanned (${hooks.events.join(", ")}).`;
        }
        return item;
      case "not-installed":
        item.description = "not installed — click to install";
        item.iconPath = new vscode.ThemeIcon("circle-outline");
        item.tooltip = "saw can scan every repository as it is cloned, pulled or switched, before anything in it runs.";
        item.command = { command: "saw.installHooks", title: "Install" };
        return item;
      case "unknown":
        item.description = "unknown";
        item.iconPath = new vscode.ThemeIcon("question");
        item.tooltip = plain(hooks.detail, 600);
        return item;
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
