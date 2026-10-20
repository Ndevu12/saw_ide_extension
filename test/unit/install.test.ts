import { describe, expect, it } from "vitest";

import { diagnose, parseOsRelease } from "../../src/core/diagnose";
import { installSaw, type InstallDeps, type InstallResult } from "../../src/core/install";
import type { LocateEnv } from "../../src/core/locate";
import { findPython, pythonLaunchers, type Runner } from "../../src/core/python";
import type { RunResult } from "../../src/core/run";

const PINS = { saw: "0.12.3", pipx: "1.18.4" };

function result(overrides: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, cancelled: false, overflowed: false, spawnError: null, ...overrides };
}

type Handler = (command: string) => Partial<RunResult> | undefined;

/** A runner answering by the command line it is given; anything unscripted fails, as an unknown program would. */
function scripted(handler: Handler): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = (binary, args) => {
    const command = [binary, ...args].join(" ");
    calls.push(command);
    const answer = handler(command);
    return Promise.resolve(answer ? result(answer) : result({ exitCode: 1, stderr: `unscripted: ${command}` }));
  };
  return { run, calls };
}

function env(executables: string[], overrides: Partial<LocateEnv> = {}): LocateEnv {
  return { platform: "linux", homedir: "/home/me", pathVariable: "/usr/bin", isExecutableFile: (f) => executables.includes(f), ...overrides };
}

const PYTHON_313 = { stdout: "3 13\n/usr/bin/python3.13\n" };

function deps(executables: string[], handler: Handler, overrides: Partial<InstallDeps> = {}) {
  const { run, calls } = scripted(handler);
  const removed: string[] = [];
  const steps: string[] = [];
  const value: InstallDeps = {
    env: env(executables),
    run,
    makeTempDir: () => "/tmp/boot",
    removeDir: (dir) => removed.push(dir),
    pins: PINS,
    onStep: (name) => steps.push(name),
    ...overrides,
  };
  return { deps: value, calls, removed, steps };
}

describe("findPython", () => {
  it("takes the newest interpreter that is 3.11 or later, as the base interpreter it reports", async () => {
    const { run } = scripted((cmd) => (cmd.startsWith("/usr/bin/python3.13 ") ? { stdout: "3 13\n/usr/bin/python3.13\n" } : undefined));
    const found = await findPython(env(["/usr/bin/python3.13", "/usr/bin/python3"]), run);
    expect(found.found).toEqual({ executable: "/usr/bin/python3.13", version: [3, 13] });
  });

  it("refuses an interpreter older than 3.11 and says what it saw", async () => {
    const { run } = scripted(() => ({ stdout: "3 9\n/usr/bin/python3\n" }));
    const found = await findPython(env(["/usr/bin/python3"]), run);
    expect(found.found).toBeUndefined();
    expect(found.tried).toEqual(["/usr/bin/python3: Python 3.9 at /usr/bin/python3"]);
  });

  it("on Windows asks the py launcher for Python 3 and skips the Store stub", () => {
    const winEnv = env(["C:\\Windows\\py.exe", "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe", "C:\\Python312\\python.exe"], {
      platform: "win32",
      pathVariable: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Python312",
    });
    expect(pythonLaunchers(winEnv)).toEqual([
      { binary: "C:\\Windows\\py.exe", args: ["-3"] },
      { binary: "C:\\Python312\\python.exe", args: [] },
    ]);
  });
});

