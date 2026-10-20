// Runs saw.vsix in VS Code Server, the program Remote - SSH, WSL and Dev Containers start on the
// remote machine, inside a Debian container, with a headless browser as the window. Checks that the
// extension runs on the server side: it installs saw there, scans the server's folder, and keeps its
// report in the server's storage, and that Audit, the hook install and Fix, started from the window,
// act on the server. Needs Docker; installs-scans-and-acts-on-server needs PyPI.
// Usage: pnpm test:remote:vscode-server [name…]
// VSCODE_TEST_VERSION picks the server version (default: latest stable).
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

import { runScenarios } from "../scenarios.mjs";

const IMAGE = "saw-ext-remote-vscode-server:debian-12";
const DOCKERFILE = [
  "FROM debian:bookworm-slim",
  "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends " +
    "python3 python3-venv git ca-certificates chromium && rm -rf /var/lib/apt/lists/*",
  "RUN useradd -m dev",
  "USER dev",
  "WORKDIR /home/dev",
].join("\n");

const SCENARIOS = [
  {
    name: "installs-scans-and-acts-on-server",
    about: "a server with Python and network: saw is installed and scans on the server; Audit, the hook install and Fix, started from the window, act there",
    docker: ["-e", "SAW_REMOTE_ACTIONS=1"],
    expect: (r) =>
      r.verdict === "Infected" &&
      r.saw?.onServer === true &&
      r.saw.binary.startsWith("/home/dev/") &&
      r.report?.startsWith(".vscode-server/") &&
      r.evidenceInReport === false &&
      r.projectChanged === "" &&
      /project is INFECTED/.test(r.actions?.alert ?? "") &&
      ["No hazard found", "Do not change your passwords or tokens yet", "Not known to be safe"].includes(r.actions?.audit?.title) &&
      r.actions.hooks?.title === "In place" &&
      /^scan-on-clone: INSTALLED/.test(r.actions.hooks.sawSays) &&
      r.actions.fixConfirmed === true &&
      r.actions.fix?.title === "Clean-up prepared" &&
      r.actions.fix.branches.length > 1 &&
      r.actions.fix.rescanned === "clean" &&
      r.actions.fix.taskOnDisk === false,
  },
  {
    name: "no-network-never-clean",
    about: "a server without network: saw cannot be installed, and the folder is never reported clean",
    docker: ["--network", "none"],
    expect: (r) => r.installFailed === true && r.saw === null && r.verdict !== "Clean" && r.projectChanged === "",
  },
];

const root = path.resolve(import.meta.dirname, "../../..");
const version = process.env.VSCODE_TEST_VERSION ?? "latest";
const cache = path.join(process.env.VSCODE_TEST_CACHE ?? path.join(homedir(), ".cache", "saw-vscode-test"), `vscode-server-${version}`);
const server = path.join(cache, "vscode-server-linux-x64-web");
if (version === "latest" || !existsSync(server)) {
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  const tarball = path.join(cache, "vscode-server.tar.gz");
  // The download is large and is sometimes cut off part way.
  execFileSync("curl", ["-fsSL", "--retry", "5", "--retry-all-errors", "--retry-delay", "5", "-o", tarball, `https://update.code.visualstudio.com/${version}/server-linux-x64-web/stable`]);
  execFileSync("tar", ["xzf", tarball, "-C", cache]);
}

execFileSync("pnpm", ["run", "package"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
const work = mkdtempSync(path.join(tmpdir(), "saw-remote-vscode-server-"));
copyFileSync(path.join(root, "saw.vsix"), path.join(work, "saw.vsix"));
for (const file of ["check.mjs", "workbench.mjs"]) {
  copyFileSync(path.join(import.meta.dirname, file), path.join(work, file));
}
writeFileSync(path.join(work, "Dockerfile"), DOCKERFILE);
// The container's user need not be this one.
chmodSync(work, 0o755);
execFileSync("docker", ["build", "-q", "-t", IMAGE, "-f", path.join(work, "Dockerfile"), work], { stdio: ["ignore", "ignore", "inherit"] });

// The window after each step, kept for when a scenario fails.
const screenshotsRoot = process.env.SAW_REMOTE_SCREENSHOTS ?? path.join(work, "screenshots");
function screenshots(scenario) {
  const dir = path.join(screenshotsRoot, scenario.name);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o777);
  return dir;
}
console.log(`Screenshots: ${screenshotsRoot}`);

runScenarios(
  SCENARIOS,
  (scenario) => [
    "--shm-size=512m", ...scenario.docker, "-v", `${screenshots(scenario)}:/screenshots`,
    "-v", `${server}:/opt/vscode-server:ro`, "-v", `${work}:/check:ro`, IMAGE,
    // Node 20, in VS Code Server 1.96, has WebSocket only behind this flag.
    "/opt/vscode-server/node", "--experimental-websocket", "/check/check.mjs",
  ],
  `VS Code Server ${version}`,
);
