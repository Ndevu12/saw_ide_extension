import type { InstallResult, StepName } from "./install";
import { machineName, pipWanted, support, type Machine, type Release } from "./platform";

export interface Diagnosis {
  /** One sentence: what is missing or what went wrong. */
  cause: string;
  /** What the operator can do about it, with the command when there is one. */
  fix: string;
  /** The issue to open where it can be fixed, when nothing on this machine can fix it. */
  report?: { where: "saw" | "extension"; title: string; lines: string[] };
  /** No package of this release installs here: installing again fails the same way until the release changes. */
  unsupported?: boolean;
}

export interface Host extends Machine {
  /** `ID` and `ID_LIKE` from /etc/os-release, lower-cased; empty off Linux. */
  distro: string[];
}

export function parseOsRelease(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(ID|ID_LIKE)=(.*)$/.exec(line.trim());
    if (match?.[2]) {
      ids.push(...match[2].replace(/["']/g, "").toLowerCase().split(/\s+/).filter(Boolean));
    }
  }
  return ids;
}

function family(host: Host): "debian" | "fedora" | "arch" | "suse" | "alpine" | "macos" | "windows" | "other" {
  if (host.platform === "darwin") return "macos";
  if (host.platform === "win32") return "windows";
  const ids = new Set(host.distro);
  if (ids.has("debian") || ids.has("ubuntu")) return "debian";
  if (ids.has("fedora") || ids.has("rhel") || ids.has("centos")) return "fedora";
  if (ids.has("arch")) return "arch";
  if (ids.has("suse") || ids.has("opensuse")) return "suse";
  if (ids.has("alpine")) return "alpine";
  return "other";
}

const INSTALL_PYTHON: Record<ReturnType<typeof family>, string> = {
  debian: "sudo apt install python3 python3-venv pipx",
  fedora: "sudo dnf install python3 pipx",
  arch: "sudo pacman -S python python-pipx",
  suse: "sudo zypper install python311 python311-pipx",
  alpine: "sudo apk add python3 pipx",
  macos: "brew install python pipx",
  windows: "winget install Python.Python.3.12",
  other: "install Python 3.11 or later from https://www.python.org/downloads/",
};

const NO_NETWORK = /(Temporary failure in name resolution|Failed to establish a new connection|Name or service not known|ConnectTimeout|ReadTimeout|Network is unreachable|SSLError|CERTIFICATE_VERIFY_FAILED|ProxyError)/i;
const NO_WHEEL = /(No matching distribution found|Could not find a version that satisfies)/i;
const NO_VENV = /(ensurepip is not available|No module named venv|python3(\.\d+)?-venv)/i;

function outputOf(result: Extract<InstallResult, { kind: "failed" }>, step: StepName): string {
  return result.steps.filter((s) => s.name === step && !s.ok).map((s) => s.output).join("\n");
}

/** A GitHub issue for a diagnosis's report, with the machine and versions filled in. Nothing from a folder or PATH is included. */
export function reportUrl(diagnosis: Diagnosis, extension: string): string | undefined {
  const report = diagnosis.report;
  if (!report) {
    return undefined;
  }
  const base = report.where === "saw"
    ? "https://github.com/Ndevu12/stayAwakeBot/issues/new"
    : "https://github.com/Ndevu12/saw_ide_extension/issues/new";
  const body = ["The editor extension could not install saw.", "", diagnosis.cause, "", ...report.lines.map((line) => `- ${line}`), `- Extension: ${extension}`].join("\n");
  return `${base}?title=${encodeURIComponent(report.title)}&body=${encodeURIComponent(body)}`;
}

/** True when pip found no package it could install, so the release's file list on PyPI says why. */
export function lacksPackage(result: Extract<InstallResult, { kind: "failed" }>): boolean {
  const output = outputOf(result, result.failedStep);
  return result.failedStep === "install-saw" && NO_WHEEL.test(output) && !NO_NETWORK.test(output);
}

function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Why no package of the pinned release installs on this machine, from pip's output and, when it was read, PyPI's file list. */
function noPackage(output: string, host: Host, pin: string, release: Release | undefined): Diagnosis {
  const machine = machineName(host);
  const manual = `pipx install stayawakebot==${pin}`;
  const facts = [`Machine: ${machine}${host.glibc ? `, glibc ${host.glibc}` : ""}`, `Release: stayawakebot ${pin}`];
  const wanted = pipWanted(output);
  if (wanted && wanted.name.toLowerCase() !== "stayawakebot") {
    return {
      cause: `${wanted.name}, which stayawakebot ${pin} needs, has no ready-built package for ${machine}.`,
      fix: `Report it so saw can ship one, or build it on this machine: ${manual}`,
      report: { where: "saw", title: `${wanted.name} has no ready-built package for ${machine}`, lines: facts },
      unsupported: true,
    };
  }
  const found = release ? support(release, host) : undefined;
  switch (found?.kind) {
    case "unpublished":
      return {
        cause: `stayawakebot ${pin}, the release this extension installs, is not on PyPI.`,
        fix: "Report it so the release is published or the extension installs one that is.",
        report: { where: "extension", title: `stayawakebot ${pin} is not on PyPI`, lines: facts },
        unsupported: true,
      };
    case "elsewhere": {
      const on = found.on.length ? ` It has one for ${listed(found.on)}.` : " It has none for any platform.";
      return {
        cause: `stayawakebot ${pin} has no ready-built package for ${machine}, which this machine runs.${on}`,
        fix: found.source
          ? `Report it so saw publishes one, or build it on this machine: ${manual}`
          : "Report it so saw publishes one.",
        report: { where: "saw", title: `stayawakebot ${pin} has no ready-built package for ${machine}`, lines: [...facts, `On PyPI for: ${found.on.join(", ") || "nothing"}`] },
        unsupported: true,
      };
    }
    case "old-glibc":
      return {
        cause: `stayawakebot ${pin} for ${machine} needs glibc ${found.needs} or later, and this machine has glibc ${found.has}.`,
        fix: `Update the operating system, or build saw on this machine: ${manual}`,
        unsupported: true,
      };
    case "fits":
      return {
        cause: `stayawakebot ${pin} has a ready-built package for ${machine}, but pip could not install it with this Python.`,
        fix: `See the log for pip's output, or install it by hand: ${manual}`,
      };
    case undefined:
      break;
  }
  if (wanted && wanted.versions.length === 0) {
    return {
      cause: `pip found no stayawakebot release with a ready-built package for ${machine}.`,
      fix: `Report it so saw publishes one, or build it on this machine: ${manual}`,
      report: { where: "saw", title: `stayawakebot has no ready-built package for ${machine}`, lines: facts },
      unsupported: true,
    };
  }
  if (wanted && !wanted.versions.includes(pin)) {
    const newest = wanted.versions[wanted.versions.length - 1];
    return {
      cause: `pip found stayawakebot up to ${newest} for ${machine}, but not ${pin}. Either ${pin} has no ready-built package for this machine, or the package index pip uses does not have it yet.`,
      fix: `Report it if it lasts, or build it on this machine: ${manual}`,
      report: { where: "saw", title: `stayawakebot ${pin} has no ready-built package for ${machine}`, lines: [...facts, `pip found: ${newest ?? "none"} and older`] },
      unsupported: true,
    };
  }
  return {
    cause: `A ready-built package for stayawakebot ${pin} or one of its dependencies is not available for ${machine} with this Python.`,
    fix: `Install it by hand, which may build from source: ${manual}`,
  };
}

/** Turn a failed install into what the operator needs: what is wrong, and what to run. */
export function diagnose(result: Extract<InstallResult, { kind: "failed" }>, host: Host, pins: { saw: string }, release?: Release): Diagnosis {
  const os = family(host);
  const output = outputOf(result, result.failedStep);
  const manual = `pipx install stayawakebot==${pins.saw}`;
  if (result.failedStep === "find-python") {
    const old = result.tried.some((line) => /Python 3\.(\d+)/.test(line));
    return {
      cause: old ? "The Python on this machine is older than 3.11, which saw needs." : "Python 3.11 or later is not installed on this machine.",
      fix: `Install it (${INSTALL_PYTHON[os]}), then run saw: Install or Repair saw.`,
    };
  }
  if (NO_NETWORK.test(output)) {
    return {
      cause: "PyPI could not be reached from this machine, so nothing was downloaded.",
      fix: "Check the network or proxy settings for pip (pip config list), then run saw: Install or Repair saw.",
    };
  }
  if (result.failedStep === "create-venv" && NO_VENV.test(output)) {
    return {
      cause: "This Python cannot create virtual environments, which installing pipx needs.",
      fix: `Install the venv module or pipx from your package manager (${INSTALL_PYTHON[os]}), then run saw: Install or Repair saw.`,
    };
  }
  if (result.failedStep === "install-saw" && NO_WHEEL.test(output)) {
    return noPackage(output, host, pins.saw, release);
  }
  if (NO_WHEEL.test(output)) {
    return {
      cause: `A ready-built package for pipx or one of its dependencies is not available for ${machineName(host)} with this Python.`,
      fix: `Install pipx from your package manager (${INSTALL_PYTHON[os]}), then run saw: Install or Repair saw.`,
    };
  }
  const where: Record<StepName, string> = {
    "find-python": "finding Python",
    "find-pipx": "checking pipx",
    "create-venv": "creating a temporary environment for pipx",
    "bootstrap-pipx": "downloading pipx",
    "install-pipx": "installing pipx",
    "install-saw": "installing saw with pipx",
    "find-saw": "finding the installed saw",
  };
  const last = output.split(/\r?\n/).filter(Boolean).pop() ?? "no output";
  return {
    cause: `Installing saw stopped while ${where[result.failedStep]}: ${last}`,
    fix: `See the log for the full output, or install it by hand: ${manual}`,
  };
}
