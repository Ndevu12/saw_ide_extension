import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { checkLock, chooseUpdate, lockUrl, readChannel, UPDATE_WAIT_MS, type Channel } from "../../src/core/install/channel";
import { CLEAN_SAMPLE, INFECTED_SAMPLE, installUpdate, type UpdateDeps } from "../../src/core/install/update";
import type { RunResult } from "../../src/core/run";

const LOCK = "aiohttp==3.14.5 \\\n    --hash=sha256:" + "a".repeat(64) + "\nstayawakebot==0.18.0 \\\n    --hash=sha256:" + "b".repeat(64) + "\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const DAY = 86_400_000;
const RELEASED = Date.parse("2026-11-20T10:00:00Z");

function channelText(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    releases: [{
      version: "0.18.0",
      released_at: "2026-11-20T10:00:00Z",
      security: false,
      min_extension: "0.7.1",
      lock: { path: "locks/0.18.0.txt", sha256: sha(LOCK) },
      provenance: true,
      notes_url: "https://github.com/Ndevu12/stayAwakeBot/releases/tag/v0.18.0",
      ...over,
    }],
    blocked: [],
    ...extra,
  });
}

const channel = (over?: Record<string, unknown>, extra?: Record<string, unknown>): Channel => {
  const read = readChannel(channelText(over, extra));
  if (!read) {
    throw new Error("the channel did not read");
  }
  return read;
};

function first(read: Channel) {
  const release = read.releases[0];
  if (!release) {
    throw new Error("the channel has no release");
  }
  return release;
}

const context = { current: [0, 17, 2] as const, extension: "0.7.1", now: RELEASED + DAY, declined: [] };

describe("the channel of approved saw releases", () => {
  it("reads only well-formed releases, with locks beside the channel", () => {
    expect(channel().releases).toHaveLength(1);
    expect(lockUrl(first(channel()))).toBe("https://raw.githubusercontent.com/Ndevu12/saw_ide_extension/main/channel/locks/0.18.0.txt");
    expect(readChannel(channelText({ lock: { path: "../../evil.txt", sha256: sha(LOCK) } }))?.releases).toEqual([]);
    expect(readChannel(channelText({ version: "latest" }))?.releases).toEqual([]);
    expect(readChannel(channelText({ notes_url: "https://attacker.example/" }))?.releases[0]?.notesUrl).toBe("https://github.com/Ndevu12/stayAwakeBot/releases/tag/v0.18.0");
    expect(readChannel(JSON.stringify({ schema_version: 2, releases: [] }))).toBeUndefined();
    expect(readChannel("not json")).toBeUndefined();
  });

  it("waits 3 days after the release, and offers it in the meantime", () => {
    expect(chooseUpdate(channel(), context)).toMatchObject({ kind: "waiting", dueAt: RELEASED + UPDATE_WAIT_MS });
    expect(chooseUpdate(channel(), { ...context, now: RELEASED + UPDATE_WAIT_MS })).toMatchObject({ kind: "due", why: "waited" });
  });

  it("skips the wait for a security release, or when the running saw is withdrawn", () => {
    expect(chooseUpdate(channel({ security: true }), context)).toMatchObject({ kind: "due", why: "security" });
    expect(chooseUpdate(channel({}, { blocked: ["0.17.2"] }), context)).toMatchObject({ kind: "due", why: "blocked" });
    expect(chooseUpdate(channel({ version: "0.17.2", lock: { path: "locks/0.17.2.txt", sha256: sha(LOCK) } }, { blocked: ["0.17.2"] }), context)).toEqual({ kind: "blocked-stuck" });
  });

  it("never moves back, to a blocked release, or past what this extension reads", () => {
    expect(chooseUpdate(channel(), { ...context, current: [0, 18, 0] })).toEqual({ kind: "none" });
    expect(chooseUpdate(channel(), { ...context, current: [0, 19, 0] })).toEqual({ kind: "none" });
    expect(chooseUpdate(channel({}, { blocked: ["0.18.0"] }), context)).toEqual({ kind: "none" });
    expect(chooseUpdate(channel({ min_extension: "0.8.0" }), context)).toEqual({ kind: "none" });
  });

  it("does not install a release the person went back from on its own", () => {
    const choice = chooseUpdate(channel({ security: true }), { ...context, declined: ["0.18.0"], now: RELEASED + 10 * DAY });
    expect(choice).toMatchObject({ kind: "waiting", dueAt: Number.POSITIVE_INFINITY });
  });

  it("takes a lock only when it is the one approved, for that release, with hashes", () => {
    const release = first(channel());
    expect(checkLock(LOCK, release)).toBe(LOCK);
    expect(checkLock(LOCK.replace("3.14.5", "3.14.6"), release)).toBeUndefined();
    const unhashed = "stayawakebot==0.18.0\n";
    expect(checkLock(unhashed, { ...release, lock: { ...release.lock, sha256: sha(unhashed) } })).toBeUndefined();
    const other = LOCK.replace("stayawakebot==0.18.0", "stayawakebot==0.18.1");
    expect(checkLock(other, { ...release, lock: { ...release.lock, sha256: sha(other) } })).toBeUndefined();
  });
});

