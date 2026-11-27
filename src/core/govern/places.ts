import * as path from "node:path";

export interface ProgramFiles {
  isExecutableFile(file: string): boolean;
  realpath(file: string): string | undefined;
  list(dir: string): string[];
}

export const STANDIN_TOOLS = ["git", "gh"] as const;
export type StandinTool = (typeof STANDIN_TOOLS)[number];

const STANDIN = "saw-git-standin";

/** saw's git and gh stand-in for this saw, where saw itself looks: in its package, then beside saw. */
export function findStandin(saw: string, files: ProgramFiles): string | undefined {
  if (!saw) {
    return undefined;
  }
  const program = files.realpath(saw) ?? saw;
  const lib = path.join(path.dirname(path.dirname(program)), "lib");
  const packaged = files.list(lib)
    .filter((name) => /^python\d/.test(name))
    .map((name) => path.join(lib, name, "site-packages", "stayawake", "bots", "mcp", "bin", STANDIN));
  const beside = [path.join(path.dirname(program), STANDIN), path.join(path.dirname(saw), STANDIN)];
  return [...packaged, ...beside].find((file) => files.isExecutableFile(file));
}

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
