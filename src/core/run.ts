import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

export interface RunControl {
  /** Write one line to the program's standard input. No-op once it has exited. */
  writeLine(line: string): void;
  /**
   * While held, the timeout does not fire. Time the operator spends deciding is not saw being
   * stuck.
   */
  hold(holding: boolean): void;
}

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Bytes kept per stream; a report beyond this fails rather than being read partially. */
  maxOutputBytes?: number;
  /** Told the output as it arrives, for a report that follows the run. */
  onOutput?: (text: string, stream: "stdout" | "stderr") => void;
  /** Pipe standard input, and hand over the control once the process has started. */
  input?: boolean;
  onReady?: (control: RunControl) => void;
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

export function succeeded(result: RunResult): boolean {
  return result.exitCode === 0 && !result.spawnError && !result.timedOut;
}

/** The last lines a run said, or why it did not run. */
export function lastSaid(result: RunResult, lines = 25): string {
  const text = result.spawnError ?? (result.timedOut ? "timed out" : `${result.stdout}\n${result.stderr}`);
  return text.trim().split(/\r?\n/).slice(-lines).join("\n");
}

const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024;

/** How long a stopped program has to exit before it and everything it started are killed. */
const KILL_GRACE_MS = 3000;

/** How long output may stay open after the program exits. Workers it left behind can hold it open for good. */
const DRAIN_MS = 2000;

// On POSIX the program leads its own process group, so stopping it also stops the workers it started.
const AS_GROUP = process.platform !== "win32";

// saw reads the target it is given, never its working directory, so a neutral one keeps a
// workspace from supplying anything by sitting where the process starts.
const NEUTRAL_CWD = tmpdir();

/** Python reads these before anything else, so they could make a verified saw run other code. */
const PYTHON_OVERRIDES = new Set(["PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT"]);

export function programEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => !PYTHON_OVERRIDES.has(name.toUpperCase()))), ...QUIET_ENV };
}

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
      env: programEnv(process.env),
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: AS_GROUP,
    });

    const signal = (name: NodeJS.Signals) => {
      try {
        if (AS_GROUP && child.pid !== undefined) {
          process.kill(-child.pid, name);
        } else if (child.exitCode === null && child.signalCode === null) {
          child.kill(name);
        }
      } catch {
        // Already gone.
      }
    };
    let stopping = false;
    const stop = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      signal("SIGTERM");
      setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS).unref();
    };
    let holding = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (holding) {
          return;
        }
        timedOut = true;
        stop();
      }, options.timeoutMs);
    };
    arm();
    if (options.input) {
      child.stdin?.on("error", () => undefined);
      options.onReady?.({
        writeLine: (line) => {
          if (child.exitCode !== null || child.stdin?.writable === false) {
            return;
          }
          child.stdin?.write(`${line}\n`);
        },
        hold: (value) => {
          holding = value;
          if (value) {
            clearTimeout(timer);
          } else {
            arm();
          }
        },
      });
    }
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }

    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null, spawnError: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
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

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout && stderr) {
      stdout.on("data", (chunk: Buffer) => {
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
      stdout.on("data", (chunk: Buffer) => tell("stdout", chunk));
      stderr.on("data", (chunk: Buffer) => {
        tell("stderr", chunk);
        errBytes += chunk.length;
        if (errBytes <= limit) {
          err.push(chunk);
        }
      });
    } else {
      finish(null, "could not read saw's output");
    }
    child.on("error", (error) => finish(null, error.message));
    child.on("exit", (code) => {
      drain = setTimeout(() => {
        stdout?.destroy();
        stderr?.destroy();
        finish(code, null);
      }, DRAIN_MS);
    });
    child.on("close", (code) => finish(code, null));
  });
}
