import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import * as vscode from "vscode";

import { probeCapabilities, type Capabilities } from "../../core/capabilities";
import { defaultIsExecutableFile, locate, movesToPin, probe, sameInstall, sawToRun, type Probed } from "../../core/install/locate";
import type { Diagnosis } from "../../core/install/diagnose";
import { behindPin, moveOrKeep, type Behind } from "../../core/install/upgrade";
import { atLeast, formatVersion, type Version } from "../../core/version";
import type { Installer } from "./installer";

export type Unavailable =
  | "missing"
  | "invalid-setting"
  | "too-old"
  | "unrecognised"
  /** The installer already told the operator why, with what to do. */
  | "install-failed"
  | "install-cancelled";

export type Engine =
  /** `behind`: the extension could not move this saw up to the release it pins. */
  | { kind: "ready"; binary: string; version: string; capabilities: Capabilities; behind?: Behind }
  | { kind: "installing" }
  | { kind: "unavailable"; reason: Unavailable; message: string };

type Found = Extract<Engine, { kind: "ready" | "unavailable" }>;

export interface EngineSettings {
  path: string;
  autoInstall: boolean;
}

/** Finds and checks the saw program once, installing it when it is missing, until settings change or a scan is asked for by hand. */
export class EngineResolver {
  private pending: Promise<Found> | undefined;
  /** Why the last install failed, until its notification is shown. */
  private failure: Diagnosis | undefined;

  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly settings: () => EngineSettings,
    private readonly installer: Installer,
    private readonly onInstalling: () => void,
  ) {}

  reset(): void {
    this.pending = undefined;
  }

  resolve(): Promise<Found> {
    this.pending ??= this.findOrInstall();
    return this.pending;
  }

  /** Install or repair on request: always reinstalls the pinned release, unless saw.path picks the program. */
  reinstall(): Promise<Found> {
    this.pending = (async () => {
      if (this.settings().path.trim()) {
        const message = `saw.path is set, so it decides which saw runs. Clear it to use the saw this extension installs.`;
        void vscode.window.showWarningMessage(message, "Open Setting").then(
          (choice) => choice && vscode.commands.executeCommand("workbench.action.openSettings", "saw.path"),
        );
        const listed = await this.listReady();
        return listed.kind === "unavailable" ? listed : this.choose(listed.candidates);
      }
      return this.moveOrKeep("Install or repair was asked for.");
    })();
    return this.pending;
  }

  private async findOrInstall(): Promise<Found> {
    const listed = await this.listReady();
    if (listed.kind === "unavailable") {
      if (listed.reason === "invalid-setting") {
        return listed;
      }
      if (!this.settings().autoInstall) {
        return { ...listed, message: `${listed.message} saw.autoInstall is off: run saw: Install or Repair saw to install it.` };
      }
      const known = this.installer.knownUnsupported();
      if (known) {
        const message = `saw ${this.installer.pinnedSaw} cannot be installed on this machine. ${known} Run saw: Install or Repair saw to try again.`;
        this.log.warn(message);
        return { kind: "unavailable", reason: "install-failed", message };
      }
      const installed = await this.installThenFind(listed.message);
      this.showFailure(installed, this.takeFailure(), undefined);
      return installed;
    }
    // The saw this extension installed is kept at the release it pins; one the operator installed is theirs.
    const pin = this.installer.pinnedSaw;
    const ours = listed.candidates.find((candidate) => candidate.ours);
    if (ours && movesToPin(this.settings().path, this.settings().autoInstall, true, ours.version, pin)) {
      const known = this.installer.knownUnsupported();
      if (known) {
        this.log.info(`saw ${ours.versionText} keeps running: ${known} saw ${pin} is tried again after a day, or now with saw: Install or Repair saw.`);
        return behindPin(await this.choose(listed.candidates), pin, known);
      }
      return this.moveOrKeep(`The saw this extension installed is ${ours.versionText}; it now installs ${pin}.`);
    }
    return this.choose(listed.candidates);
  }

  /** Install the pinned release; when that fails, the saw already installed keeps running, marked as behind. */
  private moveOrKeep(why: string): Promise<Found> {
    // Held here, not on the resolver, so a reset while the installed saw is listed again cannot lose it.
    let failure: Diagnosis | undefined;
    // pipx installs the release this extension pins; the updater moves on from there.
    return moveOrKeep<Extract<Found, { kind: "ready" }>, Extract<Found, { kind: "unavailable" }>>(this.installer.packagedSaw, {
      install: async () => {
        const found = await this.installThenFind(why);
        failure = this.takeFailure();
        return found;
      },
      // Listed again, in case the attempt removed it.
      keep: async () => {
        const listed = await this.listReady();
        return listed.kind === "unavailable" ? listed : this.choose(listed.candidates);
      },
      failed: (moved, keeping) => this.showFailure(moved, failure, keeping),
      warn: (message) => this.log.warn(message),
    });
  }

  private takeFailure(): Diagnosis | undefined {
    const failure = this.failure;
    this.failure = undefined;
    return failure;
  }

  /** The installer's notification for a failed install, once it is known what keeps running. */
  private showFailure(found: Found, failure: Diagnosis | undefined, keeping: string | undefined): void {
    if (found.kind === "unavailable" && found.reason === "install-failed" && failure) {
      void this.installer.showFailure(failure, keeping);
    }
  }

  private async installThenFind(why: string): Promise<Found> {
    this.onInstalling();
    this.failure = undefined;
    const outcome = await this.installer.install(why);
    switch (outcome.kind) {
      case "failed":
        this.failure = outcome.diagnosis;
        return { kind: "unavailable", reason: "install-failed", message: `saw could not be installed. ${outcome.diagnosis.cause}` };
      case "cancelled":
        return { kind: "unavailable", reason: "install-cancelled", message: "Installing saw was cancelled. Run saw: Install or Repair saw to try again." };
      case "installed":
      case "installed-elsewhere": {
        const listed = await this.listReady();
        if (listed.kind === "unavailable") {
          return outcome.kind === "installed-elsewhere"
            ? { ...listed, message: `Another editor window tried to install saw without success. ${listed.message}` }
            : listed;
        }
        return this.choose(listed.candidates);
      }
    }
  }

  private async choose(candidates: ReadySaw[]): Promise<Found> {
    const pin = this.installer.pinnedSaw;
    const chosen = sawToRun(candidates, pin);
    if (!chosen) {
      return { kind: "unavailable", reason: "missing", message: "saw is not installed on this machine." };
    }
    const first = candidates[0];
    if (first && first.binary !== chosen.binary) {
      this.log.info(`saw ${first.versionText} at ${first.binary} is behind ${pin}; using ${chosen.versionText} at ${chosen.binary}.`);
    } else if (!atLeast(chosen.version, pin) && !chosen.ours) {
      this.log.info(`saw ${chosen.versionText} at ${chosen.binary} is behind ${pin}. This extension did not install it, so it is left as it is.`);
    }
    const capabilities = await probeCapabilities(chosen.binary);
    const features = [...capabilities.features].join(", ");
    this.log.info(`Using saw ${chosen.versionText} at ${chosen.binary} (found via ${chosen.from}). Features: ${features || "none it can name"}.`);
    return { kind: "ready", binary: chosen.binary, version: chosen.versionText, capabilities };
  }

  private async listReady(): Promise<{ kind: "ready"; candidates: ReadySaw[] } | Extract<Found, { kind: "unavailable" }>> {
    const located = locate(
      this.settings().path,
      { platform: process.platform, homedir: homedir(), pathVariable: process.env["PATH"], isExecutableFile: defaultIsExecutableFile },
      this.installer.installedBinary(),
    );
    if (located.kind === "invalid-setting") {
      this.log.warn(located.reason);
      return { kind: "unavailable", reason: "invalid-setting", message: located.reason };
    }
    if (located.kind === "missing") {
      this.log.info(`saw is not installed. Looked in: ${located.searched.join(", ")}`);
      return { kind: "unavailable", reason: "missing", message: "saw is not installed on this machine." };
    }
    const installed = this.installer.installedBinary();
    const canonical = (file: string): string | undefined => {
      try {
        return realpathSync(file);
      } catch {
        return undefined;
      }
    };
    const candidates: ReadySaw[] = [];
    let rejected: Extract<Found, { kind: "unavailable" }> | undefined;
    for (const candidate of located.candidates) {
      const probed: Probed = await probe(candidate.binary);
      if (probed.kind === "ready") {
        candidates.push({
          binary: probed.binary,
          version: probed.version,
          versionText: formatVersion(probed.version),
          ours: sameInstall(probed.binary, installed, canonical),
          from: candidate.from,
        });
        continue;
      }
      const message =
        probed.kind === "too-old"
          ? `saw ${formatVersion(probed.version)} at ${probed.binary} is older than ${probed.minimum}, the oldest this extension reads.`
          : `${probed.binary} did not identify itself as saw: ${probed.detail}`;
      this.log.warn(message);
      rejected ??= { kind: "unavailable", reason: probed.kind, message };
    }
    if (candidates.length === 0) {
      return rejected ?? { kind: "unavailable", reason: "missing", message: "saw is not installed on this machine." };
    }
    return { kind: "ready", candidates };
  }
}

interface ReadySaw {
  binary: string;
  version: Version;
  versionText: string;
  ours: boolean;
  from: string;
}
