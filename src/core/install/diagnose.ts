import type { InstallResult, StepName } from "./install";

export interface Diagnosis {
  /** One sentence: what is missing or what went wrong. */
  cause: string;
  /** What the operator can do about it, with the command when there is one. */
  fix: string;
}

export interface Host {
  platform: NodeJS.Platform;
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

/** Turn a failed install into what the operator needs: what is wrong, and what to run. */
export function diagnose(result: Extract<InstallResult, { kind: "failed" }>, host: Host, pins: { saw: string }): Diagnosis {
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
  if (NO_WHEEL.test(output)) {
    return {
      cause: `A ready-built package for stayawakebot ${pins.saw} or one of its dependencies is not available for this Python.`,
      fix: `Install it by hand, which may build from source: ${manual}`,
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
