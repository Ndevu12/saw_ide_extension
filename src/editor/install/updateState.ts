import type * as vscode from "vscode";

import { atLeast, parseRelease } from "../../core/version";

const LAST_CHECK_KEY = "update.lastCheck";
const OFFERED_KEY = "update.offered";
const DECLINED_KEY = "update.declined";
const HIGHEST_KEY = "update.highest";

/** What the updater remembers across windows. */
export class UpdateState {
  constructor(private readonly memento: vscode.Memento) {}

  checkedWithin(ms: number, now: number): boolean {
    return now - (this.memento.get<number>(LAST_CHECK_KEY) ?? 0) < ms;
  }

  checked(now: number | undefined): Thenable<void> {
    return this.memento.update(LAST_CHECK_KEY, now);
  }

  /** True the first time `version` is offered. */
  async offerOnce(version: string): Promise<boolean> {
    if (this.memento.get<string>(OFFERED_KEY) === version) {
      return false;
    }
    await this.memento.update(OFFERED_KEY, version);
    return true;
  }

  /** The newest release this machine ran: updates never go below it. */
  get highest(): string | undefined {
    return this.memento.get<string>(HIGHEST_KEY);
  }

  get declined(): string[] {
    return this.memento.get<string[]>(DECLINED_KEY) ?? [];
  }

  async adopted(version: string): Promise<void> {
    const parsed = parseRelease(version);
    const highest = this.highest;
    if (parsed && (!highest || atLeast(parsed, highest))) {
      await this.memento.update(HIGHEST_KEY, version);
    }
    await this.memento.update(DECLINED_KEY, this.declined.filter((v) => v !== version));
  }

  decline(version: string): Thenable<void> {
    return this.memento.update(DECLINED_KEY, [...new Set([...this.declined, version])]);
  }
}
