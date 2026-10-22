import { describe, expect, it } from "vitest";

import { readCapabilities } from "../../src/core/capabilities";
import { describeProgress, progressArgs, ProgressLines, readEvent, withoutEvents, type Progress } from "../../src/core/scan/progress";

const event = (e: Record<string, unknown>) => JSON.stringify(e);

describe("saw's progress events", () => {
  it("are asked for only from a saw that has them", () => {
    expect(progressArgs(readCapabilities(event({ features: [] }), 0))).toEqual([]);
    expect(progressArgs(readCapabilities(event({ features: ["progress.jsonl"] }), 0))).toEqual(["--progress=jsonl"]);
  });

  it("read a step, a target and the end", () => {
    expect(readEvent(event({ event: "step", id: "processes", label: "checking running processes", index: 3, of: 9 }))).toEqual({ label: "checking running processes", index: 3, of: 9 });
    expect(readEvent(event({ event: "target", path: "/work/monorepo/packages/web", index: 2, of: 12 }))).toEqual({ label: "web", index: 2, of: 12 });
    expect(readEvent(event({ event: "done", exit: 0 }))).toBeNull();
  });

  it("say nothing for an event this extension does not know, or one without a label", () => {
    expect(readEvent(event({ event: "start", command: "scan", steps: 9 }))).toBeUndefined();
    expect(readEvent(event({ event: "eta", seconds: 4 }))).toBeUndefined();
    expect(readEvent(event({ event: "step", index: 1, of: 2 }))).toBeUndefined();
    expect(readEvent("not json")).toBeUndefined();
  });

  it("flatten a label to one plain line, and keep a count only when it makes sense", () => {
    expect(readEvent(event({ event: "step", label: "a\nb\u001b[31m\u202e", index: -1, of: 1.5 }))).toEqual({ label: "a b\uFFFD[31m\uFFFD", index: undefined, of: undefined });
    const p = (index: number | undefined, of: number | undefined): Progress => ({ label: "packages", index, of });
    expect(describeProgress(p(3, 9))).toBe("packages (3/9)");
    expect(describeProgress(p(12, 9))).toBe("packages (9/9)");
    expect(describeProgress(p(undefined, 9))).toBe("packages");
    expect(describeProgress(p(0, 0))).toBe("packages");
  });

  it("are split from the rest of stderr as it arrives, across chunks and out of order", () => {
    const seen: (string | null)[] = [];
    let text = "";
    const lines = new ProgressLines(
      (p) => seen.push(p && describeProgress(p)),
      (t) => (text += t),
    );
    const step = (index: number) => event({ event: "step", label: "scanning", index, of: 3 });
    const stream = `${event({ event: "start", steps: 3 })}\n${step(2)}\n${step(1)}\nTraceback (most recent call last):\n{not json\n${event({ event: "later", x: 1 })}\n${event({ event: "done", exit: 0 })}`;
    for (let i = 0; i < stream.length; i += 7) {
      lines.feed(stream.slice(i, i + 7));
    }
    lines.end();
    expect(seen).toEqual(["scanning (2/3)", "scanning (1/3)", null]);
    expect(text).toBe("Traceback (most recent call last):\n{not json\n");
  });

  it("are left out when quoting what saw said", () => {
    expect(withoutEvents(`${event({ event: "step", label: "x" })}\nerror: boom\n`)).toBe("error: boom\n");
  });
});
