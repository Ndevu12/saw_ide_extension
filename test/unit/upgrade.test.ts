import { describe, expect, it } from "vitest";

import { behindNotice, behindPin, moveOrKeep } from "../../src/core/install/upgrade";

type Ready = { kind: "ready"; version: string; behind?: { pinned: string; cause: string } };
type Unavailable = { kind: "unavailable"; reason: string; message: string };

const ready = (version: string): Ready => ({ kind: "ready", version });
const failed: Unavailable = { kind: "unavailable", reason: "install-failed", message: "saw could not be installed. No package for Linux x86_64." };
const cancelled: Unavailable = { kind: "unavailable", reason: "install-cancelled", message: "Installing saw was cancelled." };
const gone: Unavailable = { kind: "unavailable", reason: "unrecognised", message: "saw did not answer." };

function steps(installed: Ready | Unavailable, kept: Ready | Unavailable) {
  const warnings: string[] = [];
  const failures: Array<{ reason: string; keeping: string | undefined }> = [];
  let keepCalls = 0;
  return {
    warnings,
    failures,
    keepCalls: () => keepCalls,
    steps: {
      failed: (moved: Unavailable, keeping: string | undefined) => failures.push({ reason: moved.reason, keeping }),
      install: () => Promise.resolve(installed),
      keep: () => {
        keepCalls += 1;
        return Promise.resolve(kept);
      },
      warn: (message: string) => warnings.push(message),
    },
  };
}

describe("moving saw up to the pinned release", () => {
  it("runs the pinned release when it installs", async () => {
    const run = steps(ready("0.17.0"), ready("0.16.0"));
    expect(await moveOrKeep("0.17.0", run.steps)).toEqual(ready("0.17.0"));
    expect(run.keepCalls()).toBe(0);
    expect(run.warnings).toEqual([]);
  });

  it("keeps the installed saw, marked as behind, when the install fails", async () => {
    const run = steps(failed, ready("0.16.0"));
    expect(await moveOrKeep("0.17.0", run.steps)).toEqual({ ...ready("0.16.0"), behind: { pinned: "0.17.0", cause: failed.message } });
    expect(run.warnings).toEqual([`saw 0.17.0 could not be installed, so saw 0.16.0 keeps running. ${failed.message}`]);
    expect(run.failures).toEqual([{ reason: "install-failed", keeping: "0.16.0" }]);
  });

  it("reports the failed install, and does not claim a saw keeps running, when none is left", async () => {
    const run = steps(failed, gone);
    expect(await moveOrKeep("0.17.0", run.steps)).toBe(failed);
    expect(run.warnings).toEqual([]);
    // The notification is told nothing keeps running, so it cannot say an older saw keeps scanning.
    expect(run.failures).toEqual([{ reason: "install-failed", keeping: undefined }]);
  });

  it("marks an older saw as behind when another window held the install", async () => {
    const run = steps(ready("0.16.0"), ready("0.16.0"));
    expect(await moveOrKeep("0.17.0", run.steps)).toEqual({ ...ready("0.16.0"), behind: { pinned: "0.17.0", cause: "saw 0.17.0 was not in place after the install." } });
    expect(run.failures).toEqual([]);
  });

  it("says the install was cancelled, not that it failed", async () => {
    const run = steps(cancelled, ready("0.16.0"));
    const found = await moveOrKeep("0.17.0", run.steps);
    expect(found).toEqual({ ...ready("0.16.0"), behind: { pinned: "0.17.0", cause: "Installing saw 0.17.0 was cancelled." } });
    expect(run.warnings).toEqual(["saw 0.17.0 was not installed, because installing it was cancelled, so saw 0.16.0 keeps running."]);
  });

  it("does not mark a saw at or past the pin as behind", () => {
    expect(behindPin(ready("0.17.0"), "0.17.0", "x")).toEqual(ready("0.17.0"));
    expect(behindPin(ready("0.18.1"), "0.17.0", "x")).toEqual(ready("0.18.1"));
    expect(behindPin(gone, "0.17.0", "x")).toBe(gone);
  });

  it("tells the status bar which saw runs, which it replaces, and what it may miss", () => {
    const notice = behindNotice("0.16.0", { pinned: "0.17.0", cause: "No package for Linux x86_64." });
    expect(notice).toContain("saw 0.16.0 is running instead of saw 0.17.0.");
    expect(notice).toContain("No package for Linux x86_64.");
    expect(notice).toContain("may still hold what saw 0.17.0 finds");
  });
});
