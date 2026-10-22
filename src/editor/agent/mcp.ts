import * as vscode from "vscode";

import { mcpLaunch, MCP_SERVER_NAME, sameLaunch, type McpLaunch } from "../../core/agent/mcp";
import type { Model } from "../model";
import type { Settings } from "../settings";

export const MCP_PROVIDER_ID = "saw.mcp";

/** Cursor's extension API for MCP servers; absent from VS Code and its types. */
interface CursorMcp {
  registerServer(config: { name: string; server: { command: string; args: string[]; env: Record<string, string> } }): void;
  unregisterServer(name: string): void;
}

/** VS Code's MCP provider API (1.101 and later), which the 1.96 types this extension builds against lack. */
interface VsCodeMcp {
  registerMcpServerDefinitionProvider(
    id: string,
    provider: { onDidChangeMcpServerDefinitions: vscode.Event<void>; provideMcpServerDefinitions(): unknown[] },
  ): vscode.Disposable;
  McpStdioServerDefinition: new (label: string, command: string, args: string[], env?: Record<string, string>, version?: string) => unknown;
}

function cursorMcp(): CursorMcp | undefined {
  const api = (vscode as unknown as { cursor?: { mcp?: Partial<CursorMcp> } }).cursor?.mcp;
  return typeof api?.registerServer === "function" && typeof api.unregisterServer === "function" ? (api as CursorMcp) : undefined;
}

function vscodeMcp(): VsCodeMcp | undefined {
  const lm = (vscode as unknown as { lm?: Partial<VsCodeMcp> }).lm;
  const definition = (vscode as unknown as Partial<VsCodeMcp>).McpStdioServerDefinition;
  return typeof lm?.registerMcpServerDefinitionProvider === "function" && typeof definition === "function"
    ? { registerMcpServerDefinitionProvider: lm.registerMcpServerDefinitionProvider.bind(lm), McpStdioServerDefinition: definition }
    : undefined;
}

/**
 * Tells the editor how to start `saw mcp` while the saw in use has it, so agents can ask saw
 * directly. Cursor gets it through its own API, VS Code through an MCP server definition provider.
 */
export class SawMcpRegistration implements vscode.Disposable {
  private launch: McpLaunch | undefined;
  private version: string | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [this.changed];
  private readonly cursor = cursorMcp();

  constructor(
    private readonly model: Model,
    private readonly settings: () => Settings,
    private readonly log: vscode.LogOutputChannel,
  ) {
    const vscodeApi = this.cursor ? undefined : vscodeMcp();
    if (vscodeApi) {
      this.subscriptions.push(
        vscodeApi.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
          onDidChangeMcpServerDefinitions: this.changed.event,
          provideMcpServerDefinitions: () =>
            this.launch ? [new vscodeApi.McpStdioServerDefinition("saw", this.launch.command, this.launch.args, {}, this.version)] : [],
        }),
      );
    }
    if (this.cursor || vscodeApi) {
      this.subscriptions.push(model.onDidChange(() => this.update()));
      this.update();
    }
  }

  private wanted(): McpLaunch | undefined {
    const engine = this.model.engine;
    if (!this.settings().registerMcpServer || engine?.kind !== "ready") {
      return undefined;
    }
    // Where Cursor would start the server in a remote window is not documented, so not there.
    if (this.cursor && vscode.env.remoteName) {
      return undefined;
    }
    return mcpLaunch(engine.binary, engine.capabilities);
  }

  private update(): void {
    const next = this.wanted();
    if (sameLaunch(next, this.launch)) {
      return;
    }
    const engine = this.model.engine;
    this.version = engine?.kind === "ready" ? engine.version : undefined;
    if (this.cursor) {
      if (this.launch) {
        this.unregisterFromCursor();
      }
      if (next) {
        try {
          this.cursor.registerServer({ name: MCP_SERVER_NAME, server: { command: next.command, args: next.args, env: {} } });
        } catch (error) {
          this.log.warn(`Could not register saw's MCP server with Cursor: ${String(error)}`);
          this.launch = undefined;
          return;
        }
      }
    }
    this.launch = next;
    this.changed.fire();
    this.log.info(next ? `saw's MCP server is available to agents: ${next.command} ${next.args.join(" ")}.` : "saw's MCP server is not offered to agents.");
  }

  private unregisterFromCursor(): void {
    try {
      this.cursor?.unregisterServer(MCP_SERVER_NAME);
    } catch (error) {
      this.log.warn(`Could not unregister saw's MCP server from Cursor: ${String(error)}`);
    }
  }

  dispose(): void {
    if (this.launch) {
      this.unregisterFromCursor();
      this.launch = undefined;
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
