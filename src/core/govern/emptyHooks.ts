import { lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";

// Git aimed at an open folder is given a core.hooksPath that holds no hook, so the folder's own
// hooks do not run. `git rev-parse --git-path hooks` reports that path, so a hook installer may
// try to write there: whatever is there would run for every governed command in every open folder.
//
// On Linux and macOS it is /dev/null: git finds no hook under it, and nothing can be created there.
// Windows has no such path, so there it is a folder the extension keeps empty.

/** The hooks path git is given where the platform offers one nothing can be added to. */
export const NO_HOOKS = "/dev/null";

/** The folder name of the hooks folder the extension keeps empty, under its storage, on Windows. */
export const EMPTY_HOOKS = "empty-hooks";

export function noHooksPath(platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === "win32" ? undefined : NO_HOOKS;
}

/**
 * Make `dir` a real, empty folder. Anything at the path that is not one (a link, a file) or a
 * folder holding anything is moved aside to `<dir>.found-<time>`, never followed or run.
 * Returns where it went, if anywhere. Any error other than the folder not existing is thrown.
 */
export function keepHooksFolderEmpty(dir: string, now: () => number = Date.now): string | undefined {
  let setAside: string | undefined;
  let found: ReturnType<typeof lstatSync> | undefined;
  try {
    found = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (found && (!found.isDirectory() || readdirSync(dir).length > 0)) {
    setAside = `${dir}.found-${now()}`;
    renameSync(dir, setAside);
  }
  mkdirSync(dir, { recursive: true });
  return setAside;
}
