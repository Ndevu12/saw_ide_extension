import { describe, expect, it } from "vitest";

import { diagnose, lacksPackage, reportUrl, type Host } from "../../src/core/install/diagnose";
import type { InstallResult } from "../../src/core/install/install";
import { fits, machineName, pipWanted, readRelease, support, wheelPlatforms, type Release } from "../../src/core/install/platform";

// The files PyPI lists for two real releases: 0.17.0 was published with macOS wheels only.
const MAC_ONLY: Release = {
  kind: "files",
  wheels: ["stayawakebot-0.17.0-py3-none-macosx_11_0_arm64.whl", "stayawakebot-0.17.0-py3-none-macosx_11_0_x86_64.whl"],
  source: true,
};
const EVERY_DESKTOP: Release = {
  kind: "files",
  wheels: [
    "stayawakebot-0.16.0-py3-none-macosx_10_9_universal2.whl",
    "stayawakebot-0.16.0-py3-none-macosx_11_0_x86_64.whl",
    "stayawakebot-0.16.0-py3-none-manylinux_2_28_x86_64.whl",
    "stayawakebot-0.16.0-py3-none-win_amd64.whl",
  ],
  source: true,
};

const linux: Host = { platform: "linux", arch: "x64", glibc: "2.39", distro: ["arch"] };
const PIP_NO_017 =
  "ERROR: Could not find a version that satisfies the requirement stayawakebot==0.17.0 (from versions: 0.1.0, 0.15.0, 0.16.0)\nERROR: No matching distribution found for stayawakebot==0.17.0";

type Failed = Extract<InstallResult, { kind: "failed" }>;
const failed = (output: string, failedStep: Failed["failedStep"] = "install-saw"): Failed => ({
  kind: "failed",
  failedStep,
  tried: [],
  steps: [{ name: failedStep, command: "pipx install", exitCode: 1, output, ok: false, probe: false }],
});

