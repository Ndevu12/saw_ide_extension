// Runs inside the container (see run.mjs), with the VS Code server's own Node. Installs saw.vsix into
// the server, opens an infected folder from a headless browser, and waits until the extension, running
// in the server's extension host, has scanned it. Prints one JSON line.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import * as path from "node:path";

const SERVER = "/opt/vscode-server/bin/code-server";
const DATA = path.join(homedir(), ".vscode-server");
const PROJECT = path.join(homedir(), "project");
const PORT = 8000;
const deadline = Date.now() + Number(process.env.SAW_REMOTE_WAIT_SECONDS ?? 600) * 1000;
const server = ["--server-data-dir", DATA, "--accept-server-license-terms", "--telemetry-level", "off"];

function files(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listening() {
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = connect(PORT, "127.0.0.1", () => resolve(socket.end() && true)).on("error", () => resolve(false));
    });
    if (open) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("the server never listened");
    }
    await sleep(250);
  }
}

// The same infected folder the integration tests use, made a repository so `git status` can tell
// whether anything was written into it.
mkdirSync(path.join(PROJECT, ".vscode"), { recursive: true });
writeFileSync(path.join(PROJECT, ".vscode", "tasks.json"), JSON.stringify({
  version: "2.0.0",
  tasks: [{ label: "x", type: "shell", command: "node .vscode/a.woff2", runOptions: { runOn: "folderOpen" } }],
}));
writeFileSync(path.join(PROJECT, ".vscode", "a.woff2"), "console.log(1)\n");
writeFileSync(path.join(PROJECT, "index.js"), "console.log('hello');\n");
const git = (...args) => execFileSync("git", ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", ...args], { cwd: PROJECT, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");

execFileSync(SERVER, [...server, "--install-extension", "/check/saw.vsix"], { stdio: "ignore" });
const children = [
  spawn(SERVER, [...server, "--host", "127.0.0.1", "--port", String(PORT), "--without-connection-token"], { stdio: "ignore" }),
];
await listening();
children.push(
  spawn("chromium", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
    "--user-data-dir=/tmp/chromium", "--remote-debugging-port=9222",
    `http://127.0.0.1:${PORT}/?folder=${encodeURIComponent(PROJECT)}`,
  ], { stdio: "ignore" }),
);

// The extension's log and its saved scan report are written on the server, in the server's data folder.
const logOf = () => files(path.join(DATA, "data", "logs")).find((file) => file.endsWith(path.join("ndevu12.saw", "saw.log")));
const reportOf = () => files(path.join(DATA, "data", "User", "workspaceStorage")).find((file) => file.endsWith("scan.md"));
const VERDICT = /^## (Clean|Residue|Suspicious|Not verified|Infected)$/m;

const INSTALL_FAILED = "saw could not be installed.";

let log;
let report;
let failedAt;
while (Date.now() < deadline) {
  log = logOf();
  report = reportOf();
  if (report && VERDICT.test(readFileSync(report, "utf8"))) {
    break;
  }
  // After a failed install, give whatever the extension does next a few seconds to show.
  failedAt ??= log && readFileSync(log, "utf8").includes(INSTALL_FAILED) ? Date.now() : undefined;
  if (failedAt && Date.now() - failedAt > 10_000) {
    break;
  }
  await sleep(1000);
}
for (const child of children) {
  child.kill();
}

const logText = log ? readFileSync(log, "utf8") : "";
const reportText = report && statSync(report).isFile() ? readFileSync(report, "utf8") : "";
const sawPath = /Using saw \S+ at (\S+) \(found via ([\w-]+)\)/.exec(logText);
console.log(JSON.stringify({
  verdict: VERDICT.exec(reportText)?.[1] ?? null,
  saw: sawPath ? { binary: sawPath[1], foundVia: sawPath[2], onServer: existsSync(sawPath[1]) } : null,
  installFailed: logText.includes(INSTALL_FAILED),
  report: report ? path.relative(homedir(), report) : null,
  evidenceInReport: reportText.includes("a.woff2"),
  projectChanged: git("status", "--porcelain", "--untracked-files=all").trim(),
  log: logText.split("\n").filter(Boolean).slice(-15),
}));
process.exit(0);
