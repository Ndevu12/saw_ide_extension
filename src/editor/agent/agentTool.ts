import * as path from "node:path";

import * as vscode from "vscode";

import { agentReport, type AgentFolder } from "../../core/agent/agent";
import type { Controller } from "../scan/controller";
import type { Engine } from "../install/engine";
import type { FolderState, Model } from "../model";
import type { Settings } from "../settings";

export const FOLDER_VERDICT_TOOL = "saw_folderVerdict";

/** How long past one scan's own time limit an agent waits, for an install or a queued scan. */
const WAIT_SLACK_MS = 60_000;

export interface FolderVerdictInput {
  folder?: string;
}

/** Workspace folders an agent named by folder name or by a path inside one; every folder when it named none. */
function pick(folder: string | undefined): vscode.WorkspaceFolder[] | string {
  const open = vscode.workspace.workspaceFolders ?? [];
  const wanted = folder?.trim();
  if (!wanted) {
    return [...open];
  }
  const byName = open.find((f) => f.name === wanted);
  if (byName) {
    return [byName];
  }
  const candidates = path.isAbsolute(wanted) ? [wanted] : open.map((f) => path.join(f.uri.fsPath, wanted));
  for (const candidate of candidates) {
    const found = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(candidate));
    if (found) {
      return [found];
    }
  }
  return `"${wanted}" is not inside a workspace folder; saw only reports on the folders open in this window`;
}

/**
 * A read-only tool for AI agents: saw's verdict on a workspace folder, from a scan that covers the
 * latest change. It never fixes, audits or installs hooks, and nothing from the folder runs.
 */
export class FolderVerdictTool implements vscode.LanguageModelTool<FolderVerdictInput> {
  constructor(
    private readonly model: Model,
    private readonly controller: Controller,
    private readonly settings: () => Settings,
  ) {}

  prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FolderVerdictInput>): vscode.PreparedToolInvocation {
    const folder = options.input.folder?.trim();
    return { invocationMessage: folder ? `Asking saw about ${folder}` : "Asking saw about the workspace folders" };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FolderVerdictInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const picked = pick(options.input.folder);
    const folders: AgentFolder[] =
      typeof picked === "string"
        ? [{ name: options.input.folder ?? "", path: options.input.folder ?? "", verdict: undefined, problem: picked, reasons: [], findings: [] }]
        : await Promise.all(picked.map((folder) => this.report(folder, token)));
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(agentReport(folders))]);
  }

  private async report(folder: vscode.WorkspaceFolder, token: vscode.CancellationToken): Promise<AgentFolder> {
    const base = { name: folder.name, path: folder.uri.fsPath, reasons: [], findings: [] };
    if (folder.uri.scheme !== "file") {
      return { ...base, path: folder.uri.toString(), verdict: undefined, problem: "saw only scans folders on disk." };
    }
    const stop = new AbortController();
    const cancelled = token.onCancellationRequested(() => stop.abort());
    const timer = setTimeout(() => stop.abort(), this.settings().timeoutMs + WAIT_SLACK_MS);
    let state: FolderState;
    try {
      state = await this.controller.settled(folder, stop.signal);
    } finally {
      clearTimeout(timer);
      cancelled.dispose();
    }
    return describeFolder(state, this.model.engine, stop.signal.aborted);
  }
}

/** What an agent is told about a folder from its state now; `waited` when a wait for its scan ran out. */
export function describeFolder(state: FolderState, engine: Engine | undefined, waited = false): AgentFolder {
  const folder = state.folder;
  const base = { name: folder.name, path: folder.uri.fsPath, reasons: [], findings: [] };
  const busy = state.scanning || state.fixing || waited;
  const last = state.last;
  if (!last || busy) {
    return { ...base, verdict: undefined, problem: why(state, busy, engine) };
  }
  if (last.kind === "failed") {
    return { ...base, verdict: last.verdict, reasons: last.reasons };
  }
  return {
    ...base,
    verdict: last.verdict,
    scannedAt: last.payload.generatedAt,
    reasons: last.reasons,
    findings: last.payload.results.flatMap((result) => result.findings),
  };
}

function why(state: FolderState, busy: boolean, engine: Engine | undefined): string {
  if (state.fixing) {
    return "saw is fixing this folder right now.";
  }
  if (busy) {
    return "saw has not finished scanning the latest changes yet.";
  }
  if (engine?.kind === "unavailable") {
    return `saw cannot run: ${engine.message}`;
  }
  return "saw has no verdict for it yet.";
}
