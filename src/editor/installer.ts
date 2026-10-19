import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, homedir, release, tmpdir } from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { diagnose, parseOsRelease, type Diagnosis, type Host } from "../core/diagnose";
import { installSaw, type InstallResult, type Pins, type StepName } from "../core/install";
import { defaultIsExecutableFile, type LocateEnv } from "../core/locate";
import { runProgram } from "../core/run";

export type InstallOutcome =
  | { kind: "installed"; binary: string }
  /** Another editor window was installing; it has finished, so look again. */
  | { kind: "installed-elsewhere" }
  | { kind: "failed"; diagnosis: Diagnosis }
  | { kind: "cancelled" };

const PROGRESS: Record<StepName, (pins: Pins) => string> = {
  "find-python": () => "Finding Python 3.11 or later…",
  "find-pipx": () => "Checking for pipx…",
  "create-venv": () => "pipx is not installed; preparing to install it…",
  "bootstrap-pipx": (pins) => `Downloading pipx ${pins.pipx}…`,
  "install-pipx": (pins) => `Installing pipx ${pins.pipx}…`,
  "install-saw": (pins) => `Installing stayawakebot ${pins.saw} with pipx…`,
  "find-saw": () => "Checking the installed saw…",
};

const LOCK_STALE_MS = 20 * 60_000;
const LOCK_POLL_MS = 2_000;

interface Remembered {
  binary: string;
  binDir: string;
}

export function readPins(context: vscode.ExtensionContext): Pins {
  const pins = (context.extension.packageJSON as { saw?: Partial<Pins> }).saw;
  if (!pins?.saw || !pins.pipx) {
    throw new Error("package.json is missing the saw and pipx versions to install");
  }
  return { saw: pins.saw, pipx: pins.pipx };
}

function host(): Host {
  let distro: string[] = [];
  if (process.platform === "linux") {
    try {
      distro = parseOsRelease(readFileSync("/etc/os-release", "utf8"));
    } catch {
      distro = [];
    }
  }
  return { platform: process.platform, distro };
}

