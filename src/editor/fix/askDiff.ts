import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import type { AskFile, AskQuestion } from "../../core/fix/ask";
import { plain } from "../../core/text";
import { uriAt } from "./changes";

const SCHEME = "saw-ask";
/** A preview larger than this is described, not loaded into the editor. */
const PREVIEW_LIMIT = 1024 * 1024;

const docs = new Map<string, Uint8Array>();
const changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
let sequence = 0;

const provider: vscode.FileSystemProvider = {
  onDidChangeFile: changed.event,
  watch: () => new vscode.Disposable(() => undefined),
  stat: (uri) => {
    const data = docs.get(uri.toString());
    if (!data) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: data.byteLength };
  },
  readDirectory: () => [],
  createDirectory: () => {
    throw vscode.FileSystemError.NoPermissions();
  },
  readFile: (uri) => {
    const data = docs.get(uri.toString());
    if (!data) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return data;
  },
  writeFile: () => {
    throw vscode.FileSystemError.NoPermissions();
  },
  delete: () => {
    throw vscode.FileSystemError.NoPermissions();
  },
  rename: () => {
    throw vscode.FileSystemError.NoPermissions();
  },
};

export function registerAskDocuments(): vscode.Disposable {
  return vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isReadonly: true, isCaseSensitive: true });
}

function document(name: string, content: string): vscode.Uri {
  const safe = name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";
  const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${++sequence}/${safe}` });
  docs.set(uri.toString(), Buffer.from(content, "utf8"));
  changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  return uri;
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function fileInFolder(folder: vscode.WorkspaceFolder, relativePath: string): string | undefined {
  const root = path.resolve(folder.uri.fsPath);
  const full = path.resolve(root, ...relativePath.split(/[/\\]/).filter(Boolean));
  return contained(root, full) ? full : undefined;
}

async function preview(filePath: string): Promise<string | undefined> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > PREVIEW_LIMIT) {
      return undefined;
    }
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function hashed(filePath: string): Promise<string | undefined> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > PREVIEW_LIMIT) {
      return undefined;
    }
    const bytes = await readFile(filePath);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return undefined;
  }
}

/** The bytes saw read, or a note when they must not be shown. */
async function sawRead(folder: vscode.WorkspaceFolder, question: AskFile): Promise<vscode.Uri> {
  const name = path.basename(question.path);
  if (question.withheld) {
    return document(name, "saw is not showing the contents of this file. Decide from the finding.");
  }
  const full = fileInFolder(folder, question.path);
  if (!full || !question.sha256) {
    return document(name, "saw did not identify the bytes it read, so the file is not shown.");
  }
  const hash = await hashed(full);
  if (!hash) {
    return document(name, "This file is too large or could not be read, so it is not shown.");
  }
  if (hash.toLowerCase() !== question.sha256.toLowerCase()) {
    return document(name, "The file on disk is not the copy saw read, so it is not shown.");
  }
  const text = await preview(full);
  return document(name, text ?? "This file could not be read as text, so it is not shown.");
}

async function openPair(title: string, left: vscode.Uri, right: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("vscode.diff", left, right, plain(title, 200), { preview: true });
}

async function openMany(title: string, resources: [vscode.Uri, vscode.Uri, vscode.Uri][]): Promise<void> {
  if (!resources.length) {
    return;
  }
  await vscode.commands.executeCommand("vscode.changes", plain(title, 200), resources);
}

/** Open the diff for the question saw is waiting on. */
export async function openAsk(folder: vscode.WorkspaceFolder, question: AskQuestion): Promise<void> {
  try {
    if (question.kind === "delivery") {
      await openDelivery(folder, question.commit, question.subject, [...question.removing, ...question.files.map((file) => file.path), ...question.changed]);
      return;
    }
    if (question.kind === "package") {
      const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
      for (const manifest of question.manifests) {
        if (manifest.proposed === undefined) {
          continue;
        }
        const full = fileInFolder(folder, manifest.path);
        const current = full ? await preview(full) : undefined;
        if (current === undefined) {
          continue;
        }
        const name = path.basename(manifest.path);
        const left = document(name, current);
        const right = document(name, manifest.proposed);
        resources.push([right, left, right]);
      }
      await openMany(`${question.name}: manifest as it is ↔ with the package removed`, resources);
      return;
    }
    const right = await sawRead(folder, question);
    const title = `${question.confirmed ? "saw confirmed this file" : "saw is unsure about this file"}: ${question.path}`;
    if (question.restore) {
      const left = await uriAt(folder, question.path, question.restore.commit);
      if (left) {
        await openPair(`Clean version from ${question.restore.commit.slice(0, 12)} ↔ In the folder now — ${title}`, left, right);
        return;
      }
    }
    await vscode.window.showTextDocument(right, { preview: true });
  } catch {
    // The Decide view still lists the question when the diff cannot be opened.
  }
}

/** The files the operator ticked, shown as deletions before they confirm. */
export async function openTakeOut(folder: vscode.WorkspaceFolder, commit: string, paths: readonly string[]): Promise<void> {
  try {
    const empty = document("empty", "");
    const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
    for (const relative of paths) {
      const at = await uriAt(folder, relative, commit);
      if (!at) {
        continue;
      }
      const file = vscode.Uri.joinPath(folder.uri, ...relative.split(/[/\\]/).filter(Boolean));
      resources.push([file, at, empty]);
    }
    await openMany(`Take out of ${commit.slice(0, 12)}`, resources);
  } catch {
    // The confirmation stays in the Decide view.
  }
}

/** The operator's replacement beside the copy saw read. */
export async function openSupply(folder: vscode.WorkspaceFolder, question: AskFile, replacement: string): Promise<void> {
  try {
    const inside = contained(path.resolve(folder.uri.fsPath), path.resolve(replacement));
    const theirs = await preview(replacement);
    const left = document(path.basename(replacement), theirs ?? "This file is too large or could not be read as text, so it is not shown.");
    const right = await sawRead(folder, question);
    const where = inside ? `Your file is inside ${folder.name}, which saw is fixing` : "Your file";
    await openPair(`${where} ↔ In the folder now`, left, right);
  } catch {
    // Supply can still be confirmed from the Decide view.
  }
}

async function openDelivery(folder: vscode.WorkspaceFolder, commit: string, subject: string, paths: string[]): Promise<void> {
  const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
  const seen = new Set<string>();
  for (const relative of paths) {
    if (seen.has(relative)) {
      continue;
    }
    seen.add(relative);
    const right = await uriAt(folder, relative, commit);
    const left = await uriAt(folder, relative, `${commit}^`);
    if (!right || !left) {
      continue;
    }
    const file = vscode.Uri.joinPath(folder.uri, ...relative.split(/[/\\]/).filter(Boolean));
    resources.push([file, left, right]);
  }
  const short = commit.slice(0, 12);
  await openMany(subject ? `${short} — ${subject}` : short, resources);
}
