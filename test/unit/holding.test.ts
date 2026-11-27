import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { freshHolding, insideRepository } from "../../src/shim/holding";

describe("the holding folder for a check", () => {
  const roots: string[] = [];
  const root = () => {
    const made = realpathSync(mkdtempSync(path.join(tmpdir(), "saw-holding-test-")));
    roots.push(made);
    return made;
  };

  afterEach(() => {
    for (const made of roots.splice(0)) {
      rmSync(made, { recursive: true, force: true });
    }
  });

  it("is new and empty for each check", () => {
    const base = root();
    const first = freshHolding(base);
    const second = freshHolding(base);
    expect(typeof first).toBe("string");
    expect(first).not.toBe(second);
    expect(readdirSync(first as string)).toEqual([]);
  });

  it("is refused inside a git repository, with the reason", () => {
    const repo = root();
    mkdirSync(path.join(repo, ".git"));
    const base = path.join(repo, "tmp");
    mkdirSync(base);
    expect(insideRepository(base)).toBe(repo);
    expect(freshHolding(base)).toEqual({ refused: expect.stringContaining(`inside the git repository ${repo}`) as string });
  });
});
