import { describe, expect, it } from "vitest";

import { plain } from "../../src/core/text";

describe("plain", () => {
  it("replaces bidirectional overrides that would disguise evidence", () => {
    const disguised = "access\u202E} \u2066if (isAdmin)\u2069 \u2066 begin admins only";
    expect(plain(disguised)).not.toMatch(/[\u202E\u2066-\u2069]/);
    expect(plain(disguised)).toContain("\uFFFD");
  });

  it("flattens to one line and drops control characters", () => {
    expect(plain("a\nb\tc\u0007d\u001b[31m")).toBe("a b c\uFFFDd\uFFFD[31m");
  });

  it("bounds the length", () => {
    expect(plain("x".repeat(500), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
