import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export function insideRepository(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function freshHolding(base: string = tmpdir()): string | { refused: string } {
  const repository = insideRepository(base);
  if (repository) {
    return { refused: `the system's temporary folder ${base} is inside the git repository ${repository}, and saw needs a holding folder outside every repository` };
  }
  const dir = mkdtempSync(path.join(base, "saw-hold-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
