import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { arch, homedir, release as osRelease, tmpdir } from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { diagnose, lacksPackage, parseOsRelease, reportUrl, type Diagnosis, type Host } from "../../core/install/diagnose";
import { installSaw, type InstallResult, type Pins, type StepName } from "../../core/install/install";
import { defaultIsExecutableFile, type LocateEnv } from "../../core/install/locate";
import { machineName, readRelease, type Release } from "../../core/install/platform";
import { runProgram } from "../../core/run";
import { atLeast, parseRelease } from "../../core/version";

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
  /** `update`: a release the channel approved, installed beside the others by the updater. */
  via?: "pipx" | "update";
  version?: string;
  /** The saw that ran before an update, kept so the person can go back to it. */
  previous?: Remembered;
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
  if (process.platform !== "linux") {
    return { platform: process.platform, arch: process.arch, distro };
  }
  try {
    distro = parseOsRelease(readFileSync("/etc/os-release", "utf8"));
  } catch {
    distro = [];
  }
  let header: { glibcVersionRuntime?: string } | undefined;
  try {
    header = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header;
  } catch {
    return { platform: process.platform, arch: process.arch, distro };
  }
  // Node reports glibcVersionRuntime on glibc Linux only.
  return header?.glibcVersionRuntime
    ? { platform: process.platform, arch: process.arch, glibc: header.glibcVersionRuntime, distro }
    : { platform: process.platform, arch: process.arch, musl: true, distro };
}

/** What PyPI lists for the pinned release. Undefined when PyPI does not answer, so pip's own output is used. */
async function pypiRelease(version: string): Promise<Release | undefined> {
  try {
    const response = await fetch(`https://pypi.org/pypi/stayawakebot/${encodeURIComponent(version)}/json`, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) {
      return { kind: "unpublished" };
    }
    return response.ok ? readRelease(await response.text()) : undefined;
  } catch {
    return undefined;
  }
}

/** A machine no package of the pinned release fits is asked again after a day, since the release can gain one. */
const UNSUPPORTED_RECHECK_MS = 24 * 60 * 60_000;
const UNSUPPORTED_KEY = "install.unsupported";

interface Unsupported {
  pin: string;
  machine: string;
  at: number;
  cause: string;
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

  /** The release to run: the one this extension pins, or a newer one the updater installed. */
  get pinnedSaw(): string {
    const updated = this.remembered();
    const version = updated?.via === "update" && updated.version ? parseRelease(updated.version) : null;
    return updated && version && atLeast(version, this.pins.saw) && defaultIsExecutableFile(updated.binary) ? (updated.version ?? this.pins.saw) : this.pins.saw;
  }

  /** The release this extension itself pins, whatever the updater installed since. */
  get packagedSaw(): string {
    return this.pins.saw;
  }

  /** Where the updater puts each version, beside the others. */
  get updateRoot(): string {
    return path.join(this.storage, "saw");
  }

  /** The saw that ran before the last update, when it is still there. */
  previousVersion(): string | undefined {
    const previous = this.remembered()?.previous;
    return previous && defaultIsExecutableFile(previous.binary) ? (previous.version ?? "the earlier version") : undefined;
  }

