import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { CHANNEL_URL, checkLock, chooseUpdate, lockUrl, readChannel, UPDATE_WAIT_MS, type Channel, type ChannelRelease } from "../../core/install/channel";
import { defaultIsExecutableFile, sameInstall } from "../../core/install/locate";
import { installUpdate, type UpdateStep } from "../../core/install/update";
import { runProgram } from "../../core/run";
import { scanFolder } from "../../core/scan/scan";
import { parseRelease } from "../../core/version";
import type { Model } from "../model";
import type { Installer } from "./installer";

export type UpdateMode = "auto" | "notify" | "off";

const FIRST_CHECK_MS = 60_000;
const TICK_MS = 6 * 60 * 60_000;
const CHECK_EVERY_MS = 20 * 60 * 60_000;
const IDLE_POLL_MS = 30_000;
const IDLE_WAIT_MS = 30 * 60_000;
const FETCH_MS = 15_000;
const SAMPLE_SCAN_MS = 60_000;

const LAST_CHECK_KEY = "update.lastCheck";
const OFFERED_KEY = "update.offered";
const DECLINED_KEY = "update.declined";

const STEP_TEXT: Record<UpdateStep, string> = {
  "find-python": "Finding Python…",
  "create-venv": "Preparing a separate place for it…",
  install: "Installing it, every file checked against its approved hash…",
  "check-version": "Checking its version…",
  "check-detection": "Checking it still finds a known infection…",
};

/**
 * Moves the saw this extension installed to a newer release its channel approved, without a
 * release of the extension. A release installs on its own once it is three days old, or at once
 * when it fixes a security problem or the running saw is withdrawn. The person can install it
 * sooner. The saw that runs is replaced only once the new one has passed its checks, and only
 * while nothing is scanning or fixing. A failed update leaves the saw that runs as it is.
 */
