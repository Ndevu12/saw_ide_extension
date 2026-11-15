import * as path from "node:path";

import { positionals, type GitInvocation } from "./command";

// Where a clone lands. saw cannot hold a clone, which makes a folder that does not exist yet, so
// the stand-in lets one into an open folder run and has that folder scanned once it has.

/** `git clone` options that take the next word as their value. */
const CLONE_OPTION_VALUE: ReadonlySet<string> = new Set([
  "-b", "--branch", "-o", "--origin", "-c", "--config", "-u", "--upload-pack", "-j", "--jobs", "--depth", "--reference",
  "--reference-if-able", "--separate-git-dir", "--template", "--filter", "--shallow-since", "--shallow-exclude", "--server-option",
  "--bundle-uri", "--ref-format",
]);

/** Where `git clone` puts the new checkout: the folder named after the URL, or the one given. */
export function cloneTarget(command: GitInvocation): string | undefined {
  if (command.subcommand !== "clone") {
    return undefined;
  }
  const [source, into] = positionals(command.args, CLONE_OPTION_VALUE);
  if (!source) {
    return undefined;
  }
  const named = into ?? source.replace(/[\\/]+$/, "").replace(/[\\/]\.git$/, "").replace(/\.git$/, "").split(/[\\/:]/).pop();
  return named ? path.resolve(command.directory, named) : undefined;
}
