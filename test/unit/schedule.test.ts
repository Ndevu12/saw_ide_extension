import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Scheduler } from "../../src/core/schedule";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("Scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses requests inside the debounce window into one run", async () => {
    const job = vi.fn(async () => undefined);
    const scheduler = new Scheduler(job, 1000);
    scheduler.request("a");
    scheduler.request("a");
    await vi.advanceTimersByTimeAsync(500);
    scheduler.request("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("runs once more after a run when a request arrived during it", async () => {
    const first = deferred();
    const job = vi.fn((_key: string, _signal: AbortSignal) => (job.mock.calls.length === 1 ? first.promise : Promise.resolve()));
    const scheduler = new Scheduler(job, 100);
    scheduler.request("a", { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    scheduler.request("a");
    scheduler.request("a");
    expect(job).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(job).toHaveBeenCalledTimes(2);
  });

  it("keeps keys independent", async () => {
    const job = vi.fn(async (_key: string, _signal: AbortSignal) => undefined);
    const scheduler = new Scheduler(job, 100);
    scheduler.request("a");
    scheduler.request("b");
    await vi.advanceTimersByTimeAsync(100);
    expect(job.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
  });

  it("aborts a run and drops its follow-up on cancel", async () => {
    const first = deferred();
    let seen: AbortSignal | undefined;
    const job = vi.fn((_key: string, signal: AbortSignal) => { seen = signal; return first.promise; });
    const scheduler = new Scheduler(job, 100);
    scheduler.request("a", { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    scheduler.request("a");
    scheduler.cancel("a");
    expect(seen?.aborted).toBe(true);
    first.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("keeps scheduling after a run fails", async () => {
    const job = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const scheduler = new Scheduler(job, 10);
    scheduler.request("a");
    await vi.advanceTimersByTimeAsync(10);
    scheduler.request("a");
    await vi.advanceTimersByTimeAsync(10);
    expect(job).toHaveBeenCalledTimes(2);
  });
});
