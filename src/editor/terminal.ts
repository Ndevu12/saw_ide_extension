import * as vscode from "vscode";

import { runProgram, type RunResult } from "../core/run";
import { forTerminal } from "../core/text";

export interface TerminalRun {
  terminal: vscode.Terminal;
  /** Settles when saw exits, or when the operator closes the terminal and so stops it. */
  result: Promise<RunResult>;
}

export interface TerminalOptions {
  /** Which of saw's streams the operator reads; the rest is collected only. */
  show: ReadonlyArray<"stdout" | "stderr">;
  timeoutMs: number;
}

/**
 * Run saw in a terminal of its own, without a shell, so the operator watches its report as it comes.
 * The terminal stays open afterwards, so the report can be read until it is closed.
 */
export function runInTerminal(name: string, binary: string, args: readonly string[], options: TerminalOptions): TerminalRun {
  const emitter = new vscode.EventEmitter<string>();
  const abort = new AbortController();
  // saw starts at once; what it says before the editor opens the terminal is held until it does.
  let held: string[] | undefined = [];
  const write = (text: string) => {
    const safe = forTerminal(text);
    if (held) {
      held.push(safe);
    } else {
      emitter.fire(safe);
    }
  };

  const pty: vscode.Pseudoterminal = {
    onDidWrite: emitter.event,
    open: () => {
      const pending = held ?? [];
      held = undefined;
      pending.forEach((text) => emitter.fire(text));
    },
    close: () => {
      abort.abort();
      emitter.dispose();
    },
  };
  const terminal = vscode.window.createTerminal({ name, pty, iconPath: new vscode.ThemeIcon("shield") });
  terminal.show();

  const result = (async () => {
    write(`$ saw ${args.join(" ")}\n\n`);
    const run = await runProgram(binary, args, {
      timeoutMs: options.timeoutMs,
      signal: abort.signal,
      onOutput: (text, stream) => {
        if (options.show.includes(stream)) {
          write(text);
        }
      },
    });
    const ending = run.cancelled
      ? "Stopped."
      : run.timedOut
        ? `Stopped: saw did not finish within ${Math.round(options.timeoutMs / 1000)} s.`
        : run.spawnError
          ? `saw could not be started: ${run.spawnError}`
          : "saw has finished. Close this terminal when you have read the report.";
    if (!run.cancelled) {
      write(`\n${ending}\n`);
    }
    return run;
  })();
  return { terminal, result };
}
