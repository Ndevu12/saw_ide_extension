import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export function freshHolding(base: string = tmpdir()): string | { refused: string } {
  let dir: string;
  try {
    dir = mkdtempSync(path.join(base, "saw-hold-"));
  } catch (error) {
    return { refused: `saw could not make a holding folder in ${base}: ${String(error)}` };
  }
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