describe("the machine a package must fit", () => {
  it("names the machine in a person's words", () => {
    expect(machineName(linux)).toBe("Linux x86_64");
    expect(machineName({ platform: "linux", arch: "arm64", musl: true })).toBe("Linux aarch64 with musl");
    expect(machineName({ platform: "darwin", arch: "arm64" })).toBe("macOS on Apple silicon");
    expect(machineName({ platform: "darwin", arch: "x64" })).toBe("macOS on Intel");
    expect(machineName({ platform: "win32", arch: "x64" })).toBe("Windows x64");
    expect(machineName({ platform: "win32", arch: "arm64" })).toBe("Windows on Arm");
    expect(machineName({ platform: "freebsd", arch: "x64" })).toBe("freebsd x64");
  });

  it("reads the platform tags from a wheel's name, including a compressed set", () => {
    expect(wheelPlatforms("stayawakebot-0.17.0-py3-none-macosx_11_0_arm64.whl")).toEqual(["macosx_11_0_arm64"]);
    expect(wheelPlatforms("x-1.0-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl")).toEqual(["manylinux_2_17_x86_64", "manylinux2014_x86_64"]);
    expect(wheelPlatforms("not-a-wheel.tar.gz")).toEqual([]);
  });

  it("matches a wheel to the processor, the C library, and its version", () => {
    expect(fits("manylinux_2_28_x86_64", linux).fits).toBe(true);
    expect(fits("manylinux_2_28_aarch64", linux).fits).toBe(false);
    expect(fits("manylinux_2_28_x86_64", { ...linux, glibc: "2.17" })).toEqual({ fits: false, glibc: "2.28" });
    expect(fits("manylinux2014_x86_64", { ...linux, glibc: "2.17" }).fits).toBe(true);
    expect(fits("manylinux_2_28_x86_64", { platform: "linux", arch: "x64", musl: true }).fits).toBe(false);
    expect(fits("musllinux_1_2_x86_64", { platform: "linux", arch: "x64", musl: true }).fits).toBe(true);
    expect(fits("macosx_10_9_universal2", { platform: "darwin", arch: "arm64" }).fits).toBe(true);
    expect(fits("macosx_11_0_x86_64", { platform: "darwin", arch: "arm64" }).fits).toBe(false);
    expect(fits("win_amd64", { platform: "win32", arch: "arm64" }).fits).toBe(false);
    expect(fits("any", { platform: "freebsd", arch: "x64" }).fits).toBe(true);
  });

  it("finds no package of 0.17.0 for Linux or Windows, and names where it has one", () => {
    expect(support(MAC_ONLY, linux)).toEqual({ kind: "elsewhere", on: ["macOS on Apple silicon", "macOS on Intel"], source: true });
    expect(support(MAC_ONLY, { platform: "win32", arch: "x64" }).kind).toBe("elsewhere");
    expect(support(MAC_ONLY, { platform: "darwin", arch: "arm64" })).toEqual({ kind: "fits" });
  });

  it("finds 0.16.0 for every desktop machine it shipped for, and none for Arm Linux or Windows on Arm", () => {
    expect(support(EVERY_DESKTOP, linux)).toEqual({ kind: "fits" });
    expect(support(EVERY_DESKTOP, { platform: "darwin", arch: "arm64" })).toEqual({ kind: "fits" });
    expect(support(EVERY_DESKTOP, { platform: "win32", arch: "x64" })).toEqual({ kind: "fits" });
    expect(support(EVERY_DESKTOP, { platform: "linux", arch: "arm64", glibc: "2.39" }).kind).toBe("elsewhere");
    expect(support(EVERY_DESKTOP, { platform: "win32", arch: "arm64" }).kind).toBe("elsewhere");
  });

  it("says when the package needs a newer glibc than this Linux has", () => {
    expect(support(EVERY_DESKTOP, { ...linux, glibc: "2.17" })).toEqual({ kind: "old-glibc", needs: "2.28", has: "2.17" });
  });

  it("reads PyPI's file list, leaving out a yanked file", () => {
    const release = readRelease(JSON.stringify({
      urls: [
        { packagetype: "bdist_wheel", filename: "stayawakebot-0.17.0-py3-none-macosx_11_0_arm64.whl" },
        { packagetype: "bdist_wheel", filename: "stayawakebot-0.17.0-py3-none-win_amd64.whl", yanked: true },
        { packagetype: "sdist", filename: "stayawakebot-0.17.0.tar.gz" },
      ],
    }));
    expect(release).toEqual({ kind: "files", wheels: ["stayawakebot-0.17.0-py3-none-macosx_11_0_arm64.whl"], source: true });
    expect(readRelease("<html>")).toBeUndefined();
    expect(readRelease("{}")).toBeUndefined();
  });

  it("reads which releases pip could use here", () => {
    expect(pipWanted(PIP_NO_017)).toEqual({ name: "stayawakebot", versions: ["0.1.0", "0.15.0", "0.16.0"] });
    expect(pipWanted("Could not find a version that satisfies the requirement stayawakebot==0.17.0 (from versions: none)")).toEqual({ name: "stayawakebot", versions: [] });
    expect(pipWanted("Could not find a version that satisfies the requirement pydantic-core<3,>=2 (from versions: none)")?.name).toBe("pydantic-core");
    expect(pipWanted("Fatal error")).toBeUndefined();
  });
});

