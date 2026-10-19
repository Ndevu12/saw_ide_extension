import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { scanArgs, scanFolder } from "../../src/core/scan";
import { fakeSaw, finding, onWindows, report, target, tempDir } from "./helpers";

const request = (binary: string, overrides = {}) => ({ binary, folder: "/work/repo", configPath: "", timeoutMs: 10_000, ...overrides });

describe("scanArgs", () => {
  it("asks for the JSON report on the whole folder, with the config only when one is set", () => {
    expect(scanArgs("/work/repo", "")).toEqual(["scan", "/work/repo", "--json", "--no-stream"]);
    expect(scanArgs("/work/repo", " /home/me/saw.yml ")).toEqual(["scan", "/work/repo", "--json", "--no-stream", "--config", "/home/me/saw.yml"]);
  });
});

describe.skipIf(onWindows)("scanFolder", () => {
  it("returns the verdict from the report", async () => {
    const binary = fakeSaw({ stdout: report([target({ verdict: "infected", findings: [finding()] })]), exit: 1 });
    const outcome = await scanFolder(request(binary));
    expect(outcome).toMatchObject({ kind: "scanned", verdict: "infected" });
  });

  it("passes the folder and config as separate arguments, never through a shell", async () => {
    const argsFile = path.join(tempDir(), "args.json");
    const binary = fakeSaw({ stdout: report([target()]), argsFile });
    await scanFolder(request(binary, { folder: "/work/a b; touch injected", configPath: "/home/me/$(id).yml" }));
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual(["scan", "/work/a b; touch injected", "--json", "--no-stream", "--config", "/home/me/$(id).yml"]);
  });

  it("is incomplete, and quotes saw, when nothing was printed", async () => {
    const binary = fakeSaw({ stderr: "error: /work/repo does not exist.\nNothing was scanned.\n", exit: 2 });
    const outcome = await scanFolder(request(binary));
    expect(outcome.kind).toBe("failed");
    expect(outcome).toMatchObject({ verdict: "incomplete" });
    expect(outcome.kind === "failed" && outcome.reasons[0]).toContain("Nothing was scanned.");
  });

  it("is incomplete when the scan runs past its time", async () => {
    const binary = fakeSaw({ stdout: report([target()]), sleepMs: 5_000 });
    const outcome = await scanFolder(request(binary, { timeoutMs: 300 }));
    expect(outcome).toMatchObject({ kind: "failed", verdict: "incomplete" });
    expect(outcome.kind === "failed" && outcome.reasons[0]).toMatch(/did not finish/);
  });

  it("is incomplete when the program cannot be started", async () => {
    const outcome = await scanFolder(request("/nonexistent/saw"));
    expect(outcome).toMatchObject({ kind: "failed", verdict: "incomplete" });
  });

  it("reports a cancelled scan as cancelled, not as a verdict", async () => {
    const binary = fakeSaw({ stdout: report([target()]), sleepMs: 5_000 });
    const controller = new AbortController();
    const pending = scanFolder(request(binary, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toEqual({ kind: "cancelled" });
  });
});
