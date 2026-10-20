// Runs inside a Linux image (see run.mjs): installs saw as the extension would in a remote window
// opened on that machine, then scans an infected folder with it. Prints one JSON line.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

import { diagnose, parseOsRelease } from "../../../src/core/diagnose";
import { installSaw, type Pins } from "../../../src/core/install";
import { defaultIsExecutableFile, probe } from "../../../src/core/locate";
import { runProgram } from "../../../src/core/run";
import { scanFolder } from "../../../src/core/scan";

const DISGUISED_TASK = JSON.stringify({
  version: "2.0.0",
  tasks: [{ label: "x", type: "shell", command: "node .vscode/a.woff2", runOptions: { runOn: "folderOpen" } }],
});

async function main(): Promise<Record<string, unknown>> {
  const pins = JSON.parse(readFileSync(process.argv[2] ?? "package.json", "utf8")).saw as Pins;
  const outcome = await installSaw({
    env: { platform: process.platform, homedir: homedir(), pathVariable: process.env["PATH"], isExecutableFile: defaultIsExecutableFile },
    run: runProgram,
    makeTempDir: () => mkdtempSync(path.join(tmpdir(), "saw-pipx-")),
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    pins,
  });
  if (outcome.kind === "cancelled") {
    return { result: "cancelled" };
  }
  if (outcome.kind === "failed") {
    const host = { platform: process.platform, distro: parseOsRelease(readFileSync("/etc/os-release", "utf8")) };
    return { result: "failed", step: outcome.failedStep, diagnosis: diagnose(outcome, host, pins) };
  }
  const probed = await probe(outcome.binary);
  const folder = mkdtempSync(path.join(tmpdir(), "infected-"));
  mkdirSync(path.join(folder, ".vscode"));
  writeFileSync(path.join(folder, ".vscode", "tasks.json"), DISGUISED_TASK);
  writeFileSync(path.join(folder, ".vscode", "a.woff2"), "console.log(1)\n");
  const scanned = await scanFolder({ binary: outcome.binary, folder, configPath: "", timeoutMs: 120_000 });
  return {
    result: "installed",
    binary: outcome.binary,
    installedPipx: outcome.installedPipx,
    version: probed.kind === "ready" ? probed.version.join(".") : probed.kind,
    verdict: scanned.kind === "scanned" ? scanned.verdict : scanned.kind,
  };
}

main().then(
  (report) => console.log(JSON.stringify(report)),
  (error: unknown) => {
    console.log(JSON.stringify({ result: "crashed", error: String(error) }));
    process.exitCode = 1;
  },
);