export class Updater implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly installer: Installer,
    private readonly model: Model,
    private readonly settings: () => { path: string; autoUpdate: UpdateMode },
    /** Find saw again and scan every folder with it. */
    private readonly switched: () => Promise<void>,
  ) {}

  start(): void {
    this.first = setTimeout(() => void this.check(false), FIRST_CHECK_MS);
    this.timer = setInterval(() => void this.check(false), TICK_MS);
  }

  /** Check on the next tick whatever the last check found, as after saw was installed again. */
  async recheck(): Promise<void> {
    await this.context.globalState.update(LAST_CHECK_KEY, undefined);
    await this.check(false);
  }

  /** `asked`: from the command, so every outcome is said, the wait is shown, and a declined release is offered again. */
  check(asked: boolean): Promise<void> {
    this.running ??= this.checkOnce(asked).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async checkOnce(asked: boolean): Promise<void> {
    const mode = this.settings().autoUpdate;
    if (!asked && (mode === "off" || Date.now() - (this.context.globalState.get<number>(LAST_CHECK_KEY) ?? 0) < CHECK_EVERY_MS)) {
      return;
    }
    const engine = this.model.engine;
    if (this.settings().path.trim()) {
      this.tell(asked, "saw.path is set, so it decides which saw runs, and this extension does not update it.");
      return;
    }
    if (engine?.kind !== "ready") {
      this.tell(asked, "saw is not running yet, so there is nothing to update.");
      return;
    }
    if (!this.ours(engine.binary)) {
      this.tell(asked, `The saw that runs (${engine.binary}) was not installed by this extension, so update it the way it was installed.`);
      return;
    }
    const current = parseRelease(engine.version);
    if (!current) {
      return;
    }
    const channel = await this.fetchChannel();
    void this.context.globalState.update(LAST_CHECK_KEY, Date.now());
    if (!channel) {
      this.tell(asked, "saw could not read which releases are approved. It tries again later.", "warn");
      return;
    }
    const declined = asked ? [] : this.context.globalState.get<string[]>(DECLINED_KEY) ?? [];
    const extension = (this.context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
    const choice = chooseUpdate(channel, { current, extension, now: Date.now(), declined });
    switch (choice.kind) {
      case "none":
        this.tell(asked, `saw ${engine.version} is the newest release approved for this extension.`);
        return;
      case "blocked-stuck":
        this.log.warn(`saw ${engine.version} has been withdrawn, and no release that replaces it is approved yet. It keeps running.`);
        void vscode.window.showWarningMessage(`saw ${engine.version} has been withdrawn, and no release that replaces it is approved yet. It keeps scanning until one is.`);
        return;
      case "waiting":
        if (asked || mode !== "off") {
          await this.offer(choice.release, mode === "auto" && Number.isFinite(choice.dueAt) ? choice.dueAt : undefined, asked);
        }
        return;
      case "due":
        if (mode === "auto" || choice.why === "blocked") {
          await this.update(choice.release, choice.why === "blocked" ? `saw ${engine.version} was withdrawn` : choice.why === "security" ? "it fixes a security problem" : undefined, false);
        } else {
          await this.offer(choice.release, undefined, asked);
        }
        return;
    }
  }

  /** Offer a release once, unless asked: the person can read about it and install it now. */
  private async offer(release: ChannelRelease, dueAt: number | undefined, asked: boolean): Promise<void> {
    if (!asked && this.context.globalState.get<string>(OFFERED_KEY) === release.version) {
      return;
    }
    await this.context.globalState.update(OFFERED_KEY, release.version);
    const when = dueAt ? ` It installs on its own on ${new Date(dueAt).toLocaleDateString()}, ${Math.round(UPDATE_WAIT_MS / 86_400_000)} days after its release.` : "";
    const checked = release.provenance ? "Its files match the hashes this extension approved, and saw's release workflow signed them." : "Its files match the hashes this extension approved.";
    const choice = await vscode.window.showInformationMessage(`saw ${release.version} is available.${when} ${checked} You can install it now once you have checked it.`, "Update Now", "Release Notes");
    if (choice === "Release Notes") {
      await vscode.env.openExternal(vscode.Uri.parse(release.notesUrl));
    } else if (choice === "Update Now") {
      await this.update(release, undefined, true);
    }
  }

  private async update(release: ChannelRelease, why: string | undefined, asked: boolean): Promise<void> {
    const outcome = await this.installer.exclusive(() => this.install(release, asked));
    if (outcome === "busy") {
      this.log.info("Another editor window is installing saw; the update is tried again later.");
      return;
    }
    if (outcome.kind === "failed") {
      const message = `saw ${release.version} was not installed: ${outcome.detail} The saw that runs keeps scanning.`;
      this.log.warn(message);
      if (asked || why) {
        void vscode.window.showWarningMessage(message, "Show Log").then((choice) => choice && vscode.commands.executeCommand("saw.showOutput"));
      }
      return;
    }
    if (!(await this.idle())) {
      this.log.info(`saw ${release.version} is ready, but a scan or fix is still running; it is switched to on the next check.`);
      return;
    }
    this.installer.adopt(outcome.binary, release.version);
    await this.context.globalState.update(DECLINED_KEY, (this.context.globalState.get<string[]>(DECLINED_KEY) ?? []).filter((v) => v !== release.version));
    this.log.info(`Updated saw to ${release.version} at ${outcome.binary}${why ? ` because ${why}` : ""}.`);
    await this.switched();
    const back = this.installer.previousVersion();
    const choice = await vscode.window.showInformationMessage(
      `saw is updated to ${release.version}${why ? ` because ${why}` : ""}. Every folder is scanned again with it.`,
      "Release Notes",
      ...(back ? ["Use Previous Version"] : []),
    );
    if (choice === "Release Notes") {
      await vscode.env.openExternal(vscode.Uri.parse(release.notesUrl));
    } else if (choice === "Use Previous Version") {
      await this.usePrevious();
    }
  }

  private async install(release: ChannelRelease, asked: boolean): Promise<{ kind: "installed"; binary: string } | { kind: "failed"; detail: string }> {
    const lock = await this.fetchText(lockUrl(release));
    const checked = lock === undefined ? undefined : checkLock(lock, release);
    if (!checked) {
      return { kind: "failed", detail: lock === undefined ? "its approved requirements could not be downloaded." : "its requirements do not match the hash this extension approved." };
    }
    const dir = path.join(this.installer.updateRoot, "versions", release.version);
    mkdirSync(path.dirname(dir), { recursive: true });
    const work = (progress: vscode.Progress<{ message?: string }>, signal?: AbortSignal) => installUpdate({
      env: { platform: process.platform, homedir: homedir(), pathVariable: process.env["PATH"], isExecutableFile: defaultIsExecutableFile },
      run: runProgram,
      dir,
      version: release.version,
      lock: checked,
      writeFile: (file, text) => writeFileSync(file, text),
      removeDir: (target) => rmSync(target, { recursive: true, force: true }),
      sample: (files) => {
        const folder = mkdtempSync(path.join(tmpdir(), "saw-update-check-"));
        for (const [name, text] of Object.entries(files)) {
          mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
          writeFileSync(path.join(folder, name), text);
        }
        return folder;
      },
      scan: async (binary, folder) => {
        const outcome = await scanFolder({ binary, folder, configPath: "", timeoutMs: SAMPLE_SCAN_MS });
        return outcome.kind === "cancelled" ? undefined : outcome.verdict;
      },
      onStep: (step) => {
        progress.report({ message: STEP_TEXT[step] });
        this.log.info(`Updating saw to ${release.version}: ${STEP_TEXT[step]}`);
      },
      ...(signal ? { signal } : {}),
    });
    const title = `Updating saw to ${release.version}`;
    const result = asked
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        return work(progress, abort.signal);
      })
      : await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, (progress) => work(progress));
    return result.kind === "installed" ? { kind: "installed", binary: result.binary } : { kind: "failed", detail: `${STEP_TEXT[result.step].replace(/…$/, "")} failed (${result.detail}).` };
  }

  /** Go back to the saw that ran before the last update. That release is not installed on its own again. */
  async usePrevious(): Promise<void> {
    const engine = this.model.engine;
    const leaving = engine?.kind === "ready" ? engine.version : undefined;
    const version = this.installer.restorePrevious();
    if (!version) {
      void vscode.window.showInformationMessage("There is no earlier saw to go back to.");
      return;
    }
    if (leaving) {
      const declined = this.context.globalState.get<string[]>(DECLINED_KEY) ?? [];
      await this.context.globalState.update(DECLINED_KEY, [...new Set([...declined, leaving])]);
    }
    this.log.info(`Went back to saw ${version}${leaving ? ` from ${leaving}` : ""}.`);
    await this.switched();
    void vscode.window.showInformationMessage(`saw ${version} runs again, and every folder is scanned with it.${leaving ? ` saw ${leaving} is not installed on its own again; saw: Check for saw Updates offers it.` : ""}`);
  }

  private ours(binary: string): boolean {
    const canonical = (file: string) => {
      try {
        return realpathSync(file);
      } catch {
        return undefined;
      }
    };
    return sameInstall(binary, this.installer.installedBinary(), canonical);
  }

  /** Nothing is scanning, fixing, checking an update, or waiting on a choice, so switching saw interrupts nothing. */
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

  private async fetchChannel(): Promise<Channel | undefined> {
    const text = await this.fetchText(CHANNEL_URL);
    return text === undefined ? undefined : readChannel(text);
  }

  private async fetchText(url: string): Promise<string | undefined> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), redirect: "error" });
      return response.ok ? await response.text() : undefined;
    } catch (error) {
      this.log.warn(`Could not read ${url}: ${String(error)}`);
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
    if (this.first) {
      clearTimeout(this.first);
    }
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}

export function isUpdateMode(value: unknown): value is UpdateMode {
  return value === "auto" || value === "notify" || value === "off";
}