describe("installing an approved release beside the running saw", () => {
  const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false, cancelled: false, overflowed: false, spawnError: null });

  function deps(over: Partial<UpdateDeps> & { says?: string; verdicts?: Record<string, string> } = {}) {
    const ran: string[][] = [];
    const removed: string[] = [];
    const written = new Map<string, string>();
    const samples: Record<string, string>[] = [];
    const made: UpdateDeps = {
      env: { platform: "linux", homedir: "/home/a", pathVariable: "/usr/bin", isExecutableFile: (file) => file === "/usr/bin/python3" },
      run: async (binary, args) => {
        ran.push([binary, ...args]);
        if (args.includes("-c")) {
          return ok("3 12\n/usr/bin/python3.12\n");
        }
        return args[0] === "--version" ? ok(over.says ?? "saw (stayawakebot) 0.18.0\n") : ok();
      },
      dir: "/store/saw/versions/0.18.0",
      version: "0.18.0",
      lock: LOCK,
      writeFile: (file, text) => written.set(file, text),
      removeDir: (dir) => removed.push(dir),
      sample: (files) => {
        samples.push(files);
        return `/tmp/sample-${samples.length}`;
      },
      scan: async (_binary, folder) => ((over.verdicts ?? { "/tmp/sample-1": "infected", "/tmp/sample-2": "clean" })[folder] as never),
      ...over,
    };
    return { made, ran, removed, written, samples };
  }

  it("installs only hash-pinned wheels from the approved lock, then checks the new saw", async () => {
    const { made, ran, written, samples } = deps();
    expect(await installUpdate(made)).toEqual({ kind: "installed", binary: "/store/saw/versions/0.18.0/bin/saw", dir: "/store/saw/versions/0.18.0" });
    expect(ran).toContainEqual(["/usr/bin/python3.12", "-m", "venv", "/store/saw/versions/0.18.0"]);
    expect(ran).toContainEqual(["/store/saw/versions/0.18.0/bin/python", "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--require-hashes", "--no-deps", "--only-binary=:all:", "-r", "/store/saw/versions/0.18.0/saw.lock.txt"]);
    expect(written.get("/store/saw/versions/0.18.0/saw.lock.txt")).toBe(LOCK);
    expect(samples).toEqual([INFECTED_SAMPLE, CLEAN_SAMPLE]);
  });

  it("removes what it installed when the new saw is not the approved release", async () => {
    const { made, removed } = deps({ says: "saw (stayawakebot) 0.17.9\n" });
    expect(await installUpdate(made)).toMatchObject({ kind: "failed", step: "check-version" });
    expect(removed).toContain("/store/saw/versions/0.18.0");
  });

  it("refuses a saw that misses the known infection, or calls a plain folder infected", async () => {
    for (const verdicts of [{ "/tmp/sample-1": "clean" }, { "/tmp/sample-1": "infected", "/tmp/sample-2": "infected" }]) {
      const { made, removed } = deps({ verdicts });
      expect(await installUpdate(made)).toMatchObject({ kind: "failed", step: "check-detection" });
      expect(removed).toContain("/store/saw/versions/0.18.0");
    }
  });

  it("says which step failed and what pip said", async () => {
    const { made } = deps();
    const run = made.run;
    made.run = async (binary, args, options) => args.includes("pip") ? { ...ok(), exitCode: 1, stderr: "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES" } : run(binary, args, options);
    expect(await installUpdate(made)).toEqual({ kind: "failed", step: "install", detail: "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES" });
  });
});
