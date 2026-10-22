import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { installSaw, type Pins } from "../../src/core/install";
import { defaultIsExecutableFile, probe } from "../../src/core/locate";
import { runProgram } from "../../src/core/run";
import { tempDir } from "./helpers";

// Installs saw from PyPI into a sandbox, so the machine's own pipx and saw are untouched.
// Slow and online, so only when asked for: SAW_INSTALL_E2E=1, with SAW_E2E_NO_PIPX=1 to force the pipx bootstrap.
// Not on Windows: the published pin still does not start there, so a real install cannot be checked.
const enabled = process.env["SAW_INSTALL_E2E"] === "1" && process.platform !== "win32";
const pins = (JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { saw: Pins }).saw;
const sandbox = enabled ? tempDir("saw-e2e-") : "";

describe.skipIf(!enabled)("installing the real saw", () => {
  const saved = { ...process.env };
  process.env["PIPX_HOME"] = path.join(sandbox, "pipx-home");
  process.env["PIPX_BIN_DIR"] = path.join(sandbox, "bin");
  process.env["PIPX_MAN_DIR"] = path.join(sandbox, "man");
  afterAll(() => {
    process.env = saved;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("installs the pinned release and it answers as saw", { timeout: 10 * 60_000 }, async () => {
    const noPipx = process.env["SAW_E2E_NO_PIPX"] === "1";
    // A machine without pipx: no pipx program anywhere the installer looks, Homebrew's included.
    const hidden = (file: string) => noPipx && path.basename(file) === "pipx" && !file.startsWith(sandbox);
    const outcome = await installSaw({
      env: {
        platform: process.platform,
        homedir: sandbox,
        pathVariable: process.env["PATH"],
        isExecutableFile: (file) => !hidden(file) && defaultIsExecutableFile(file),
      },
      run: noPipx
        ? (binary, args, options) => (args.join(" ").startsWith("-m pipx --version") ? runProgram(binary, ["-m", "no_such_pipx"], options) : runProgram(binary, args, options))
        : runProgram,
      makeTempDir: () => mkdtempSync(path.join(sandbox, "boot-")),
      removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
      pins,
    });
    if (outcome.kind !== "installed") {
      throw new Error(JSON.stringify(outcome, null, 2));
    }
    // macOS's temporary folder is reached through a symlink, which pipx resolves.
    expect(realpathSync(outcome.binary)).toBe(realpathSync(path.join(sandbox, "bin", "saw")));
    expect(outcome.installedPipx).toBe(noPipx);
    expect(await probe(outcome.binary)).toMatchObject({ kind: "ready", version: pins.saw.split(".").map(Number) });
  });
});
