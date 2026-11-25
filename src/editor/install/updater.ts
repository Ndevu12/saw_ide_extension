import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";
import { verify } from "sigstore";

import { downloadRelease } from "../../core/install/download";
import { chooseUpdate, LATEST_RELEASE_URL, readRelease, UPDATE_WAIT_MS, wheelFor, type SawRelease } from "../../core/install/release";
import { installUpdate, type UpdateStep } from "../../core/install/update";
import { runProgram } from "../../core/run";
import { scanFolder } from "../../core/scan/scan";
import { parseRelease } from "../../core/version";
import type { Model } from "../model";
import { withCancellableProgress, type Report } from "../progress";
import { locateEnv, type Installer } from "./installer";
import { UpdateState } from "./updateState";

export type UpdateMode = "auto" | "notify" | "off";

const FIRST_CHECK_MS = 60_000;
const TICK_MS = 6 * 60 * 60_000;
const CHECK_EVERY_MS = 20 * 60 * 60_000;
const IDLE_POLL_MS = 30_000;
const IDLE_WAIT_MS = 30 * 60_000;
const FETCH_MS = 60_000;
const SAMPLE_SCAN_MS = 60_000;

const STEP_TEXT: Record<UpdateStep, string> = {
  "find-python": "Finding Python…",
  "create-venv": "Preparing a separate environment…",
  install: "Installing…",
  "check-version": "Checking its version…",
  "check-detection": "Checking it finds a known infection…",
};

type Installed = { kind: "installed"; binary: string } | { kind: "failed"; detail: string };

const removeDir = (dir: string) => rmSync(dir, { recursive: true, force: true });

function tempFolder(prefix: string, files: Record<string, string> = {}): string {
  const folder = mkdtempSync(path.join(tmpdir(), prefix));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    writeFileSync(path.join(folder, name), text);
  }
  return folder;
}

