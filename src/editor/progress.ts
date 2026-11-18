import * as vscode from "vscode";

export type Report = vscode.Progress<{ message?: string }>;

/** A notification with Cancel, which aborts `signal`. */
export function withCancellableProgress<T>(title: string, work: (progress: Report, signal: AbortSignal) => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());
    return work(progress, abort.signal);
  });
}
