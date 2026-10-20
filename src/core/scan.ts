import { ContractError, parsePayload, type ScanPayload } from "./contract";
import { PROGRESS_ARGS, ProgressLines, withoutEvents, type Progress } from "./progress";
import { runProgram } from "./run";
import { judge, type FolderVerdict } from "./verdict";

export interface ScanRequest {
  binary: string;
  /** Absolute path of the folder to scan. Always the whole folder: saw judges a file by where it sits. */
  folder: string;
  configPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Where saw is, from a saw with `--progress=jsonl`; `null` once it is done. Without this, no progress is asked for. */
  onProgress?: (progress: Progress | null) => void;
}

export type ScanOutcome =
  | {
      kind: "scanned";
      verdict: FolderVerdict;
      reasons: string[];
      payload: ScanPayload;
      durationMs: number;
    }
  | {
      kind: "failed";
      verdict: "incomplete";
      reasons: string[];
      durationMs: number;
    }
  | { kind: "cancelled" };

export function scanArgs(folder: string, configPath: string, progress = false): string[] {
  const args = ["scan", folder, "--json", "--no-stream", ...(progress ? PROGRESS_ARGS : [])];
  if (configPath.trim()) {
    args.push("--config", configPath.trim());
  }
  return args;
}

function lastLines(text: string, count: number): string {
  return text.trim().split(/\r?\n/).slice(-count).join("\n");
}

export async function scanFolder(request: ScanRequest): Promise<ScanOutcome> {
  const started = Date.now();
  const progress = request.onProgress && new ProgressLines(request.onProgress);
  const run = await runProgram(request.binary, scanArgs(request.folder, request.configPath, !!progress), {
    timeoutMs: request.timeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(progress ? { onOutput: (text: string, stream: "stdout" | "stderr") => stream === "stderr" && progress.feed(text) } : {}),
  });
  progress?.end();
  request.onProgress?.(null);
  const durationMs = Date.now() - started;
  if (run.cancelled) {
    return { kind: "cancelled" };
  }
  const failed = (reason: string): ScanOutcome => ({ kind: "failed", verdict: "incomplete", reasons: [reason], durationMs });
  if (run.spawnError) {
    return failed(`saw could not be started: ${run.spawnError}`);
  }
  if (run.timedOut) {
    return failed(`the scan did not finish within ${Math.round(request.timeoutMs / 1000)}s and was stopped`);
  }
  if (run.overflowed) {
    return failed("the report was too large to read");
  }
  let payload: ScanPayload;
  try {
    payload = parsePayload(run.stdout);
  } catch (error) {
    const why = error instanceof ContractError ? error.message : String(error);
    const said = lastLines(progress ? withoutEvents(run.stderr) : run.stderr, 3);
    return failed(said ? `${why}. saw said: ${said}` : why);
  }
  const { verdict, reasons } = judge(payload, run.exitCode);
  return { kind: "scanned", verdict, reasons, payload, durationMs };
}
