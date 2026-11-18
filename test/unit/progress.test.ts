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

  it("say how much a target holds, and how far each phase has come", () => {
    expect(readEvent(event({ event: "plan", target: "~/Dev/app", files: 2536, bytes: 1, commits: 3, workers: 5, estimate_seconds: 13, budget_seconds: 60 }))).toEqual({ label: "app: 2,536 files", index: undefined, of: undefined, estimateSeconds: 13 });
    expect(readEvent(event({ event: "plan", target: "~/Dev/app" }))).toBeUndefined();
    expect(readEvent(event({ event: "progress", target: "~/Dev/app", phase: "repository", total: 6, done: 3 }))).toEqual({ label: "app: repository", index: 3, of: 6 });
    expect(readEvent(event({ event: "progress", target: "~/Dev/app", phase: "repository", total: 6 }))).toEqual({ label: "app: repository", index: undefined, of: 6 });
  });

  it("carry saw's estimate to the events after its plan, until it is done", () => {
    let now = 1_000_000;
    const seen: (string | null)[] = [];
    const lines = new ProgressLines((p) => seen.push(p && describeProgress(p, now)), () => undefined, () => now);
    lines.feed(`${event({ event: "step", label: "Discovering targets" })}\n`);
    lines.feed(`${event({ event: "plan", target: "~/app", files: 747, estimate_seconds: 13 })}\n`);
    now += 4000;
    lines.feed(`${event({ event: "progress", target: "~/app", phase: "repository", total: 6, done: 3 })}\n`);
    now += 20_000;
    lines.feed(`${event({ event: "progress", target: "~/app", phase: "repository", total: 6, done: 6 })}\n${event({ event: "done", exit: 0 })}\n`);
    expect(seen).toEqual(["Discovering targets", "app: 747 files, about 13s left", "app: repository (3/6), about 9s left", "app: repository (6/6)", null]);
  });

  it("are left out when quoting what saw said", () => {
    expect(withoutEvents(`${event({ event: "step", label: "x" })}\nerror: boom\n`)).toBe("error: boom\n");
  });
});
