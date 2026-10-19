import { describe, expect, it } from "vitest";

import { atLeast, parseVersion } from "../../src/core/version";

describe("parseVersion", () => {
  it("reads a release and a dev build", () => {
    expect(parseVersion("saw (stayawakebot) 0.12.3\n")).toEqual([0, 12, 3]);
    expect(parseVersion("saw (stayawakebot) 0.7.1.dev30+g74d2a87d")).toEqual([0, 7, 1]);
  });

  it("does not take another program's version for saw's", () => {
    expect(parseVersion("saw 2.0.0")).toBeNull();
    expect(parseVersion("Python 3.12.1")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("atLeast", () => {
  it("compares each part numerically", () => {
    expect(atLeast([0, 12, 3], "0.7.0")).toBe(true);
    expect(atLeast([0, 7, 0], "0.7.0")).toBe(true);
    expect(atLeast([0, 6, 99], "0.7.0")).toBe(false);
    expect(atLeast([1, 0, 0], "0.7.0")).toBe(true);
  });
});
