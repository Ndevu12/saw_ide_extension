import { describe, expect, it } from "vitest";

import { readCapabilities } from "../../src/core/capabilities";
import { mcpLaunch, sameLaunch } from "../../src/core/agent/mcp";

const sawWith = (...features: string[]) => readCapabilities(JSON.stringify({ features }), 0);

describe("saw's MCP server", () => {
  it("is offered only from a saw that has one, started as saw mcp from the saw in use", () => {
    expect(mcpLaunch("/home/me/.local/bin/saw", sawWith("scan.json"))).toBeUndefined();
    expect(mcpLaunch("/home/me/.local/bin/saw", sawWith("mcp"))).toEqual({ command: "/home/me/.local/bin/saw", args: ["mcp"] });
  });

  it("is registered again only when how it starts changes", () => {
    const launch = mcpLaunch("/usr/bin/saw", sawWith("mcp"));
    expect(sameLaunch(launch, mcpLaunch("/usr/bin/saw", sawWith("mcp", "audit.json")))).toBe(true);
    expect(sameLaunch(launch, mcpLaunch("/opt/saw", sawWith("mcp")))).toBe(false);
    expect(sameLaunch(launch, undefined)).toBe(false);
    expect(sameLaunch(undefined, undefined)).toBe(true);
  });
});
