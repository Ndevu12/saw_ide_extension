// Runs inside the container (see run.mjs), with VS Code Server's own Node. Installs saw.vsix into
// the server, opens an infected folder from a headless browser, and waits until the extension, running
// in the server's extension host, has scanned it. With SAW_REMOTE_ACTIONS=1 it then runs Audit, the
// hook install and Fix from the window. Prints one JSON line.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import * as path from "node:path";

import { Workbench } from "./workbench.mjs";

const SERVER = "/opt/vscode-server/bin/code-server";
const DATA = path.join(homedir(), ".vscode-server");
const PROJECT = path.join(homedir(), "project");
const PORT = 8000;
const DEBUGGING_PORT = 9222;
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
    "--user-data-dir=/tmp/chromium", `--remote-debugging-port=${DEBUGGING_PORT}`,
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

const reportText = report && statSync(report).isFile() ? readFileSync(report, "utf8") : "";
const verdict = VERDICT.exec(reportText)?.[1] ?? null;
const projectChanged = git("status", "--porcelain", "--untracked-files=all").trim();

// The actions a person starts from the window, each judged by the report it leaves on the server.
// Audit and the hooks act on the machine saw runs on, so their reports are in global storage.
const globalReport = (kind) => path.join(DATA, "data", "User", "globalStorage", "ndevu12.saw", "reports", `${kind}.md`);
const fixReportOf = () => files(path.join(DATA, "data", "User", "workspaceStorage")).find((file) => path.basename(path.dirname(file)) === "fixes");

async function finished(find, done, timeoutMs = 240_000) {
  const until = Math.min(deadline, Date.now() + timeoutMs);
  while (Date.now() < until) {
    const file = find();
    const text = file && existsSync(file) ? readFileSync(file, "utf8") : "";
    if (done(text)) {
      return { report: path.relative(homedir(), file), title: /^## (.+)$/m.exec(text)?.[1] ?? null };
    }
    await sleep(1000);
  }
  return null;
}

/** The verdict of the first scan the log names after `marker`: Fix has the folder scanned again. */
async function verdictAfter(marker, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const text = readFileSync(logOf(), "utf8");
    const at = text.lastIndexOf(marker);
    const scanned = at >= 0 && /\] project: (\w+) \(/.exec(text.slice(at));
    if (scanned) {
      return scanned[1];
    }
    await sleep(500);
  }
  return null;
}

const sawBinary = () => /Using saw \S+ at (\S+) /.exec(readFileSync(logOf(), "utf8"))?.[1] ?? "saw";

let actions = null;
if (process.env.SAW_REMOTE_ACTIONS === "1" && verdict === "Infected") {
  // saw fix commits the clean-up on a branch, which needs a git identity.
  execFileSync("git", ["config", "--global", "user.name", "test"]);
  execFileSync("git", ["config", "--global", "user.email", "test@example.com"]);
  const workbench = await Workbench.connect(DEBUGGING_PORT);
  // Screenshots of the window after each step, for when an action does not happen.
  const shot = async (name) => writeFileSync(path.join("/screenshots", `${name}.png`), await workbench.screenshot());
  actions = {};
  try {
    await shot("0-scanned");
    // Older editors ask whether to trust the folder before anything else; the answer for an infected
    // folder is no. Then the window warns about it in saw's own dialog, as it does for a person.
    actions.alert = await workbench.dialog();
    if (actions.alert?.includes("Do you trust the authors")) {
      actions.trustDeclined = await workbench.click("No, I don't trust the authors");
      await sleep(1000);
      actions.alert = await workbench.dialog();
    }
    actions.alertDismissed = await workbench.click("Cancel");
    await workbench.run("saw: Audit This Machine");
    await shot("1-audit-started");
    actions.audit = await finished(() => globalReport("audit"), (t) => t.includes("## saw's report") && !t.includes("## Auditing now"));

    await shot("2-audit-finished");
    await workbench.run("saw: Install Scan-on-Clone Hooks");
    await shot("3-hooks-started");
    actions.hooks = await finished(() => globalReport("hooks"), (t) => t.includes("Last `saw hook install`") && !t.includes("running now"));
    // What saw itself says on the server, apart from what the extension shows.
    const sawSays = execFileSync(sawBinary(), ["hook", "status", "--no-stream"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    actions.hooks &&= { ...actions.hooks, sawSays: sawSays.split("\n").find((line) => line.startsWith("scan-on-clone:")) ?? null };

    await shot("4-hooks-finished");
    await workbench.run("saw: Fix Folder…");
    await shot("5-fix-asked");
    actions.fixConfirmed = await workbench.click("Fix");
    actions.fix = await finished(fixReportOf, (t) => t.includes("## saw's report") && !t.includes("## Fixing now"));
    actions.fix &&= {
      ...actions.fix,
      branches: git("branch", "--format=%(refname:short)").split("\n").filter(Boolean),
      rescanned: await verdictAfter("project: saw fix started."),
      taskOnDisk: existsSync(path.join(PROJECT, ".vscode", "tasks.json")),
    };
    await shot("6-fix-finished");
  } catch (error) {
    actions.error = error instanceof Error ? error.message : String(error);
  } finally {
    actions.messages = await workbench.visibleMessages();
    workbench.close();
  }
}
for (const child of children) {
  child.kill();
}

const logText = log ? readFileSync(log, "utf8") : "";
const sawPath = /Using saw \S+ at (\S+) \(found via ([\w-]+)\)/.exec(logText);
console.log(JSON.stringify({
  verdict,
  saw: sawPath ? { binary: sawPath[1], foundVia: sawPath[2], onServer: existsSync(sawPath[1]) } : null,
  installFailed: logText.includes(INSTALL_FAILED),
  report: report ? path.relative(homedir(), report) : null,
  evidenceInReport: reportText.includes("a.woff2"),
  projectChanged,
  actions,
  log: logText.split("\n").filter(Boolean).slice(-15),
}));
process.exit(0);
