import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import type { SawApi } from "../../src/extension";

async function until<T>(read: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

suite("saw extension", () => {
  let api: SawApi;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension<SawApi>("ndevu12.saw");
    assert.ok(extension, "the extension is installed in the test host");
    api = await extension.activate();
  });

  test("contributes its commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["saw.scanWorkspace", "saw.showOutput", "saw.install", "saw.copyDiagnostics"]) {
      assert.ok(commands.includes(id), id);
    }
  });

  test("installs saw with pipx when the machine has none, without asking", async function () {
    const expected = process.env["SAW_IT_EXPECT_BIN_DIR"];
    if (!expected) {
      this.skip();
    }
    const engine = await until(() => {
      const state = api.model.engine;
      return state && state.kind !== "installing" ? state : undefined;
    }, 540_000);
    assert.equal(engine.kind, "ready", JSON.stringify(engine));
    assert.ok(engine.binary.startsWith(expected), engine.binary);
  });

  test("shows the infected workspace as infected, with the finding on the task file", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const last = await until(() => api.model.get(folder).last, 540_000);
    assert.equal(last.verdict, "infected", JSON.stringify(last.reasons));

    const tasks = vscode.Uri.joinPath(folder.uri, ".vscode", "tasks.json");
    const diagnostics = vscode.languages.getDiagnostics(tasks);
    const confirmed = diagnostics.find((d) => d.code === "vscode-task-runs-font");
    assert.ok(confirmed, JSON.stringify(diagnostics));
    assert.equal(confirmed.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(confirmed.source, "saw");
  });

  test("tells an AI agent the folder is infected and to stop, without passing on evidence", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    assert.ok(vscode.lm.tools.some((tool) => tool.name === "saw_folderVerdict"), "the tool is registered");
    const result = await vscode.lm.invokeTool("saw_folderVerdict", { input: { folder: folder.name }, toolInvocationToken: undefined });
    const text = result.content.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : "")).join("");
    assert.match(text, /Verdict: INFECTED/, text);
    assert.match(text, /STOP\./, text);
    assert.match(text, /\.vscode\/tasks\.json/, text);
    assert.doesNotMatch(text, /a\.woff2/, "evidence from the folder is left out");
  });

  test("fixes the infected folder once the operator confirms, then scans it again", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const asked: string[] = [];
    const window = vscode.window as { showWarningMessage: (...args: unknown[]) => Thenable<unknown> };
    const original = window.showWarningMessage;
    window.showWarningMessage = (message: unknown, ...rest: unknown[]) => {
      if (typeof message === "string" && message.startsWith("Fix ")) {
        asked.push(message);
        return Promise.resolve("Fix");
      }
      return original.call(vscode.window, message, ...rest);
    };
    try {
      void vscode.commands.executeCommand("saw.fixFolder", folder);
      await until(() => (api.model.get(folder).fixing ? true : undefined), 30_000);
      const last = await until(() => {
        const state = api.model.get(folder);
        return !state.fixing && !state.scanning && state.last?.verdict !== "infected" ? state.last : undefined;
      }, 180_000).catch(() => {
        const state = api.model.get(folder);
        throw new Error(`still ${JSON.stringify({ fixing: state.fixing, scanning: state.scanning, verdict: state.last?.verdict, asked })}`);
      });
      assert.deepEqual(asked, [`Fix ${folder.name} with saw?`]);
      assert.notEqual(last?.verdict, "infected", JSON.stringify(last?.reasons));
      const tasks = vscode.Uri.joinPath(folder.uri, ".vscode", "tasks.json");
      await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(tasks)), "the confirmed task file is gone");
    } finally {
      window.showWarningMessage = original;
    }
  });

  test("audits this machine and keeps saw's verdict on changing credentials", async () => {
    const started = Date.now();
    void vscode.commands.executeCommand("saw.auditMachine");
    const audit = await until(() => {
      const last = api.model.machine.audit;
      return last && last.at >= started && !api.model.machine.auditing ? last : undefined;
    }, 540_000);
    assert.notEqual(audit.verdict, "failed", JSON.stringify(audit));
    assert.match(audit.sentence ?? "", /^Rotation safety:/);
  });

  test("shows this machine's scan-on-clone hooks", async () => {
    const hooks = await until(() => api.model.machine.hooks, 60_000);
    assert.notEqual(hooks.kind, "unknown", JSON.stringify(hooks));
  });
});
