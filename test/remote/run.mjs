// Runs saw.vsix in the VS Code server, the program Remote - SSH, WSL and Dev Containers start on the
// remote machine, inside a Debian container, with a headless browser as the window. Checks that the
// extension runs on the server side: it installs saw there, scans the server's folder, and keeps its
// report in the server's storage. Needs Docker; the online scenario needs PyPI.
// Usage: pnpm test:remote [name…]; VSCODE_TEST_VERSION picks the server (default: latest stable).
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

const IMAGE = "saw-ext-remote:debian-12";
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
    name: "online",
    about: "a server with Python and network: the extension installs saw on the server and scans",
    network: [],
    expect: (r) =>
      r.verdict === "Infected" &&
      r.saw?.onServer === true &&
      r.saw.binary.startsWith("/home/dev/") &&
      r.report?.startsWith(".vscode-server/") &&
      r.evidenceInReport === false &&
      r.projectChanged === "",
  },
  {
    name: "offline",
    about: "a server without network: saw cannot be installed, and the folder is never reported clean",
    network: ["--network", "none"],
    expect: (r) => r.installFailed === true && r.saw === null && r.verdict !== "Clean" && r.projectChanged === "",
  },
];

const root = path.resolve(import.meta.dirname, "../..");
const version = process.env.VSCODE_TEST_VERSION ?? "latest";
const cache = path.join(process.env.VSCODE_TEST_CACHE ?? path.join(homedir(), ".cache", "saw-vscode-test"), `server-${version}`);
const server = path.join(cache, "vscode-server-linux-x64-web");
if (version === "latest" || !existsSync(server)) {
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  const tarball = path.join(cache, "server.tar.gz");
  execFileSync("curl", ["-fsSL", "-o", tarball, `https://update.code.visualstudio.com/${version}/server-linux-x64-web/stable`]);
  execFileSync("tar", ["xzf", tarball, "-C", cache]);
}

execFileSync("pnpm", ["run", "package"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
const work = mkdtempSync(path.join(tmpdir(), "saw-remote-"));
copyFileSync(path.join(root, "saw.vsix"), path.join(work, "saw.vsix"));
copyFileSync(path.join(import.meta.dirname, "check.mjs"), path.join(work, "check.mjs"));
writeFileSync(path.join(work, "Dockerfile"), DOCKERFILE);
// The container's user need not be this one.
chmodSync(work, 0o755);
execFileSync("docker", ["build", "-q", "-t", IMAGE, "-f", path.join(work, "Dockerfile"), work], { stdio: ["ignore", "ignore", "inherit"] });

const wanted = process.argv.slice(2);
let failures = 0;
for (const scenario of SCENARIOS.filter((s) => !wanted.length || wanted.includes(s.name))) {
  const started = Date.now();
  const run = spawnSync(
    "docker",
    ["run", "--rm", "--shm-size=512m", ...scenario.network, "-v", `${server}:/opt/vscode-server:ro`, "-v", `${work}:/check:ro`, IMAGE,
      "/opt/vscode-server/node", "/check/check.mjs"],
    { encoding: "utf8", timeout: 15 * 60_000 },
  );
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
  console.log(`${ok ? "✔" : "✘"} ${scenario.name} (${seconds}s, VS Code server ${version}): ${scenario.about}`);
  console.log(`    ${JSON.stringify(report)}`);
}
process.exitCode = failures ? 1 : 0;