  /** Run `work` while no other window installs or updates saw. */
  async exclusive<T>(work: () => Promise<T>): Promise<T | "busy"> {
    if ((await this.acquire()) === "waited") {
      rmSync(this.lockPath, { recursive: true, force: true });
      return "busy";
    }
    try {
      return await work();
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  /** Switch to a saw the updater installed and checked. The one before is kept to go back to; older ones are removed. */
  adopt(binary: string, version: string): void {
    const current = this.remembered();
    const previous = current && defaultIsExecutableFile(current.binary) ? { binary: current.binary, binDir: current.binDir, ...(current.via ? { via: current.via } : {}), ...(current.version ? { version: current.version } : {}) } : undefined;
    const binDir = this.linkTo(binary);
    this.remember({ binary, binDir, via: "update", version, ...(previous ? { previous } : {}) });
    this.exposeToTerminals();
    this.prune([binary, previous?.binary ?? ""]);
  }

  /** Go back to the saw that ran before the last update. Returns its version, or undefined when there is none. */
  restorePrevious(): string | undefined {
    const previous = this.remembered()?.previous;
    if (!previous || !defaultIsExecutableFile(previous.binary)) {
      return undefined;
    }
    const binDir = previous.via === "update" ? this.linkTo(previous.binary) : previous.binDir;
    this.remember({ ...previous, binDir });
    this.exposeToTerminals();
    return previous.version ?? "the earlier version";
  }

  /** A folder holding only `saw`, for terminals: a version's own folder also holds its Python and pip. */
  private linkTo(binary: string): string {
    const dir = path.join(this.updateRoot, "bin");
    mkdirSync(dir, { recursive: true });
    if (process.platform === "win32") {
      writeFileSync(path.join(dir, "saw.cmd"), `@"${binary}" %*\r\n`);
    } else {
      const link = path.join(dir, "saw");
      const temporary = `${link}.${process.pid}.tmp`;
      rmSync(temporary, { force: true });
      symlinkSync(binary, temporary);
      renameSync(temporary, link);
    }
    return dir;
  }

  private prune(keep: readonly string[]): void {
    const versions = path.join(this.updateRoot, "versions");
    let names: string[];
    try {
      names = readdirSync(versions);
    } catch {
      return;
    }
    for (const name of names) {
      const dir = path.join(versions, name);
      if (!keep.some((binary) => binary.startsWith(dir + path.sep))) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  /** The saw this extension installed earlier, in any window, if it is still there. */
  installedBinary(): string | undefined {
    const remembered = this.remembered();
    return remembered && defaultIsExecutableFile(remembered.binary) ? remembered.binary : undefined;
  }

  /**
   * Put directories on PATH for this editor's terminals. `lead` is searched first.
   * One extension can set PATH only once, so saw's own folder is included here too.
   */
  exposeToTerminals(lead: readonly string[] = []): void {
    const dirs = [...lead];
    const remembered = this.remembered();
    const onPath = (process.env["PATH"] ?? "").split(path.delimiter).includes(remembered?.binDir ?? "");
    if (remembered && !onPath && defaultIsExecutableFile(remembered.binary)) {
      dirs.push(remembered.binDir);
    }
    if (dirs.length) {
      this.context.environmentVariableCollection.prepend("PATH", dirs.join(path.delimiter) + path.delimiter);
    } else {
      this.context.environmentVariableCollection.delete("PATH");
    }
  }

  diagnostics(): string | undefined {
    return this.lastReport;
  }

  /** A failed install is not shown here: the caller knows whether an older saw keeps running. */
  async install(why: string): Promise<InstallOutcome> {
    const lock = await this.acquire();
    try {
      return lock === "waited" ? { kind: "installed-elsewhere" } : await this.installLocked(why);
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  /** Why the pinned release did not install here within the last day, when no package of it fits this machine. */
  knownUnsupported(): string | undefined {
    const known = this.context.globalState.get<Unsupported>(UNSUPPORTED_KEY);
    if (!known || known.pin !== this.pins.saw || known.machine !== machineName(host()) || Date.now() - known.at > UNSUPPORTED_RECHECK_MS) {
      return undefined;
    }
    return known.cause;
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
      if (step.ok || (step.probe && result.kind === "installed")) {
        this.log.debug(line);
      } else {
        this.log.warn(`${line}\n${step.output}`);
      }
    }
    const release = result.kind === "failed" && lacksPackage(result) ? await pypiRelease(this.pins.saw) : undefined;
    this.lastReport = this.report(why, result, release);

    switch (result.kind) {
      case "installed": {
        void this.context.globalState.update(UNSUPPORTED_KEY, undefined);
        this.remember({ binary: result.binary, binDir: result.binDir, via: "pipx", version: this.pins.saw });
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
        const machine = host();
        const diagnosis = diagnose(result, machine, this.pins, release);
        await this.context.globalState.update(
          UNSUPPORTED_KEY,
          diagnosis.unsupported ? { pin: this.pins.saw, machine: machineName(machine), at: Date.now(), cause: diagnosis.cause } satisfies Unsupported : undefined,
        );
        this.log.error(`saw ${this.pins.saw} could not be installed. ${diagnosis.cause} ${diagnosis.fix}`);
        return { kind: "failed", diagnosis };
      }
    }
  }

  /** `keeping`: the version of the saw that still runs after this failure, found after the attempt. */
  async showFailure(diagnosis: Diagnosis, keeping: string | undefined): Promise<void> {
    const extension = `${this.context.extension.id} ${(this.context.extension.packageJSON as { version?: string }).version ?? "?"}`;
    const report = reportUrl(diagnosis, extension);
    const actions = [...(report ? ["Report It"] : []), "Retry", "Copy Diagnostics", "Show Log"];
    const choice = keeping
      ? await vscode.window.showWarningMessage(`saw ${this.pins.saw} could not be installed, so saw ${keeping} keeps scanning. ${diagnosis.cause} ${diagnosis.fix}`, ...actions)
      : await vscode.window.showErrorMessage(`saw could not be installed, so no folder is scanned. ${diagnosis.cause} ${diagnosis.fix}`, ...actions);
    if (choice === "Report It" && report) {
      await vscode.env.openExternal(vscode.Uri.parse(report));
    } else if (choice === "Retry") {
      await vscode.commands.executeCommand("saw.install");
    } else if (choice === "Copy Diagnostics") {
      await vscode.commands.executeCommand("saw.copyDiagnostics");
    } else if (choice === "Show Log") {
      await vscode.commands.executeCommand("saw.showOutput");
    }
  }

  private report(why: string, result: InstallResult, release: Release | undefined): string {
    const extension = (this.context.extension.packageJSON as { version?: string }).version ?? "?";
    const lines = [
      "## saw install diagnostics",
      "",
      `- Outcome: ${result.kind}${result.kind === "failed" ? ` at ${result.failedStep}` : ""}`,
      `- Why: ${why}`,
      `- Extension: ${this.context.extension.id} ${extension}; pins stayawakebot ${this.pins.saw}, pipx ${this.pins.pipx}`,
      `- Editor: ${vscode.env.appName} ${vscode.version}${vscode.env.remoteName ? ` (remote: ${vscode.env.remoteName})` : ""}`,
      `- System: ${process.platform} ${osRelease()} ${arch()}${host().distro.length ? ` (${host().distro.join(", ")})` : ""}`,
      `- Machine: ${machineName(host())}${host().glibc ? `, glibc ${host().glibc}` : ""}`,
      `- PATH: ${process.env["PATH"] ?? ""}`,
    ];
    if (release?.kind === "unpublished") {
      lines.push(`- PyPI: stayawakebot ${this.pins.saw} is not published`);
    } else if (release) {
      lines.push(`- PyPI: stayawakebot ${this.pins.saw} wheels: ${release.wheels.join(", ") || "none"}${release.source ? "; source package" : ""}`);
    }
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
      return readRemembered(JSON.parse(readFileSync(path.join(this.storage, "installed.json"), "utf8")), true);
    } catch {
      return undefined;
    }
  }

  private remember(value: Remembered): void {
    mkdirSync(this.storage, { recursive: true });
    const file = path.join(this.storage, "installed.json");
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(value));
    renameSync(`${file}.${process.pid}.tmp`, file);
  }
}

function readRemembered(value: unknown, withPrevious: boolean): Remembered | undefined {
  const r = value as Partial<Remembered> | undefined;
  if (!r || typeof r.binary !== "string" || typeof r.binDir !== "string") {
    return undefined;
  }
  const previous = withPrevious ? readRemembered(r.previous, false) : undefined;
  return {
    binary: r.binary,
    binDir: r.binDir,
    ...(r.via === "pipx" || r.via === "update" ? { via: r.via } : {}),
    ...(typeof r.version === "string" ? { version: r.version } : {}),
    ...(previous ? { previous } : {}),
  };
}
