import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { freshHolding } from "../../src/shim/holding";

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

  it("is refused, with the reason, when no folder can be made there", () => {
    expect(freshHolding(path.join(root(), "missing"))).toEqual({ refused: expect.stringContaining("could not make a holding folder") as string });
  });
});
