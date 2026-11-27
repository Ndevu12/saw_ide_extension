import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import type { GovernConfig, GovernPhase } from "../core/govern/contract";
import { folderKey } from "../core/govern/plan";
import type { FolderVerdict } from "../core/scan/verdict";

export function notice(config: GovernConfig, repo: string, phase: GovernPhase, reasons: string[], verdict?: FolderVerdict, step?: string): void {
  const file = path.join(config.resultDir, `${folderKey(repo)}.json`);
  mkdirSync(config.resultDir, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({
    repo,
    phase,
    reasons,
    at: Date.now(),
    ...(verdict ? { verdict } : {}),
    ...(step ? { step } : {}),
  }));
  renameSync(`${file}.tmp`, file);
}