describe("telling the operator saw has no package for this machine", () => {
  const PINS = { saw: "0.17.0" };

  it("asks PyPI only when pip found no package, and not when the network failed", () => {
    expect(lacksPackage(failed(PIP_NO_017))).toBe(true);
    expect(lacksPackage(failed("Failed to establish a new connection. No matching distribution found for stayawakebot"))).toBe(false);
    expect(lacksPackage(failed("No matching distribution found for pipx==1.18.4", "bootstrap-pipx"))).toBe(false);
  });

  it("names this machine and the platforms the release does have, and reports it to saw", () => {
    const d = diagnose(failed(PIP_NO_017), linux, PINS, MAC_ONLY);
    expect(d.cause).toBe("stayawakebot 0.17.0 has no ready-built package for Linux x86_64, which this machine runs. It has one for macOS on Apple silicon and macOS on Intel.");
    expect(d.fix).toContain("pipx install stayawakebot==0.17.0");
    expect(d.unsupported).toBe(true);
    expect(d.report?.where).toBe("saw");
    expect(d.report?.title).toBe("stayawakebot 0.17.0 has no ready-built package for Linux x86_64");
  });

  it("offers only the report when the release has no source package to build", () => {
    const d = diagnose(failed(PIP_NO_017), linux, PINS, { ...MAC_ONLY, source: false });
    expect(d.fix).toBe("Report it so saw publishes one.");
  });

  it("reports a pinned release that is not on PyPI to the extension", () => {
    const d = diagnose(failed(PIP_NO_017), linux, PINS, { kind: "unpublished" });
    expect(d.cause).toBe("stayawakebot 0.17.0, the release this extension installs, is not on PyPI.");
    expect(d.report?.where).toBe("extension");
    expect(d.unsupported).toBe(true);
  });

  it("names the glibc the package needs", () => {
    const d = diagnose(failed(PIP_NO_017), { ...linux, glibc: "2.17" }, PINS, EVERY_DESKTOP);
    expect(d.cause).toBe("stayawakebot 0.17.0 for Linux x86_64 needs glibc 2.28 or later, and this machine has glibc 2.17.");
    expect(d.fix).toMatch(/^Update the operating system/);
  });

  it("names a dependency that has no package for this machine", () => {
    const d = diagnose(failed("ERROR: Could not find a version that satisfies the requirement pydantic-core<3 (from versions: none)"), { platform: "linux", arch: "riscv64", glibc: "2.39", distro: [] }, PINS);
    expect(d.cause).toBe("pydantic-core, which stayawakebot 0.17.0 needs, has no ready-built package for Linux riscv64.");
    expect(d.report?.where).toBe("saw");
  });

  it("uses pip's own list when PyPI did not answer", () => {
    const d = diagnose(failed(PIP_NO_017), linux, PINS);
    expect(d.cause).toBe("pip found stayawakebot up to 0.16.0 for Linux x86_64, but not 0.17.0. Either 0.17.0 has no ready-built package for this machine, or the package index pip uses does not have it yet.");
    expect(d.unsupported).toBe(true);
    const none = diagnose(failed("Could not find a version that satisfies the requirement stayawakebot==0.17.0 (from versions: none)"), { platform: "win32", arch: "arm64", distro: [] }, PINS);
    expect(none.cause).toBe("pip found no stayawakebot release with a ready-built package for Windows on Arm.");
  });

  it("does not call a machine unsupported when the package fits and pip failed for another reason", () => {
    const d = diagnose(failed(PIP_NO_017), linux, PINS, EVERY_DESKTOP);
    expect(d.cause).toMatch(/has a ready-built package for Linux x86_64, but pip could not install it/);
    expect(d.unsupported).toBeUndefined();
    expect(d.report).toBeUndefined();
  });

  it("does not call a network failure unsupported", () => {
    const d = diagnose(failed("Failed to establish a new connection: Temporary failure in name resolution"), linux, PINS);
    expect(d.cause).toMatch(/PyPI could not be reached/);
    expect(d.unsupported).toBeUndefined();
  });

  it("fills in the issue with the machine and versions, and nothing from PATH or a folder", () => {
    const d = diagnose(failed(PIP_NO_017), linux, PINS, MAC_ONLY);
    const url = new URL(reportUrl(d, "ndevu12.stayawakebot 0.6.2") ?? "");
    expect(url.origin + url.pathname).toBe("https://github.com/Ndevu12/stayAwakeBot/issues/new");
    const body = url.searchParams.get("body") ?? "";
    expect(body).toContain("- Machine: Linux x86_64, glibc 2.39");
    expect(body).toContain("- On PyPI for: macOS on Apple silicon, macOS on Intel");
    expect(body).toContain("- Extension: ndevu12.stayawakebot 0.6.2");
    expect(body).not.toMatch(/PATH|\/home\//);
    expect(reportUrl(diagnose(failed("Fatal error"), linux, PINS), "x")).toBeUndefined();
  });
});
