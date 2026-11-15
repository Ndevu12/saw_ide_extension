import { parseGit, type GitInvocation } from "./command";
import { GIT_BUILTINS } from "./gitBuiltins";

// A git alias runs another git command under a new name. The stand-in expands it, so `git up` set
// to `pull` is checked as the pull it is.

/** How many aliases may lead to one another before the stand-in stops following them. */
const ALIAS_DEPTH = 5;

/** What the stand-in knows beyond the command line: the environment, and how to read an alias. */
export interface AliasContext {
  env?: NodeJS.ProcessEnv;
  /** The value of `alias.<name>` for a repository, read with the real git. */
  aliasOf?: (name: string, directory: string) => string | undefined;
}

/** Whether git may run this subcommand as an alias. It never does for a command it ships. */
export function mayBeAlias(subcommand: string): boolean {
  return !GIT_BUILTINS.has(subcommand);
}

/** Split an alias's value into words, honouring quotes the way git does for a non-shell alias. */
export function aliasWords(value: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | undefined;
  let started = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] ?? "";
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"' && i + 1 < value.length) {
        word += value[++i];
      } else {
        word += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < value.length) {
      word += value[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (started) {
    words.push(word);
  }
  return words;
}

/**
 * The command git will run once aliases are expanded, and its arguments. A shell alias (`!…`) is
 * left as it is: the git it starts comes back through the stand-in, and is checked there. Aliases
 * that lead to one another past ALIAS_DEPTH give undefined.
 */
export function expandAliases(args: readonly string[], cwd: string, context: AliasContext): { command: GitInvocation; args: readonly string[] } | undefined {
  let current = args;
  for (let depth = 0; depth <= ALIAS_DEPTH; depth += 1) {
    const command = parseGit(current, cwd, context.env);
    if (!command || !mayBeAlias(command.subcommand)) {
      return command ? { command, args: current } : undefined;
    }
    const value = command.aliases.get(command.subcommand.toLowerCase()) ?? context.aliasOf?.(command.subcommand, command.directory);
    if (!value || value.trimStart().startsWith("!")) {
      return { command, args: current };
    }
    current = [...command.globals, ...aliasWords(value), ...command.args];
  }
  return undefined;
}
