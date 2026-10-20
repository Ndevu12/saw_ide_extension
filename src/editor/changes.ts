import * as vscode from "vscode";

// The few parts of the built-in Git extension's API (`vscode.git`, API version 1) used here.
interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
}
interface GitRepository {
  readonly rootUri: vscode.Uri;
  diffBetween(ref1: string, ref2: string): Promise<GitChange[]>;
}
interface GitApi {
  readonly repositories: GitRepository[];
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

async function gitApi(): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!extension) {
    return undefined;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports.enabled ? exports.getAPI(1) : undefined;
}

/**
 * Open saw's clean-up as one multi-file diff, `base` against `branch`, through the editor's Git
 * extension. False when that is not possible: no Git extension, Git turned off (as in Restricted
 * Mode), or no repository at the folder.
 */
export async function openFixChanges(folder: vscode.WorkspaceFolder, base: string, branch: string, log: vscode.LogOutputChannel): Promise<boolean> {
  try {
    const git = await gitApi();
    const repository = git?.repositories.find((r) => r.rootUri.fsPath === folder.uri.fsPath);
    if (!git || !repository) {
      return false;
    }
    const changes = await repository.diffBetween(base, branch);
    if (!changes.length) {
      return false;
    }
    const resources = changes.map((change) => [change.uri, git.toGitUri(change.originalUri, base), git.toGitUri(change.uri, branch)]);
    await vscode.commands.executeCommand("vscode.changes", `saw's clean-up: ${base} ↔ ${branch}`, resources);
    return true;
  } catch (error) {
    log.warn(`Could not open saw's clean-up of ${folder.name} as a diff: ${String(error)}`);
    return false;
  }
}
