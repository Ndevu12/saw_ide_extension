// Installs and runs saw, through this extension's own installer, in the Linux images a remote window
// lands on: WSL's Ubuntu as it ships, with venv, with pipx, a dev-container Python image, and a
// Debian without Python. Needs Docker and network access to PyPI. Usage: pnpm test:linux [name…]
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import * as esbuild from "esbuild";

const NODE_IMAGE = "node:24-bookworm-slim";
const apt = (packages) =>
  `RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages} && rm -rf /var/lib/apt/lists/*`;

const SCENARIOS = [
  {
    name: "wsl-ubuntu-24.04",
    about: "Ubuntu 24.04 as WSL installs it: Python 3, no venv module, no pipx",
    base: "ubuntu:24.04",
    setup: apt("python3 ca-certificates"),
    expect: (r) => r.result === "failed" && r.step === "create-venv" && r.diagnosis.fix.includes("python3-venv"),
  },
  {
    name: "wsl-ubuntu-24.04-venv",
    about: "the same, with python3-venv: the extension installs pipx, then saw",
    base: "ubuntu:24.04",
    setup: apt("python3 python3-venv ca-certificates"),
    expect: (r) => r.result === "installed" && r.installedPipx === true && r.verdict === "infected",
  },
  {
    name: "ubuntu-24.04-pipx",
    about: "Ubuntu 24.04 with pipx from apt: saw is installed with it",
    base: "ubuntu:24.04",
    setup: apt("pipx ca-certificates"),
    expect: (r) => r.result === "installed" && r.installedPipx === false && r.verdict === "infected",
  },
  {
    name: "devcontainer-python-3.12",
    about: "python:3.12-slim, a common dev-container base",
    base: "python:3.12-slim-bookworm",
    setup: "",
    expect: (r) => r.result === "installed" && r.installedPipx === true && r.verdict === "infected",
  },
  {
    name: "debian-12-no-python",
    about: "Debian 12 slim without Python: no install, and the apt command to run",
    base: "debian:bookworm-slim",
    setup: apt("ca-certificates"),
    expect: (r) => r.result === "failed" && r.step === "find-python" && r.diagnosis.fix.includes("sudo apt install python3"),
  },
];

const root = path.resolve(import.meta.dirname, "../..");
const work = mkdtempSync(path.join(tmpdir(), "saw-linux-"));
await esbuild.build({
  entryPoints: [path.join(root, "test/linux/check.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: path.join(work, "check.cjs"),
  logLevel: "warning",
});
copyFileSync(path.join(root, "package.json"), path.join(work, "package.json"));
// The container's user need not be this one (Ubuntu images already hold uid 1000).
chmodSync(work, 0o755);

const wanted = process.argv.slice(2);
const chosen = SCENARIOS.filter((s) => !wanted.length || wanted.includes(s.name));
let failures = 0;
for (const scenario of chosen) {
  const tag = `saw-ext-linux:${scenario.name}`;
  const dockerfile = [
    `FROM ${NODE_IMAGE} AS node`,
    `FROM ${scenario.base}`,
    "COPY --from=node /usr/local/bin/node /usr/local/bin/node",
    scenario.setup,
    "RUN useradd -m dev",
    "USER dev",
    "WORKDIR /home/dev",
  ].join("\n");
  const context = mkdtempSync(path.join(work, "image-"));
  writeFileSync(path.join(context, "Dockerfile"), dockerfile);
  execFileSync("docker", ["build", "-q", "-t", tag, context], { stdio: ["ignore", "ignore", "inherit"] });
  const started = Date.now();
  const run = spawnSync("docker", ["run", "--rm", "-v", `${work}:/check:ro`, tag, "node", "/check/check.cjs", "/check/package.json"], {
    encoding: "utf8",
    timeout: 15 * 60_000,
  });
  const line = run.stdout.trim().split("\n").pop() ?? "";
  let report;
  try {
    report = JSON.parse(line);
  } catch {
    report = { result: "no-report", stdout: run.stdout.slice(-2000), stderr: run.stderr.slice(-2000) };
  }
  const ok = scenario.expect(report);
  failures += ok ? 0 : 1;
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`${ok ? "✔" : "✘"} ${scenario.name} (${seconds}s): ${scenario.about}`);
  console.log(`    ${JSON.stringify(report)}`);
}
process.exitCode = failures ? 1 : 0;
