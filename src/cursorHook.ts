import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { decide, folderKey, folderOf, UNREADABLE, type GuardRecord, type HookAnswer, type HookInput } from "./core/agent/guard";

// Cursor's `beforeShellExecution` hook. Cursor starts it with the command on stdin as JSON; it
// answers on stdout from the records the extension keeps in the directory named by its argument.

function newest(store: string, folder: string): GuardRecord | undefined {
  const prefix = `${folderKey(folder)}-`;
  let found: GuardRecord | undefined;
  for (const name of readdirSync(store)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) {
      continue;
    }
    try {
      const record = JSON.parse(readFileSync(path.join(store, name), "utf8")) as GuardRecord;
      if (typeof record.updatedAt === "number" && typeof record.report === "string" && (!found || record.updatedAt > found.updatedAt)) {
        found = record;
      }
    } catch {
      // A record being replaced, or one this version cannot read; another window's may answer.
    }
  }
  return found;
}

function answer(raw: string, store: string): HookAnswer {
  try {
    const input = JSON.parse(raw) as HookInput;
    const folder = folderOf(input);
    return decide(input, folder ? newest(store, folder) : undefined);
  } catch {
    return UNREADABLE;
  }
}

const chunks: Buffer[] = [];
process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
process.stdin.on("end", () => {
  const store = process.argv[2];
  process.stdout.write(JSON.stringify(store ? answer(Buffer.concat(chunks).toString("utf8"), store) : UNREADABLE));
});
