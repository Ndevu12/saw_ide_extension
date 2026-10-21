import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

import { defineConfig } from "@vscode/test-cli";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

// The infected workspace is generated per run so that this repository never stores one.
const workspace = mkdtempSync(path.join(tmpdir(), "saw-ext-it-"));
mkdirSync(path.join(workspace, ".vscode"));
writeFileSync(path.join(workspace, ".vscode", "tasks.json"), JSON.stringify({
  version: "2.0.0",
  tasks: [{ label: "x", type: "shell", command: "node .vscode/a.woff2", runOptions: { runOn: "folderOpen" } }],
}));
writeFileSync(path.join(workspace, ".vscode", "a.woff2"), "console.log(1)\n");
writeFileSync(path.join(workspace, "index.js"), "console.log('hello');\n");
// A repository, so `saw fix` has a history to prepare its branch on. No template: this machine's
// own git hooks stay out of it.
const git = (...args) => execFileSync("git", ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", ...args], { cwd: workspace });
git("init", "-q", "-b", "main");
git("add", "-A");
git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");

// SAW_IT_EDITOR runs the tests in another VS Code-based editor, such as Cursor, instead.
// The test editor is a third-party build; keeping it outside the repository keeps it out of
// every scan of this project, including the one this extension runs on itself.
const executable = process.env.SAW_IT_EDITOR || await downloadAndUnzipVSCode({
  version: process.env.VSCODE_TEST_VERSION ?? "1.96.0",
  cachePath: process.env.VSCODE_TEST_CACHE ?? path.join(homedir(), ".cache", "saw-vscode-test"),
});

// SAW_IT_INSTALL=1 starts the editor on a machine without saw: a sandboxed home and pipx folders,
// and a PATH without any saw, so the extension has to install it. The real pipx is untouched.
const env = {};
if (process.env.SAW_IT_INSTALL === "1") {
  const sandbox = mkdtempSync(path.join(tmpdir(), "saw-ext-install-"));
  const sawName = process.platform === "win32" ? "saw.exe" : "saw";
  Object.assign(env, {
    HOME: sandbox,
    USERPROFILE: sandbox,
    PIPX_HOME: path.join(sandbox, "pipx-home"),
    PIPX_BIN_DIR: path.join(sandbox, "bin"),
    PIPX_MAN_DIR: path.join(sandbox, "man"),
    SAW_IT_EXPECT_BIN_DIR: path.join(sandbox, "bin"),
    VIRTUAL_ENV: "",
    PATH: (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter((dir) => dir && !existsSync(path.join(dir, sawName)))
      .join(path.delimiter),
  });
}

export default defineConfig({
  files: "out/test/integration/**/*.test.js",
  useInstallation: { fromPath: executable },
  workspaceFolder: workspace,
  env,
  mocha: { ui: "tdd", timeout: 600_000 },
});
