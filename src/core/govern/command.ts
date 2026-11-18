import * as path from "node:path";

// Which git and gh commands bring files in from somewhere else. The extension asks saw to check
// those before the open folder changes. A command that does not bring files in is left alone.

export type Tool = "git" | "gh";

const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);
/** checkout and switch options that take the next word. `-m` (merge) and `--recurse-submodules` take none. */
const OPTION_VALUE = new Set(["-b", "-B", "-c", "-C", "--orphan", "--conflict"]);
const UNDO = new Set(["--abort", "--quit"]);

export interface GitInvocation {
  /**
   * The work tree the command changes: `--work-tree`, else `-C`, else the working directory. With a
   * `--git-dir` and no work tree, git uses the working directory too. `GIT_WORK_TREE` counts when no flag does.
   */
  directory: string;
  /** The folder holding `--git-dir` (or `GIT_DIR`), when one is given: its objects and refs change too. */
  gitDirFolder?: string;
  subcommand: string;
  args: readonly string[];
  /** The options before the subcommand, as given, so an alias can be expanded in their place. */
  globals: readonly string[];
  /** `-c alias.<name>=<value>` pairs on this command line. */
  aliases: ReadonlyMap<string, string>;
}



/** The git subcommand and the directory it acts on, or undefined when the command line has none. */
export function parseGit(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): GitInvocation | undefined {
  let base = path.resolve(cwd);
  let gitDir = env["GIT_DIR"] || undefined;
  let workTree = env["GIT_WORK_TREE"] || undefined;
  const aliases = new Map<string, string>();
  const take = (name: string, value: string) => {
    if (name === "-C") {
      base = path.resolve(base, value);
    } else if (name === "--git-dir") {
      gitDir = value;
    } else if (name === "--work-tree") {
      workTree = value;
    } else if (name === "-c") {
      const alias = /^alias\.([^=]+)=(.*)$/s.exec(value);
      if (alias?.[1] !== undefined && alias[2] !== undefined) {
        aliases.set(alias[1].toLowerCase(), alias[2]);
      }
    }
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] ?? "";
    const attached = attachedOption(arg);
    if (attached) {
      take(attached.name, attached.value);
      index += 1;
      continue;
    }
    if (GIT_VALUE.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) {
        return undefined;
      }
      take(arg, value);
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    const directory = workTree ? path.resolve(base, workTree) : base;
    return {
      directory,
      ...(gitDir ? { gitDirFolder: gitDirFolder(path.resolve(base, gitDir)) } : {}),
      subcommand: arg,
      args: argv.slice(index + 1),
      globals: argv.slice(0, index),
      aliases,
    };
  }
  return undefined;
}

