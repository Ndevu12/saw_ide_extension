import { describe, expect, it } from "vitest";

import { locate, movesToPin, probe, sameInstall, sawToRun, type LocateEnv } from "../../src/core/install/locate";
import { fakeSaw, onWindows } from "./helpers";

function env(executables: string[], overrides: Partial<LocateEnv> = {}): LocateEnv {
  return {
    platform: "linux",
    homedir: "/home/me",
    pathVariable: "/usr/bin:/bin",
    isExecutableFile: (file) => executables.includes(file),
    ...overrides,
  };
}

describe("locate", () => {
  it("uses the configured absolute path", () => {
    expect(locate("/opt/saw/bin/saw", env(["/opt/saw/bin/saw", "/usr/bin/saw"]), "/x/saw")).toEqual({
      kind: "found",
      candidates: [{ binary: "/opt/saw/bin/saw", from: "setting" }],
    });
  });

  it("refuses a relative configured path, which would resolve against the workspace", () => {
    expect(locate("./.venv/bin/saw", env([])).kind).toBe("invalid-setting");
  });

  it("refuses a configured path that cannot be run, without falling back silently", () => {
    expect(locate("/opt/saw", env(["/usr/bin/saw"])).kind).toBe("invalid-setting");
  });

  it("lists every saw found, PATH first, then known places, then the one it installed", () => {
    const all = ["/bin/saw", "/usr/bin/saw", "/home/me/.local/bin/saw", "/data/pipx/bin/saw"];
    expect(locate("", env(all), "/data/pipx/bin/saw")).toEqual({
      kind: "found",
      candidates: [
        { binary: "/usr/bin/saw", from: "path" },
        { binary: "/bin/saw", from: "path" },
        { binary: "/home/me/.local/bin/saw", from: "known-location" },
        { binary: "/data/pipx/bin/saw", from: "installed" },
      ],
    });
  });

  it("does not list the installed saw twice when it is also on PATH", () => {
    const result = locate("", env(["/usr/bin/saw"]), "/usr/bin/saw");
    expect(result).toEqual({ kind: "found", candidates: [{ binary: "/usr/bin/saw", from: "path" }] });
  });

  it("skips relative and empty PATH entries, which name the working directory", () => {
    const result = locate("", env(["saw", "./saw", "bin/saw"], { pathVariable: ".::bin:./" }));
    expect(result.kind).toBe("missing");
  });

  it("falls back to ~/.local/bin, where pipx and uv install it", () => {
    expect(locate("", env(["/home/me/.local/bin/saw"]))).toMatchObject({ candidates: [{ binary: "/home/me/.local/bin/saw", from: "known-location" }] });
  });

  it("on Windows, runs only saw.exe: a .cmd launcher needs a shell", () => {
    const win = env(["C:\\Tools\\saw.exe"], { platform: "win32", homedir: "C:\\Users\\me", pathVariable: "C:\\Tools;." });
    expect(locate("", win)).toMatchObject({ candidates: [{ binary: "C:\\Tools\\saw.exe" }] });
    expect(locate("C:\\Tools\\saw.cmd", win).kind).toBe("invalid-setting");
  });

  it("names every place it looked when saw is missing", () => {
    const result = locate("", env([]));
    expect(result).toEqual({ kind: "missing", searched: ["/usr/bin/saw", "/bin/saw", "/home/me/.local/bin/saw"] });
  });
});

describe("which saw runs", () => {
  it("treats a symlink and its target as the saw this extension installed", () => {
    const canonical = (file: string) => (file === "/usr/bin/saw" || file === "/home/me/.local/bin/saw" ? "/data/saw" : file);
    expect(sameInstall("/usr/bin/saw", "/home/me/.local/bin/saw", canonical)).toBe(true);
    expect(sameInstall("/opt/saw", "/home/me/.local/bin/saw", canonical)).toBe(false);
    expect(sameInstall("/opt/saw", undefined, canonical)).toBe(false);
  });

  it("moves the extension's saw up to the pin, and leaves anyone else's where it is", () => {
    expect(movesToPin("", true, true, [0, 15, 0], "0.16.0")).toBe(true);
    expect(movesToPin("", true, true, [0, 16, 0], "0.16.0")).toBe(false);
    expect(movesToPin("", true, false, [0, 15, 0], "0.16.0")).toBe(false);
    expect(movesToPin("/opt/saw", true, true, [0, 15, 0], "0.16.0")).toBe(false);
    expect(movesToPin("", false, true, [0, 15, 0], "0.16.0")).toBe(false);
  });

  it("runs a saw that meets the pin ahead of an older one earlier on PATH", () => {
    const older = { version: [0, 15, 0] as const, binary: "/usr/bin/saw" };
    const pinned = { version: [0, 16, 0] as const, binary: "/home/me/.local/bin/saw" };
    expect(sawToRun([older, pinned], "0.16.0")).toBe(pinned);
    expect(sawToRun([pinned, older], "0.16.0")).toBe(pinned);
    expect(sawToRun([older], "0.16.0")).toBe(older);
  });
});

describe.skipIf(onWindows)("probe", () => {
  it("accepts a saw new enough to read", async () => {
    const result = await probe(fakeSaw({ stdout: "saw (stayawakebot) 0.12.3\n" }));
    expect(result).toMatchObject({ kind: "ready", version: [0, 12, 3] });
  });

  it("rejects one older than the contract it needs", async () => {
    expect((await probe(fakeSaw({ stdout: "saw (stayawakebot) 0.5.0\n" }))).kind).toBe("too-old");
  });

  it("rejects a program that is not saw", async () => {
    const result = await probe(fakeSaw({ stdout: "usage: saw [file]\n", exit: 64 }));
    expect(result).toMatchObject({ kind: "unrecognised" });
  });
});
