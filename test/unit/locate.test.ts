import { describe, expect, it } from "vitest";

import { locate, probe, type LocateEnv } from "../../src/core/install/locate";
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
