import { describe, expect, it } from "vitest";

import { ContractError, parsePayload } from "../../src/core/scan/contract";
import { finding, report, target } from "./helpers";

describe("parsePayload", () => {
  it("reads targets, findings, advisories and notes", () => {
    const payload = parsePayload(report([
      target({
        verdict: "infected",
        findings: [finding({ line: 3 })],
        advisories: [finding({ signature_id: "vulnerable-dependency", confidence: "confirmed", advisory_only: true })],
        notes: ["Only the working tree was scanned;", 7],
      }),
    ]));
    const [result] = payload.results;
    expect(result?.verdict).toBe("infected");
    expect(result?.findings[0]).toMatchObject({ signatureId: "vscode-task-runs-font", line: 3, confidence: "confirmed" });
    expect(result?.advisories[0]?.advisoryOnly).toBe(true);
    expect(result?.informational).toEqual([]);
    expect(result?.notes).toEqual(["Only the working tree was scanned;"]);
  });

  it("ignores fields it does not know, so saw may add them", () => {
    const payload = parsePayload(report([target({ brand_new: { nested: true }, findings: [finding({ extra: 1 })] })]));
    expect(payload.results[0]?.findings).toHaveLength(1);
  });

  it("drops a line number that is not a positive integer", () => {
    for (const line of [0, -2, 1.5, "4"]) {
      const payload = parsePayload(report([target({ findings: [finding({ line })] })]));
      expect(payload.results[0]?.findings[0]?.line).toBeNull();
    }
  });

  it("refuses output that is not a report", () => {
    expect(() => parsePayload("")).toThrow(ContractError);
    expect(() => parsePayload("error: /x does not exist.")).toThrow(ContractError);
    expect(() => parsePayload("[]")).toThrow(ContractError);
  });

  it("reads a schema it knows, and refuses a newer one rather than misreading it", () => {
    const versioned = (schema_version: unknown) => JSON.stringify({ ...JSON.parse(report([target()])), schema_version });
    expect(parsePayload(versioned(1)).results).toHaveLength(1);
    expect(() => parsePayload(versioned(2))).toThrow(/update the extension/);
  });

  it("refuses a verdict, confidence or severity it does not know, rather than guessing", () => {
    expect(() => parsePayload(report([target({ verdict: "probably-fine" })]))).toThrow(/verdict/);
    expect(() => parsePayload(report([target({ findings: [finding({ confidence: "maybe" })] })]))).toThrow(/confidence/);
    expect(() => parsePayload(report([target({ findings: [finding({ severity: "urgent" })] })]))).toThrow(/severity/);
  });
});