/** The folder a `--git-dir` belongs to: the parent of a `.git` folder, otherwise the folder itself. */
function gitDirFolder(gitDir: string): string {
  return path.basename(gitDir) === ".git" ? path.dirname(gitDir) : gitDir;
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
      // A fetch writes refs, not files, unless it may move the checked-out branch. What it brings is held when it is merged or checked out.
      return !args.includes("--dry-run") && (args.includes("--update-head-ok") || args.includes("-u"));
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

/** The words of `args` that are not options, skipping the value of each option in `takesValue`. */
export function positionals(args: readonly string[], takesValue: ReadonlySet<string> = OPTION_VALUE): string[] {
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      break;
    }
    if (arg.startsWith("-")) {
      // `-qb main`: in a cluster of short options, the last one may take the next word.
      const last = /^-[A-Za-z]{2,}$/.test(arg) ? `-${arg.slice(-1)}` : arg;
      if (takesValue.has(last) && !arg.includes("=")) {
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

/** Pairs that stop git from starting a program, before `core.hooksPath` and any silenced driver. */
const QUIET_BASE = ["core.fsmonitor=false", "diff.external="] as const;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CONFIG_FILES = 8;

function configKey(pair: string): string {
  const eq = pair.indexOf("=");
  return (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
}

const QUIET_EXACT = new Set<string>([...QUIET_BASE.map(configKey), "core.hookspath"]);

function quietPairs(hooksPath: string, silenced: readonly string[]): string[] {
  return [...QUIET_BASE, `core.hooksPath=${hooksPath}`, ...silenced];
}

function dropsConfig(key: string, silenced: readonly string[]): boolean {
  const normal = key.toLowerCase();
  if (QUIET_EXACT.has(normal)) {
    return true;
  }
  return silenced.some((item) => configKey(item) === normal);
}

/**
 * Git arguments that keep a repository's config from starting a program. `core.fsmonitor`,
 * `diff.external`, and `core.hooksPath` are set after any copy of those keys on the command,
 * so the repository's value does not win. `silenced` is `key=` pairs for filter and diff
 * drivers read out of the repository's config.
 */
export function quietGit(argv: readonly string[], hooksPath: string, silenced: readonly string[] = []): string[] {
  const prefix: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] ?? "";
    const attached = attachedOption(arg);
    if (attached) {
      if (attached.name === "-c" && dropsConfig(configKey(attached.value), silenced)) {
        index += 1;
        continue;
      }
      prefix.push(arg);
      index += 1;
      continue;
    }
    if (GIT_VALUE.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) {
        break;
      }
      if (arg === "-c" && dropsConfig(configKey(value), silenced)) {
        index += 2;
        continue;
      }
      prefix.push(arg, value);
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      prefix.push(arg);
      index += 1;
      continue;
    }
    break;
  }
  const injected = quietPairs(hooksPath, silenced).flatMap((item) => ["-c", item]);
  return [...prefix, ...injected, ...argv.slice(index)];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** A filter or diff command saw can leave in place. Anything else is a program the repository named. */
function keepsCommand(value: string): boolean {
  const token = unquote(value).split(/\s+/)[0] ?? "";
  return token === "git-lfs";
}

interface ConfigEntry {
  section: string;
  subsection: string;
  key: string;
  value: string;
}

/** One config file as entries. Comments are skipped. Nothing here is executed. */
function configEntries(text: string): ConfigEntry[] {
  let section = "";
  let subsection = "";
  const entries: ConfigEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const header = /^\[([A-Za-z0-9-]+)(?:\s+"([^"]*)")?\]/.exec(line);
    if (header) {
      section = (header[1] ?? "").toLowerCase();
      subsection = header[2] ?? "";
      continue;
    }
    const pair = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
    if (!pair) {
      continue;
    }
    entries.push({ section, subsection, key: (pair[1] ?? "").toLowerCase(), value: pair[2] ?? "" });
  }
  return entries;
}

/**
 * `key=` overrides for filter and diff drivers in one config file whose commands are not
 * `git-lfs`. A kept driver is left to run. A silenced filter is not required, so git does not
 * stop when its command is cleared.
 */
export function silencedRepoConfig(text: string): string[] {
  const hostile = new Set<string>();
  for (const { section, subsection, key, value } of configEntries(text)) {
    if (!subsection || (section !== "filter" && section !== "diff")) {
      continue;
    }
    const command = section === "filter" ? key === "clean" || key === "smudge" || key === "process" : key === "command" || key === "textconv";
    if (command && !keepsCommand(value) && !subsection.includes("=") && !/\s/.test(subsection)) {
      hostile.add(`${section}.${subsection}`);
    }
  }
  const out: string[] = [];
  for (const name of hostile) {
    if (name.startsWith("filter.")) {
      out.push(`${name}.clean=`, `${name}.smudge=`, `${name}.process=`, `${name}.required=false`);
    } else {
      out.push(`${name}.command=`, `${name}.textconv=`);
    }
  }
  return out;
}

function includePaths(text: string, directory: string): string[] {
  const found: string[] = [];
  for (const entry of configEntries(text)) {
    if ((entry.section !== "include" && entry.section !== "includeif") || entry.key !== "path") {
      continue;
    }
    const target = unquote(entry.value);
    if (!target) {
      continue;
    }
    found.push(path.isAbsolute(target) ? target : path.resolve(directory, target));
  }
  return found;
}

/**
 * The repository's config, followed as data. `.git` may be a file that names the git dir.
 * Includes are read too, up to a few files. Nothing here is executed.
 */
export function repoConfigText(repo: string, read: (file: string) => string | undefined): string {
  const dot = path.join(repo, ".git");
  const pointer = read(dot);
  let git = dot;
  const named = pointer ? /^gitdir:\s*(.+)$/m.exec(pointer) : null;
  if (named?.[1]) {
    const target = named[1].trim();
    git = path.isAbsolute(target) ? target : path.resolve(repo, target);
  }
  const seen = new Set<string>();
  const chunks: string[] = [];
  const queue = [path.join(git, "config"), path.join(git, "config.worktree")];
  while (queue.length > 0 && seen.size < MAX_CONFIG_FILES) {
    const file = path.resolve(queue.shift() ?? "");
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const text = read(file);
    if (text === undefined) {
      continue;
    }
    const body = text.length > MAX_CONFIG_BYTES ? text.slice(0, MAX_CONFIG_BYTES) : text;
    chunks.push(body);
    queue.push(...includePaths(body, path.dirname(file)));
  }
  return chunks.join("\n");
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
