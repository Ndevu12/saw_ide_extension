import { homedir } from "node:os";

import * as vscode from "vscode";

import { probeCapabilities, type Capabilities } from "../../core/capabilities";
import { defaultIsExecutableFile, locate, probe, type Probed } from "../../core/install/locate";
import { atLeast, formatVersion, parseVersion } from "../../core/version";
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
  | { kind: "ready"; binary: string; version: string; capabilities: Capabilities }
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
        return this.find();
      }
      return this.installThenFind("Install or repair was asked for.");
    })();
    return this.pending;
  }

  private async findOrInstall(): Promise<Found> {
    const found = await this.find();
    if (found.kind === "ready") {
      // The saw this extension installed is kept at the release it pins; one the operator installed is theirs.
      const pinned = parseVersion(`saw (stayawakebot) ${this.installer.pinnedSaw}`);
      const ours = found.binary === this.installer.installedBinary();
      const behind = pinned && !atLeast(parseVersion(`saw (stayawakebot) ${found.version}`) ?? [0, 0, 0], this.installer.pinnedSaw);
      if (ours && behind && this.settings().autoInstall && !this.settings().path.trim()) {
        return this.installThenFind(`The saw this extension installed is ${found.version}; it now installs ${this.installer.pinnedSaw}.`);
      }
      return found;
    }
    if (found.reason === "invalid-setting") {
      return found;
    }
    if (!this.settings().autoInstall) {
      return { ...found, message: `${found.message} saw.autoInstall is off: run saw: Install or Repair saw to install it.` };
    }
    return this.installThenFind(found.message);
  }

  private async installThenFind(why: string): Promise<Found> {
    this.onInstalling();
    const outcome = await this.installer.install(why);
    switch (outcome.kind) {
      case "failed":
        return { kind: "unavailable", reason: "install-failed", message: `saw could not be installed. ${outcome.diagnosis.cause}` };
      case "cancelled":
        return { kind: "unavailable", reason: "install-cancelled", message: "Installing saw was cancelled. Run saw: Install or Repair saw to try again." };
      case "installed":
      case "installed-elsewhere": {
        const found = await this.find();
        if (found.kind === "unavailable" && outcome.kind === "installed-elsewhere") {
          return { ...found, message: `Another editor window tried to install saw without success. ${found.message}` };
        }
        return found;
      }
    }
  }

  private async find(): Promise<Found> {
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
    let rejected: Found | undefined;
    for (const candidate of located.candidates) {
      const probed: Probed = await probe(candidate.binary);
      if (probed.kind === "ready") {
        const version = formatVersion(probed.version);
        const capabilities = await probeCapabilities(probed.binary);
        const features = [...capabilities.features].join(", ");
        this.log.info(`Using saw ${version} at ${probed.binary} (found via ${candidate.from}). Features: ${features || "none it can name"}.`);
        return { kind: "ready", binary: probed.binary, version, capabilities };
      }
      const message =
        probed.kind === "too-old"
          ? `saw ${formatVersion(probed.version)} at ${probed.binary} is older than ${probed.minimum}, the oldest this extension reads.`
          : `${probed.binary} did not identify itself as saw: ${probed.detail}`;
      this.log.warn(message);
      rejected ??= { kind: "unavailable", reason: probed.kind, message };
    }
    return rejected ?? { kind: "unavailable", reason: "missing", message: "saw is not installed on this machine." };
  }
}