function locateEnv(): LocateEnv {
  return { platform: process.platform, homedir: homedir(), pathVariable: process.env["PATH"], isExecutableFile: defaultIsExecutableFile };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Installs saw with pipx without asking: the operator only hears from it when something needs them. */
export class Installer {
  private lastReport: string | undefined;
  private readonly storage: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly pins: Pins,
  ) {
    this.storage = context.globalStorageUri.fsPath;
    this.context.environmentVariableCollection.description = "Adds the folder pipx installed saw into, so `saw` runs in the terminal.";
  }

  /** The saw this extension installed earlier, in any window, if it is still there. */
  installedBinary(): string | undefined {
    const remembered = this.remembered();
    return remembered && defaultIsExecutableFile(remembered.binary) ? remembered.binary : undefined;
  }

  /** Make `saw` runnable in this editor's terminals when pipx's folder is not on the PATH the editor started with. */
  exposeToTerminals(): void {
    const remembered = this.remembered();
    const onPath = (process.env["PATH"] ?? "").split(path.delimiter).includes(remembered?.binDir ?? "");
    if (remembered && !onPath && defaultIsExecutableFile(remembered.binary)) {
      this.context.environmentVariableCollection.prepend("PATH", remembered.binDir + path.delimiter);
    } else {
      this.context.environmentVariableCollection.delete("PATH");
    }
  }

  diagnostics(): string | undefined {
    return this.lastReport;
  }

  async install(why: string): Promise<InstallOutcome> {
    const lock = await this.acquire();
    try {
      return lock === "waited" ? { kind: "installed-elsewhere" } : await this.installLocked(why);
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  private async installLocked(why: string): Promise<InstallOutcome> {
    this.log.info(`${why} Installing stayawakebot ${this.pins.saw} with pipx.`);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Setting up saw", cancellable: true },
      (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        return installSaw({
          env: locateEnv(),
          run: runProgram,
          makeTempDir: () => mkdtempSync(path.join(tmpdir(), "saw-pipx-")),
          removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
          pins: this.pins,
          signal: abort.signal,
          onStep: (name) => {
            progress.report({ message: PROGRESS[name](this.pins) });
            this.log.info(PROGRESS[name](this.pins));
          },
        });
      },
    );
    for (const step of result.steps) {
      const line = `${step.ok ? "ok" : `failed (${step.exitCode ?? "did not run"})`}: ${step.command}`;
      if (step.ok) {
        this.log.debug(line);
      } else {
        this.log.warn(`${line}\n${step.output}`);
      }
    }
    this.lastReport = this.report(why, result);

    switch (result.kind) {
      case "installed": {
        this.remember({ binary: result.binary, binDir: result.binDir });
        this.exposeToTerminals();
        const pipx = result.installedPipx ? ` pipx was installed first, at ${result.pipx}.` : "";
        this.log.info(`Installed saw at ${result.binary}.${pipx}`);
        void vscode.window.showInformationMessage(`saw ${this.pins.saw} is installed; scanning now.${pipx}`);
        return { kind: "installed", binary: result.binary };
      }
      case "cancelled":
        this.log.warn("Installing saw was cancelled.");
        return { kind: "cancelled" };
      case "failed": {
        const diagnosis = diagnose(result, host(), this.pins);
        this.log.error(`saw could not be installed. ${diagnosis.cause} ${diagnosis.fix}`);
        void this.showFailure(diagnosis);
        return { kind: "failed", diagnosis };
      }
    }
  }

  private async showFailure(diagnosis: Diagnosis): Promise<void> {
    const choice = await vscode.window.showErrorMessage(
      `saw could not be installed, so no folder is scanned. ${diagnosis.cause} ${diagnosis.fix}`,
      "Retry",
      "Copy Diagnostics",
      "Show Log",
    );
    if (choice === "Retry") {
      await vscode.commands.executeCommand("saw.install");
    } else if (choice === "Copy Diagnostics") {
      await vscode.commands.executeCommand("saw.copyDiagnostics");
    } else if (choice === "Show Log") {
      await vscode.commands.executeCommand("saw.showOutput");
    }
  }

  private report(why: string, result: InstallResult): string {
    const extension = (this.context.extension.packageJSON as { version?: string }).version ?? "?";
    const lines = [
      "## saw install diagnostics",
      "",
      `- Outcome: ${result.kind}${result.kind === "failed" ? ` at ${result.failedStep}` : ""}`,
      `- Why: ${why}`,
      `- Extension: ${this.context.extension.id} ${extension}; pins stayawakebot ${this.pins.saw}, pipx ${this.pins.pipx}`,
      `- Editor: ${vscode.env.appName} ${vscode.version}${vscode.env.remoteName ? ` (remote: ${vscode.env.remoteName})` : ""}`,
      `- System: ${process.platform} ${release()} ${arch()}${host().distro.length ? ` (${host().distro.join(", ")})` : ""}`,
      `- PATH: ${process.env["PATH"] ?? ""}`,
    ];
    if (result.kind === "failed" && result.tried.length) {
      lines.push("", "### Python interpreters", "", ...result.tried.map((line) => `- ${line}`));
    }
    lines.push("", "### Steps");
    for (const step of result.steps) {
      lines.push("", `\`${step.command}\` → ${step.ok ? "ok" : `failed (${step.exitCode ?? "did not run"})`}`);
      if (!step.ok && step.output) {
        lines.push("", "```", step.output, "```");
      }
    }
    return lines.join("\n");
  }

  private get lockPath(): string {
    return path.join(this.storage, "install.lock");
  }

  /** One install per machine at a time: another window that is installing is waited for, not raced. */
  private async acquire(): Promise<"held" | "waited"> {
    mkdirSync(this.storage, { recursive: true });
    let waited = false;
    for (;;) {
      try {
        mkdirSync(this.lockPath);
        return waited ? "waited" : "held";
      } catch {
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (!waited) {
          this.log.info("Another editor window is installing saw; waiting for it.");
        }
        waited = true;
        await sleep(LOCK_POLL_MS);
      }
    }
  }

  private remembered(): Remembered | undefined {
    try {
      const value = JSON.parse(readFileSync(path.join(this.storage, "installed.json"), "utf8")) as Partial<Remembered>;
      return typeof value.binary === "string" && typeof value.binDir === "string" ? { binary: value.binary, binDir: value.binDir } : undefined;
    } catch {
      return undefined;
    }
  }

  private remember(value: Remembered): void {
    mkdirSync(this.storage, { recursive: true });
    writeFileSync(path.join(this.storage, "installed.json"), JSON.stringify(value));
  }
}
