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
});
