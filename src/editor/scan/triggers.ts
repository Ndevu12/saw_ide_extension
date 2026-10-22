import * as vscode from "vscode";

import type { Controller } from "./controller";
import type { Settings } from "../settings";

// Files that make code run on open, install, build or a git operation. A change to one from outside
// the editor — a checkout, a pull, a package install — is scanned without waiting for a save.
const RUNS_CODE = [
  "**/.vscode/**",
  "**/package.json",
  "**/{package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb}",
  "**/.github/workflows/**",
  "**/.git/{config,hooks/**}",
  // A checkout, pull, merge or rebase moves these, changing files that no other pattern names.
  "**/.git/{HEAD,ORIG_HEAD}",
  "**/{.gitattributes,.gitmodules}",
];

export function registerTriggers(controller: Controller, settings: () => Settings): vscode.Disposable[] {
  const onChange = (uri: vscode.Uri) => {
    if (settings().scanOnChange) {
      controller.requestFor(uri);
    }
  };
  const disposables: vscode.Disposable[] = [
    vscode.workspace.onDidSaveTextDocument((document) => onChange(document.uri)),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      event.removed.forEach((folder) => controller.forget(folder));
      if (settings().scanOnStartup) {
        event.added.forEach((folder) => controller.request(folder, { immediate: true }));
      }
    }),
  ];
  for (const pattern of RUNS_CODE) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    disposables.push(
      watcher,
      watcher.onDidCreate(onChange),
      watcher.onDidChange(onChange),
      watcher.onDidDelete(onChange),
    );
  }
  return disposables;
}
