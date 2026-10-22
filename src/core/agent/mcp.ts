import { FEATURES, supports, type Capabilities } from "../capabilities";

// `saw mcp` (stayawakebot#1818): saw's own read-only MCP server over stdio, for AI agents in the
// editor. The extension only tells the editor how to start it; it never serves MCP itself.

export const MCP_SERVER_NAME = "saw";
export const MCP_ARGS = ["mcp"] as const;

export interface McpLaunch {
  command: string;
  args: string[];
}

/** How to start saw's MCP server, or undefined when this saw has none. */
export function mcpLaunch(binary: string, capabilities: Capabilities): McpLaunch | undefined {
  return supports(capabilities, FEATURES.mcp) ? { command: binary, args: [...MCP_ARGS] } : undefined;
}

export function sameLaunch(a: McpLaunch | undefined, b: McpLaunch | undefined): boolean {
  return a?.command === b?.command && a?.args.join("\0") === b?.args.join("\0");
}
