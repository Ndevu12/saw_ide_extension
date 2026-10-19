import { describe, expect, it } from "vitest";

import { parsePayload } from "../../src/core/contract";
import { judge, strongest } from "../../src/core/verdict";
import { finding, report, target } from "./helpers";

const payload = (...results: Record<string, unknown>[]) => parsePayload(report(results));

describe("judge", () => {
  it("is clean only when every target is clean and saw exited clean", () => {
    expect(judge(payload(target()), 0)).toEqual({ verdict: "clean", reasons: [] });
  });

  it("takes suspicious from the report, since saw exits clean on it", () => {
    expect(judge(payload(target({ verdict: "suspicious", findings: [finding({ confidence: "heuristic" })] })), 0).verdict)
      .toBe("suspicious");
  });

  it("shows the strongest target in a folder of several", () => {
    const result = judge(payload(target({ verdict: "suspicious" }), target({ verdict: "infected" }), target()), 1);
    expect(result.verdict).toBe("infected");
  });

  it("never reads an errored target as clean", () => {
    const result = judge(payload(target({ error: "2 path(s) unreadable: a, b" })), 2);
    expect(result.verdict).toBe("incomplete");
    expect(result.reasons).toEqual(["/work/repo: 2 path(s) unreadable: a, b"]);
  });

  it("keeps infected above incomplete, and still says what was not scanned", () => {
    const result = judge(payload(target({ verdict: "infected" }), target({ target: "/work/b", error: "clone failed" })), 1);
    expect(result.verdict).toBe("infected");
    expect(result.reasons).toEqual(["/work/b: clone failed"]);
  });

  it("is incomplete when the report names no target", () => {
    expect(judge(payload(), 0).verdict).toBe("incomplete");
  });

  it("is incomplete when the status claims findings the report lacks", () => {
    expect(judge(payload(target()), 1).verdict).toBe("incomplete");
  });

  it("is incomplete on a status saw does not define", () => {
    for (const code of [3, 4, 137, null]) {
      expect(judge(payload(target()), code).verdict).toBe("incomplete");
    }
  });
});

describe("strongest", () => {
  it("orders clean < residue < suspicious < incomplete < infected", () => {
    expect(strongest("clean", "residue")).toBe("residue");
    expect(strongest("suspicious", "residue")).toBe("suspicious");
    expect(strongest("incomplete", "suspicious")).toBe("incomplete");
    expect(strongest("incomplete", "infected")).toBe("infected");
  });
});