describe("installSaw", () => {
  it("installs the pinned saw from wheels with the pipx already on the machine", async () => {
    const { deps: d, calls } = deps(["/usr/bin/python3.13", "/usr/bin/pipx", "/home/me/.local/bin/saw"], (cmd) => {
      if (cmd.startsWith("/usr/bin/python3.13 -c")) return PYTHON_313;
      if (cmd === "/usr/bin/pipx --version") return { stdout: "1.4.3\n" };
      if (cmd.startsWith("/usr/bin/pipx install")) return {};
      if (cmd === "/usr/bin/pipx environment --value PIPX_BIN_DIR") return { stdout: "/home/me/.local/bin\n" };
      return undefined;
    });
    const outcome = await installSaw(d);
    expect(outcome).toMatchObject({ kind: "installed", binary: "/home/me/.local/bin/saw", installedPipx: false, pipx: "/usr/bin/pipx" });
    expect(calls).toContain(
      "/usr/bin/pipx install --force --python /usr/bin/python3.13 --pip-args=--only-binary=:all: stayawakebot==0.12.3",
    );
  });

  it("installs pipx first from a throwaway environment when the machine has none, then removes it", async () => {
    const { deps: d, calls, removed, steps } = deps(["/usr/bin/python3.13", "/home/me/.local/bin/saw"], (cmd) => {
      if (cmd.startsWith("/usr/bin/python3.13 -c")) return PYTHON_313;
      if (cmd === "/usr/bin/python3.13 -m pipx --version") return { exitCode: 1, stderr: "No module named pipx" };
      if (cmd === "/usr/bin/python3.13 -m venv /tmp/boot/venv") return {};
      if (cmd.startsWith("/tmp/boot/venv/bin/python -m pip install")) return {};
      if (cmd.startsWith("/tmp/boot/venv/bin/python -m pipx install")) return {};
      if (cmd === "/tmp/boot/venv/bin/python -m pipx environment --value PIPX_BIN_DIR") return { stdout: "/home/me/.local/bin\n" };
      if (cmd.startsWith("/home/me/.local/bin/pipx ")) return cmd.includes("environment") ? { stdout: "/home/me/.local/bin\n" } : {};
      return undefined;
    });
    const outcome = await installSaw(d);
    expect(outcome).toMatchObject({ kind: "installed", installedPipx: true, pipx: "/home/me/.local/bin/pipx" });
    expect(calls).toContain("/tmp/boot/venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: pipx==1.18.4");
    expect(calls).toContain(
      "/tmp/boot/venv/bin/python -m pipx install --force --python /usr/bin/python3.13 --pip-args=--only-binary=:all: pipx==1.18.4",
    );
    expect(removed).toEqual(["/tmp/boot"]);
    expect(steps).toEqual(["find-python", "find-pipx", "create-venv", "bootstrap-pipx", "install-pipx", "install-saw", "find-saw"]);
    const failed = outcome.steps.filter((step) => !step.ok);
    expect(failed).toMatchObject([{ command: "/usr/bin/python3.13 -m pipx --version", probe: true }]);
  });

  it("stops at the first failing step, still removing the throwaway environment", async () => {
    const { deps: d, removed } = deps(["/usr/bin/python3.13"], (cmd) => {
      if (cmd.startsWith("/usr/bin/python3.13 -c")) return PYTHON_313;
      if (cmd === "/usr/bin/python3.13 -m venv /tmp/boot/venv") {
        return { exitCode: 1, stdout: "The virtual environment was not created successfully because ensurepip is not available.\napt install python3.13-venv" };
      }
      return undefined;
    });
    const outcome = await installSaw(d);
    expect(outcome).toMatchObject({ kind: "failed", failedStep: "create-venv" });
    expect(removed).toEqual(["/tmp/boot"]);
  });

  it("fails when pipx reports success but saw is not where pipx puts programs", async () => {
    const { deps: d } = deps(["/usr/bin/python3.13", "/usr/bin/pipx"], (cmd) => {
      if (cmd.startsWith("/usr/bin/python3.13 -c")) return PYTHON_313;
      if (cmd.startsWith("/usr/bin/pipx")) return cmd.includes("environment") ? { stdout: "/elsewhere\n" } : {};
      return undefined;
    });
    expect(await installSaw(d)).toMatchObject({ kind: "failed", failedStep: "find-saw" });
  });

  it("reports a cancel as a cancel, not a failure", async () => {
    const { deps: d } = deps(["/usr/bin/python3.13", "/usr/bin/pipx"], (cmd) => {
      if (cmd.startsWith("/usr/bin/python3.13 -c")) return PYTHON_313;
      if (cmd === "/usr/bin/pipx --version") return {};
      return { cancelled: true, exitCode: null };
    });
    expect((await installSaw(d)).kind).toBe("cancelled");
  });
});

describe("diagnose", () => {
  type Failed = Extract<InstallResult, { kind: "failed" }>;
  const failed = (failedStep: Failed["failedStep"], output: string, tried: string[] = []): Failed => ({
    kind: "failed",
    failedStep,
    tried,
    steps: [{ name: failedStep, command: "x", exitCode: 1, output, ok: false, probe: false }],
  });
  const debian = { platform: "linux" as const, distro: ["ubuntu", "debian"] };

  it("reads the distribution from os-release", () => {
    expect(parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n')).toEqual(["ubuntu", "debian"]);
  });

  it("gives the package-manager command for a missing Python", () => {
    const d = diagnose(failed("find-python", ""), { platform: "darwin", distro: [] }, PINS);
    expect(d.cause).toMatch(/not installed/);
    expect(d.fix).toContain("brew install python pipx");
  });

  it("says when the only Python is too old", () => {
    const d = diagnose(failed("find-python", "", ["/usr/bin/python3: Python 3.9 at /usr/bin/python3"]), debian, PINS);
    expect(d.cause).toMatch(/older than 3\.11/);
    expect(d.fix).toContain("sudo apt install python3 python3-venv pipx");
  });

  it("names a missing venv module on Debian and Ubuntu", () => {
    const d = diagnose(failed("create-venv", "ensurepip is not available"), debian, PINS);
    expect(d.cause).toMatch(/virtual environments/);
    expect(d.fix).toContain("python3-venv");
  });

  it("tells a network failure apart from a package failure", () => {
    const d = diagnose(failed("install-saw", "Failed to establish a new connection: [Errno -3] Temporary failure in name resolution"), debian, PINS);
    expect(d.cause).toMatch(/PyPI could not be reached/);
  });

  it("offers the manual command when no wheel fits this Python", () => {
    const d = diagnose(failed("install-saw", "ERROR: No matching distribution found for aiohttp"), debian, PINS);
    expect(d.fix).toContain("pipx install stayawakebot==0.12.3");
  });

  it("falls back to pipx's last line of output", () => {
    const d = diagnose(failed("install-saw", "noise\nFatal error from pip prevented installation."), debian, PINS);
    expect(d.cause).toBe("Installing saw stopped while installing saw with pipx: Fatal error from pip prevented installation.");
  });
});
