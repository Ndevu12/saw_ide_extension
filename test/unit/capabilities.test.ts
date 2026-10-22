import { describe, expect, it } from "vitest";

import { FEATURES, NO_CAPABILITIES, probeCapabilities, readCapabilities, schemaProblem, supports } from "../../src/core/capabilities";
import { fakeSaw, onWindows } from "./helpers";

const capabilities = (features: string[], schemas: Record<string, unknown> = {}) =>
  readCapabilities(JSON.stringify({ version: "0.14.0", schema_versions: schemas, features, platform: "linux" }), 0);

describe("what the installed saw can do", () => {
  it("reads saw capabilities --json", () => {
    const caps = capabilities(["scan.json", "audit.json", "progress.jsonl"], { scan: 1, audit: 1, fix: "two" });
    expect([...caps.features]).toEqual(["scan.json", "audit.json", "progress.jsonl"]);
    expect(caps.schemas).toEqual({ scan: 1, audit: 1 });
  });

  it("has none from a saw without the command, or one that fails or prints something else", () => {
    expect(readCapabilities("", 2)).toBe(NO_CAPABILITIES);
    expect(readCapabilities("usage: saw [-h] ...", 0)).toBe(NO_CAPABILITIES);
    expect(readCapabilities("null", 0).features.size).toBe(0);
  });

  it.skipIf(onWindows)("asks saw without a shell, and has none when saw is not there", async () => {
    const caps = await probeCapabilities(fakeSaw({ stdout: JSON.stringify({ features: ["mcp"] }) }));
    expect(caps.features.has(FEATURES.mcp)).toBe(true);
    expect((await probeCapabilities("/nonexistent/saw")).features.size).toBe(0);
  });

  it("uses a feature only in a schema this extension reads", () => {
    expect(supports(capabilities(["audit.json"]), FEATURES.auditJson, "audit")).toBe(true);
    expect(supports(capabilities(["audit.json"], { audit: 1 }), FEATURES.auditJson, "audit")).toBe(true);
    expect(supports(capabilities(["audit.json"], { audit: 2 }), FEATURES.auditJson, "audit")).toBe(false);
    expect(supports(capabilities([]), FEATURES.auditJson, "audit")).toBe(false);
    expect(supports(NO_CAPABILITIES, FEATURES.mcp)).toBe(false);
  });

  it("says when a document is newer than this extension reads", () => {
    expect(schemaProblem("scan", {})).toBeUndefined();
    expect(schemaProblem("scan", { schema_version: 1 })).toBeUndefined();
    expect(schemaProblem("scan", { schema_version: 2 })).toMatch(/update the extension/);
    expect(schemaProblem("fix", { schema_version: 1 })).toBeUndefined();
    expect(schemaProblem("fix", { schema_version: 2 })).toMatch(/update the extension/);
    expect(schemaProblem("audit", { schema_version: "1" })).toMatch(/invalid/);
  });
});
