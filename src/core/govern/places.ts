import * as path from "node:path";

export interface ProgramFiles {
  isExecutableFile(file: string): boolean;
  realpath(file: string): string | undefined;
}

export const STANDIN_TOOLS = ["git", "gh"] as const;
export type StandinTool = (typeof STANDIN_TOOLS)[number];

/** Whether `name` is on PATH as a program other than the stand-in. */
export function realOnPath(name: StandinTool, pathVariable: string | undefined, standin: string, files: ProgramFiles): boolean {
  const own = files.realpath(standin) ?? standin;
  return (pathVariable ?? "").split(path.delimiter).some((dir) => {
    const file = path.join(dir, name);
    return path.isAbsolute(dir) && files.isExecutableFile(file) && (files.realpath(file) ?? file) !== own;
  });
}

/** The folder `saw govern install` puts ahead of git and gh. `$XDG_CONFIG_HOME`, otherwise `~/.config`. */
export function systemGovernBin(xdg: string | undefined, home: string): string {
  const base = xdg ? xdg : path.join(home, ".config");
  return path.join(base, "saw", "govern", "bin");
}

/** Where saw writes one check record per open folder. `$XDG_STATE_HOME`, otherwise `~/.local/state`. */
export function governStatusDir(xdgState: string | undefined, home: string): string {
  const trimmed = xdgState?.trim();
  const base = trimmed ? trimmed : path.join(home, ".local", "state");
  return path.join(base, "saw", "govern", "status");
}
