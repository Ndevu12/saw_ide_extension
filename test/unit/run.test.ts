import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { runProgram } from "../../src/core/run";
import { onWindows, tempDir } from "./helpers";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe.skipIf(onWindows)("running saw", () => {
  it("settles once the program exits, though a worker it left behind holds the output open", async () => {
    const dir = tempDir();
    const file = path.join(dir, "leaves-a-worker");
    const worker = path.join(dir, "worker.pid");
    writeFileSync(file, `#!/bin/sh\nsleep 60 &\necho $! > '${worker}'\necho done\nexit 0\n`);
    chmodSync(file, 0o755);
    const started = Date.now();
    const result = await runProgram(file, [], { timeoutMs: 30_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdout: "done\n" });
    process.kill(Number(readFileSync(worker, "utf8")), "SIGKILL");
  }, 20_000);

  it("stops the workers a timed-out program started, and settles even when one ignores SIGTERM", async () => {
    const dir = tempDir();
    const file = path.join(dir, "hangs");
    const worker = path.join(dir, "worker.pid");
    writeFileSync(file, `#!/bin/sh\nsh -c 'trap "" TERM; while :; do sleep 1; done' &\necho $! > '${worker}'\nwait\n`);
    chmodSync(file, 0o755);
    const started = Date.now();
    const result = await runProgram(file, [], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(worker, "utf8"));
    expect(await until(() => !alive(pid), 8_000)).toBe(true);
  }, 20_000);
});
