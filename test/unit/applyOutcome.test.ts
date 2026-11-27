import { describe, expect, it } from "vitest";

import { BUSY_RETRIES, CHECKS_AGAIN, nextStep, type ApplyRun } from "../../src/core/govern/applyOutcome";
import type { ApplyOutcome } from "../../src/core/govern/contract";

const run = (outcome: ApplyOutcome | undefined, over: Partial<ApplyRun> = {}): ApplyRun => ({
  reading: { applied: outcome === "brought_in", reason: outcome === "brought_in" ? undefined : "why", ...(outcome ? { outcome } : {}) },
  timedOut: false,
  spawnError: null,
  exact: true,
  busyRetries: 0,
  checksAgain: 0,
  ...over,
});

describe("the step after saw's apply", () => {
  it("follows each outcome saw names", () => {
    expect(nextStep(run("brought_in"))).toEqual({ kind: "brought-in" });
    expect(nextStep(run("not_brought_in"))).toEqual({ kind: "decide", reason: "why" });
    expect(nextStep(run("busy"))).toEqual({ kind: "retry", reason: "why" });
    expect(nextStep(run("state_changed"))).toEqual({ kind: "check-again", reason: "why" });
    expect(nextStep(run("holding_unusable"))).toEqual({ kind: "check-again", reason: "why" });
    expect(nextStep(run("folder_may_have_changed"))).toEqual({ kind: "check-folder", reason: "why" });
    expect(nextStep(run("held"))).toEqual({ kind: "unchanged", reason: "why" });
    expect(nextStep(run("nothing_to_apply"))).toEqual({ kind: "unchanged", reason: "why" });
  });

  it("stops retrying and checking again after their limits", () => {
    expect(nextStep(run("busy", { busyRetries: BUSY_RETRIES }))).toEqual({ kind: "unchanged", reason: "why" });
    expect(nextStep(run("state_changed", { checksAgain: CHECKS_AGAIN }))).toEqual({ kind: "unchanged", reason: "why" });
  });

  it("checks the folder when the apply timed out or its answer cannot be read", () => {
    expect(nextStep(run("brought_in", { timedOut: true }))).toMatchObject({ kind: "check-folder" });
    expect(nextStep(run(undefined))).toEqual({ kind: "check-folder", reason: "why" });
  });

  it("never asks, retries or checks again without an exact apply, and leaves a saw that did not start", () => {
    expect(nextStep(run("not_brought_in", { exact: false }))).toEqual({ kind: "unchanged", reason: "why" });
    expect(nextStep(run("busy", { exact: false }))).toEqual({ kind: "unchanged", reason: "why" });
    expect(nextStep(run("folder_may_have_changed", { exact: false }))).toEqual({ kind: "check-folder", reason: "why" });
    expect(nextStep(run(undefined, { spawnError: "ENOENT" }))).toEqual({ kind: "unchanged", reason: "saw could not be started: ENOENT" });
  });
});
