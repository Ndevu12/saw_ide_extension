import { lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";

export const NO_HOOKS = "/dev/null";

export const EMPTY_HOOKS = "empty-hooks";

export function noHooksPath(platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === "win32" ? undefined : NO_HOOKS;
}

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
