import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Bytes kept per stream; a report beyond this fails rather than being read partially. */
  maxOutputBytes?: number;
  /** Told the output as it arrives, for a report that follows the run. */
  onOutput?: (text: string, stream: "stdout" | "stderr") => void;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  overflowed: boolean;
  /** Set when the program could not be started at all. */
  spawnError: string | null;
}

const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024;

// saw reads the target it is given, never its working directory, so a neutral one keeps a
// workspace from supplying anything by sitting where the process starts.
const NEUTRAL_CWD = tmpdir();

const QUIET_ENV = {
  NO_COLOR: "1",
  STAYAWAKE_NO_STREAM: "1",
  PYTHONIOENCODING: "utf-8",
};

/** Run `binary` directly (no shell) with `args`, collecting its output. Never rejects. */
export function runProgram(binary: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let overflowed = false;
    let settled = false;

    const child = spawn(binary, [...args], {
      cwd: NEUTRAL_CWD,
      env: { ...process.env, ...QUIET_ENV },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }

    const finish = (exitCode: number | null, spawnError: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        cancelled,
        overflowed,
        spawnError,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > limit) {
        overflowed = true;
        stop();
        return;
      }
      out.push(chunk);
    });
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const tell = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = options.onOutput && decoders[stream].write(chunk);
      if (text) {
        options.onOutput?.(text, stream);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => tell("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      tell("stderr", chunk);
      errBytes += chunk.length;
      if (errBytes <= limit) {
        err.push(chunk);
      }
    });
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code, null));
  });
}