export class Updater implements vscode.Disposable {
  private readonly state: UpdateState;
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly installer: Installer,
    private readonly model: Model,
    private readonly settings: () => { path: string; autoUpdate: UpdateMode },
    private readonly switched: () => Promise<void>,
  ) {
    this.state = new UpdateState(context.globalState);
  }

  start(): void {
    this.first = setTimeout(() => void this.check(false), FIRST_CHECK_MS);
    this.timer = setInterval(() => void this.check(false), TICK_MS);
  }

  async recheck(): Promise<void> {
    await this.state.checked(undefined);
    await this.check(false);
  }

  /** `asked`: from the command, so every outcome is said and a declined release is offered again. */
  check(asked: boolean): Promise<void> {
    this.running ??= this.checkOnce(asked).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async checkOnce(asked: boolean): Promise<void> {
    const mode = this.settings().autoUpdate;
    if (!asked && (mode === "off" || this.state.checkedWithin(CHECK_EVERY_MS, Date.now()))) {
      return;
    }
    const engine = this.model.engine;
    const skip = this.settings().path.trim()
      ? "saw.path is set, so saw is not updated by this extension."
      : engine?.kind !== "ready"
        ? "saw is not running yet."
        : !engine.ours
          ? `saw at ${engine.binary} was not installed by this extension. Update it the way you installed it.`
          : !wheelFor(process.platform, process.arch, engine.version)
            ? `saw publishes no package for ${process.platform} ${process.arch}, so it is not updated here.`
            : undefined;
    const current = engine?.kind === "ready" ? parseRelease(engine.version) : undefined;
    if (skip || !current) {
      this.tell(asked, skip ?? "saw's version could not be read.");
      return;
    }
    const text = await this.fetch(LATEST_RELEASE_URL);
    await this.state.checked(Date.now());
    const release = text && readRelease(Buffer.from(text).toString("utf8"));
    if (!release) {
      this.tell(asked, "Could not read saw's latest release. Trying again later.", "warn");
      return;
    }
    const choice = chooseUpdate(release, { current, highest: this.state.highest, now: Date.now(), declined: asked ? [] : this.state.declined });
    if (choice.kind === "none") {
      this.tell(asked, `saw ${current.join(".")} is up to date.`);
    } else if (choice.kind === "due" && mode === "auto") {
      await this.update(release, choice.why === "security" ? "it fixes a security problem" : undefined, false);
    } else if (asked || (await this.state.offerOnce(release.version))) {
      await this.offer(release, mode === "auto" && choice.kind === "waiting" && Number.isFinite(choice.dueAt) ? choice.dueAt : undefined);
    }
  }

  private async offer(release: SawRelease, dueAt: number | undefined): Promise<void> {
    const when = dueAt ? ` It installs on its own on ${new Date(dueAt).toLocaleDateString()}, ${Math.round(UPDATE_WAIT_MS / 86_400_000)} days after release.` : "";
    const choice = await this.notesOr(release, `saw ${release.version} is available.${when}`, "Update Now");
    if (choice === "Update Now") {
      await this.update(release, undefined, true);
    }
  }

  private async update(release: SawRelease, why: string | undefined, asked: boolean): Promise<void> {
    const outcome = await this.installer.exclusive(() => this.install(release, asked));
    if (outcome === "busy") {
      return;
    }
    if (outcome.kind === "failed") {
      const message = `saw ${release.version} was not installed: ${outcome.detail} The current saw keeps running.`;
      this.log.warn(message);
      if (asked || why) {
        void vscode.window.showWarningMessage(message, "Show Log").then((choice) => choice && vscode.commands.executeCommand("saw.showOutput"));
      }
      return;
    }
    if (!(await this.idle())) {
      this.log.info(`saw ${release.version} is installed but not switched to: a scan or fix is still running.`);
      return;
    }
    this.installer.adopt(outcome.binary, release.version);
    await this.state.adopted(release.version);
    this.log.info(`Updated saw to ${release.version}.`);
    await this.switched();
    const back = this.installer.previousVersion() ? ["Use Previous Version"] : [];
    const choice = await this.notesOr(release, `saw is updated to ${release.version}${why ? ` because ${why}` : ""}.`, ...back);
    if (choice === "Use Previous Version") {
      await this.usePrevious();
    }
  }

  private async install(release: SawRelease, asked: boolean): Promise<Installed> {
    const tufCachePath = path.join(this.installer.updateRoot, "sigstore");
    const verifyBundle = async (bundle: unknown, identity: { certificateIssuer: string; certificateIdentityURI: string }) => {
      await verify(bundle as Parameters<typeof verify>[0], { ...identity, tufCachePath });
    };
    const downloaded = await downloadRelease(release, { fetch: (url) => this.fetch(url), signers: this.signers(), verifyBundle, platform: process.platform, arch: process.arch });
    if (downloaded.kind === "failed") {
      return downloaded;
    }
    const work = tempFolder("saw-update-");
    const wheel = path.join(work, downloaded.wheelName);
    writeFileSync(wheel, downloaded.wheel);
    const dir = path.join(this.installer.updateRoot, "versions", release.version);
    mkdirSync(path.dirname(dir), { recursive: true });
    const run = (progress: Report, signal?: AbortSignal) =>
      installUpdate({
        env: locateEnv(),
        run: runProgram,
        dir,
        version: release.version,
        wheel,
        dependencies: downloaded.dependencies,
        writeFile: (file, text) => writeFileSync(file, text),
        removeDir,
        sample: (files) => tempFolder("saw-update-check-", files),
        scan: async (binary, folder) => {
          const outcome = await scanFolder({ binary, folder, configPath: "", timeoutMs: SAMPLE_SCAN_MS });
          return outcome.kind === "cancelled" ? undefined : outcome.verdict;
        },
        onStep: (step) => {
          progress.report({ message: STEP_TEXT[step] });
          this.log.info(`saw ${release.version}: ${STEP_TEXT[step]}`);
        },
        ...(signal ? { signal } : {}),
      });
    const title = `Updating saw to ${release.version}`;
    try {
      const result = asked
        ? await withCancellableProgress(title, run)
        : await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, (progress) => run(progress));
      return result.kind === "installed" ? result : { kind: "failed", detail: `${STEP_TEXT[result.step].replace(/…$/, "")} failed: ${result.detail}` };
    } finally {
      removeDir(work);
    }
  }

  async usePrevious(): Promise<void> {
    const engine = this.model.engine;
    const leaving = engine?.kind === "ready" ? engine.version : undefined;
    const version = this.installer.restorePrevious();
    if (!version) {
      void vscode.window.showInformationMessage("There is no earlier saw to go back to.");
      return;
    }
    if (leaving) {
      await this.state.decline(leaving);
    }
    this.log.info(`Went back to saw ${version}.`);
    await this.switched();
    void vscode.window.showInformationMessage(`saw ${version} runs again.${leaving ? ` saw ${leaving} won't be installed on its own again.` : ""}`);
  }

  private signers(): string[] {
    return (this.context.extension.packageJSON as { saw?: { signers?: string[] } }).saw?.signers ?? [];
  }

  /** Shows `message` with Release Notes, which opens them, beside `actions`; returns the action chosen. */
  private async notesOr(release: SawRelease, message: string, ...actions: string[]): Promise<string | undefined> {
    const choice = await vscode.window.showInformationMessage(message, ...actions, "Release Notes");
    if (choice === "Release Notes") {
      await vscode.env.openExternal(vscode.Uri.parse(release.notesUrl));
      return undefined;
    }
    return choice;
  }

  private async idle(): Promise<boolean> {
    const end = Date.now() + IDLE_WAIT_MS;
    for (;;) {
      const busy = this.model.machine.auditing || this.model.states().some((state) => state.scanning || state.fixing || state.checking || state.deciding);
      if (!busy) {
        return true;
      }
      if (Date.now() > end) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
    }
  }

  private async fetch(url: string): Promise<Uint8Array | undefined> {
    try {
      const accept = url.startsWith("https://api.github.com/") ? "application/vnd.github+json" : "application/octet-stream";
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: { Accept: accept } });
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined;
    } catch (error) {
      this.log.warn(`Could not download ${url}: ${String(error)}`);
      return undefined;
    }
  }

  private tell(asked: boolean, message: string, level: "info" | "warn" = "info"): void {
    this.log[level](message);
    if (asked) {
      void (level === "warn" ? vscode.window.showWarningMessage(message) : vscode.window.showInformationMessage(message));
    }
  }

  dispose(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }
}

export function isUpdateMode(value: unknown): value is UpdateMode {
  return value === "auto" || value === "notify" || value === "off";
}
