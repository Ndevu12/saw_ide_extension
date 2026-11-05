import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AUTOMATIC_TASKS, configOutsideFolders, isBoolean, isNumber, needsStrict, owned, PROJECT_GIT, SAW_KEYS, STRICT_SETTINGS, timeoutMs } from "../../src/core/controls";

describe("owned settings", () => {
  it("uses the machine value and never a workspace value", () => {
    expect(owned({ globalValue: false, defaultValue: true }, true, isBoolean)).toBe(false);
    expect(owned({ defaultValue: true }, true, isBoolean)).toBe(true);
    expect(owned(undefined, true, isBoolean)).toBe(true);
    expect(owned({ globalValue: "no" as unknown as boolean }, true, isBoolean)).toBe(true);
  });

  it("drops a config that sits inside an open folder", () => {
    expect(configOutsideFolders("  /home/me/saw.yml  ", ["/work/app"])).toBe("/home/me/saw.yml");
    expect(configOutsideFolders("/work/app/.saw.yml", ["/work/app"])).toBe("");
    expect(configOutsideFolders("/work/app/nested/saw.yml", ["/work/app"])).toBe("");
    expect(configOutsideFolders("", ["/work/app"])).toBe("");
  });

  it("floors the scan budget at five seconds", () => {
    expect(timeoutMs(120)).toBe(120_000);
    expect(timeoutMs(1)).toBe(5_000);
    expect(timeoutMs("120")).toBe(120_000);
    expect(isNumber(Number.NaN)).toBe(false);
  });

  it("names every saw setting, and the IDE settings a suspicious folder puts back", () => {
    const properties = Object.keys((JSON.parse(readFileSync("package.json", "utf8")) as { contributes: { configuration: { properties: Record<string, unknown> } } }).contributes.configuration.properties);
    expect(properties.sort()).toEqual(SAW_KEYS.map((key) => `saw.${key}`).sort());
    expect(PROJECT_GIT).toBe("git.path");
    expect(STRICT_SETTINGS).toEqual([
      { key: "security.workspace.trust.untrustedFiles", value: "newWindow" },
      { key: "extensions.ignoreRecommendations", value: true },
      { key: "task.autoDetect", value: "off" },
    ]);
    expect(AUTOMATIC_TASKS).toBe("task.allowAutomaticTasks");
  });

  it("asks for strict settings when a folder is suspicious, infected, unheld, or holding an update", () => {
    expect(needsStrict([{ verdict: "clean", unheld: false, held: false }])).toBe(false);
    expect(needsStrict([{ verdict: "residue", unheld: false, held: false }])).toBe(false);
    expect(needsStrict([{ verdict: "incomplete", unheld: false, held: false }])).toBe(false);
    expect(needsStrict([{ verdict: "suspicious", unheld: false, held: false }])).toBe(true);
    expect(needsStrict([{ verdict: "infected", unheld: false, held: false }])).toBe(true);
    expect(needsStrict([{ unheld: true, held: false }])).toBe(true);
    expect(needsStrict([{ unheld: false, held: true }])).toBe(true);
  });
});
