import type { ApplyReading } from "./contract";

export const BUSY_RETRIES = 2;
export const CHECKS_AGAIN = 1;

export type ApplyStep =
  | { kind: "brought-in" }
  | { kind: "decide"; reason: string }
  | { kind: "retry"; reason: string }
  | { kind: "check-again"; reason: string }
  | { kind: "check-folder"; reason: string }
  | { kind: "unchanged"; reason: string };

export interface ApplyRun {
  reading: ApplyReading;
  timedOut: boolean;
  spawnError: string | null;
  exact: boolean;
  busyRetries: number;
  checksAgain: number;
}

export function nextStep(run: ApplyRun): ApplyStep {
  const { reading, timedOut, spawnError, exact } = run;
  if (reading.applied && !timedOut && !spawnError) {
    return { kind: "brought-in" };
  }
  if (timedOut) {
    return { kind: "check-folder", reason: "the update did not finish in time" };
  }
  const reason = spawnError ? `saw could not be started: ${spawnError}` : reading.reason ?? "saw did not update the folder";
  if (spawnError) {
    return { kind: "unchanged", reason };
  }
  if (reading.outcome === "folder_may_have_changed") {
    return { kind: "check-folder", reason };
  }
  if (!exact) {
    return { kind: "unchanged", reason };
  }
  switch (reading.outcome) {
    case "not_brought_in":
      return { kind: "decide", reason };
    case "busy":
      return run.busyRetries < BUSY_RETRIES ? { kind: "retry", reason } : { kind: "unchanged", reason };
    case "state_changed":
    case "holding_unusable":
      return run.checksAgain < CHECKS_AGAIN ? { kind: "check-again", reason } : { kind: "unchanged", reason };
    case undefined:
      return { kind: "check-folder", reason };
    default:
      return { kind: "unchanged", reason };
  }
}
