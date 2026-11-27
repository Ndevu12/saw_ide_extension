/** How long saw has after its own deadline to write its report before it is stopped. */
export const DEADLINE_GRACE_MS = 15_000;

/**
 * `--deadline` for a saw that takes it (`scan.deadline`), so saw stops itself in
 * time and reports the run as unfinished, and how long to wait before stopping saw from outside.
 */
export function withDeadline(timeoutMs: number, offered: boolean): { args: string[]; timeoutMs: number } {
  return offered
    ? { args: ["--deadline", String(Math.max(1, Math.ceil(timeoutMs / 1000)))], timeoutMs: timeoutMs + DEADLINE_GRACE_MS }
    : { args: [], timeoutMs };
}
