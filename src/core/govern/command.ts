import * as path from "node:path";

// Which git and gh commands bring files in from somewhere else. The extension asks saw to check
// those before the open folder changes. A command that does not bring files in is left alone.

export type Tool = "git" | "gh";

const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);
const OPTION_VALUE = new Set(["-b", "-B", "-c", "-C", "-m", "--orphan", "--recurse-submodules", "--conflict"]);
const UNDO = new Set(["--abort", "--quit"]);

export interface GitInvocation {
  /** Absolute directory the command acts on. `-C` wins over the working directory. */
  directory: string;
  subcommand: string;
  args: readonly string[];
}

/** The git subcommand and the directory it acts on, or undefined when the command line has none. */
export function parseGit(argv: readonly string[], cwd: string): GitInvocation | undefined {
  let directory = path.resolve(cwd);
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] ?? "";
    const attached = attachedOption(arg);
    if (attached) {
      if (attached.name === "-C") {
        directory = path.resolve(cwd, attached.value);
      }
      index += 1;
      continue;
    }
    if (GIT_VALUE.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) {
        return undefined;
      }
      if (arg === "-C") {
        directory = path.resolve(cwd, value);
      }
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    return { directory, subcommand: arg, args: argv.slice(index + 1) };
  }
  return undefined;
}

function attachedOption(arg: string): { name: string; value: string } | undefined {
  if (arg.startsWith("-C") && arg.length > 2) {
    return { name: "-C", value: arg.slice(2) };
  }
  for (const name of ["--git-dir", "--work-tree", "--namespace", "--exec-path"]) {
    const prefix = `${name}=`;
    if (arg.startsWith(prefix)) {
      return { name, value: arg.slice(prefix.length) };
    }
  }
  return undefined;
}

/** Whether this git command brings files in from somewhere other than the open folder's current checkout. */
export function gitBringsFiles(command: GitInvocation): boolean {
  const { subcommand, args } = command;
  if (args.some((arg) => UNDO.has(arg))) {
    return false;
  }
  switch (subcommand) {
    case "pull":
    case "merge":
    case "rebase":
      return true;
    case "fetch":
      return !args.includes("--dry-run") && !args.includes("-n");
    case "submodule":
      return firstWord(args) === "update";
    case "checkout":
      return checkoutBrings(args);
    case "switch":
      return switchBrings(args);
    default:
      return false;
  }
}

function checkoutBrings(args: readonly string[]): boolean {
  if (args.includes("-b") || args.includes("--orphan")) {
    return false;
  }
  const dash = args.indexOf("--");
  const before = dash === -1 ? args : args.slice(0, dash);
  return positionals(before).length > 0;
}

function switchBrings(args: readonly string[]): boolean {
  if (args.includes("-c") || args.includes("--create") || args.includes("-C") || args.includes("--force-create") || args.includes("--orphan")) {
    return false;
  }
  return positionals(args).length > 0;
}

function firstWord(args: readonly string[]): string | undefined {
  return positionals(args)[0];
}

function positionals(args: readonly string[]): string[] {
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      break;
    }
    if (arg.startsWith("-")) {
      if (OPTION_VALUE.has(arg) && !arg.includes("=")) {
        index += 1;
      }
      continue;
    }
    words.push(arg);
  }
  return words;
}

/** Whether this gh command lands files in the repository it is aimed at. */
export function ghBringsFiles(argv: readonly string[]): boolean {
  const words = argv.filter((arg) => arg !== "--" && !arg.startsWith("-"));
  const group = words[0];
  const action = words[1];
  return (group === "pr" && action === "checkout")
    || (group === "repo" && action === "sync")
    || (group === "release" && action === "download")
    || (group === "run" && action === "download");
}

/** The open folder that contains `target`, the innermost when several do, or undefined when none do. */
export function enclosingFolder(folders: readonly string[], target: string): string | undefined {
  const resolved = path.resolve(target);
  return folders
    .map((folder) => path.resolve(folder))
    .filter((folder) => {
      const relative = path.relative(folder, resolved);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    })
    .sort((left, right) => right.length - left.length)[0];
}
