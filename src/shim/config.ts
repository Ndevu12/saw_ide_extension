import { readFileSync } from "node:fs";

import type { GovernConfig } from "../core/govern/contract";
import { checkRealProgram, diskFiles } from "../core/govern/realProgram";
import type { Tool } from "../core/govern/command";

export function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export function commandArgs(): string[] {
  const index = process.argv.indexOf("--");
  return index === -1 ? [] : process.argv.slice(index + 1);
}

export function readConfig(file: string): GovernConfig | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as GovernConfig;
  } catch {
    return undefined;
  }
}

/**
 * The configuration with git and gh checked, so nothing below runs a stand-in. A recorded program
 * that would lead back here is replaced by the real one on PATH, or left empty so it is not run.
 * Only the tool being run is reported, so a git command does not talk about gh.
 */
export function withRealPrograms(config: GovernConfig, tool: Tool): GovernConfig {
  const search = { pathVariable: process.env["PATH"], platform: process.platform };
  const real = (recorded: string, name: Tool): string => {
    const check = checkRealProgram(recorded, name, config.standinDirs, search, diskFiles);
    if (name === tool && check.kind !== "ok" && check.recorded) {
      const problem = check.why === "gone" ? "is no longer there" : "would run saw's stand-in again";
      const instead = check.kind === "replaced" ? `so it runs ${check.program}` : "and no other was found";
      process.stderr.write(`saw: the recorded ${name}, ${check.recorded}, ${problem}, ${instead}. Reload the window so saw records ${name} again.\n`);
    }
    return check.kind === "missing" ? "" : check.program;
  };
  return { ...config, realGit: real(config.realGit, "git"), realGh: real(config.realGh, "gh") };
}
